import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { EYE_HEIGHT } from '@riftlane/shared'
import { FOG_COLOR, MaterialLibrary } from './materials'
import { buildSky } from './sky'
import { disposeObject3D } from './dispose'

// Halo Infinite ships 100-120; 75 read as a claustrophobic tunnel that made
// strafing targets hard to track and cut peripheral awareness at close range.
// THREE.PerspectiveCamera's fov is the VERTICAL field of view, not
// horizontal -- 90 vertical is ~121 horizontal at a 16:9 aspect (the top of
// Infinite's 78-120 slider, itself horizontal). Do not "fix" this back up:
// 105 vertical would be ~133 horizontal, well past Infinite's band, and it
// shrinks every target on screen.
const FOV_DEGREES = 90
const NEAR = 0.05
const FAR = 500
const FOG_NEAR = 34
const FOG_FAR = 260
// Was 1.15, then 1.55 to rescue a measured median scene luminance of 10/255
// (77% of pixels under 20/255). 1.55 fixed the crush by blowing the lit
// surfaces out instead: base platforms and rim trim clipped to near-white
// against near-black walls, which is the bimodal histogram that reads as
// "cheap" no matter how good the geometry is. The environment map added below
// is the real fix for the dark end, so this comes back down to keep the
// highlights inside range.
const EXPOSURE = 1.3
// Fill only. Above ~0.6 the neutral room bake starts flattening the dusk
// key/rim authoring into an evenly-lit studio look.
const ENV_INTENSITY = 0.45
const SHADOW_EXTENT = 46
const NARROW_VIEWPORT = 760

export interface RenderInfo {
  calls: number
  triangles: number
  lines: number
  points: number
  geometries: number
  textures: number
  programs: number
  drawWidth: number
  drawHeight: number
  pixelRatio: number
  shadowMapSize: number
  toneMappingExposure: number
}

declare global {
  interface Window {
    __riftlaneRenderInfo?: () => RenderInfo | null
  }
}

export interface SceneCtx {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  materials: MaterialLibrary
  /** Removes the resize listener and frees GPU resources. Does NOT remove
   * `renderer.domElement` from the DOM -- callers render into the existing
   * #game-canvas element, they don't own it. */
  dispose(): void
}

function shadowMapSize(): number {
  return window.innerWidth < NARROW_VIEWPORT ? 1024 : 2048
}

function pixelRatioCap(): number {
  return window.innerWidth < NARROW_VIEWPORT ? 1.75 : 2
}

/**
 * Builds the renderer/scene/camera trio for one match, plus everything that
 * is constant across every map: tone mapping, the key/fill/rim lighting
 * stack, distance fog and the sky backdrop. The camera is added to the
 * scene graph (not left detached) so objects parented to it -- game.ts's
 * viewmodel rig, effects.ts's death-fade overlay -- are actually traversed
 * and drawn by renderer.render(scene, camera).
 *
 * Map-specific lighting (the two team-coloured rim fills aimed down the
 * lane) is built by mapMesh.ts instead, since only it knows where the bases
 * are; those lights live inside the map group and are torn down with it.
 */
export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap()))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = EXPOSURE
  renderer.shadowMap.enabled = true
  // PCF, not PCFSoft: the soft variant costs a much wider shadow-map filter
  // kernel per lit fragment, and 60fps is a shipping requirement here. The
  // visible difference at this map's scale is slightly crisper shadow
  // edges, which is an acceptable trade for the frame time.
  renderer.shadowMap.type = THREE.PCFShadowMap

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR)

  // Environment map. Nearly every material in this game is a metal
  // (MaterialLibrary.hull is metalness 0.55, trim is 0.85) and none of them had
  // anything to reflect, which is what made lit surfaces read as flat plastic
  // and unlit ones fall to black -- the crushed-blacks measurement that pushed
  // EXPOSURE to 1.55 was a symptom of this, not of the lights being too dim.
  // A neutral PMREM bake gives metals an ambient response, so the mid-tones
  // come back without blowing the highlights out further.
  //
  // Cost: one bake at match start (a handful of ms), one cube texture. Nothing
  // per frame. Kept at a fraction of full intensity so the dusk key/rim
  // lighting still authors the mood -- this fills, it does not light.
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = envRT.texture
  scene.environmentIntensity = ENV_INTENSITY
  pmrem.dispose()

  const materials = new MaterialLibrary()
  const sky = buildSky(materials.glowTex)
  scene.add(sky)

  const camera = new THREE.PerspectiveCamera(FOV_DEGREES, window.innerWidth / window.innerHeight, NEAR, FAR)
  camera.rotation.order = 'YXZ'
  camera.position.set(0, EYE_HEIGHT, 0)
  scene.add(camera)

  // Ground color lightened from 0x2b2036 and intensity raised from 1.05 --
  // that dark ground tone set the luminance floor for anything not directly
  // sun-hit (shadowed soldier limbs, backdrop, cover), and it was reading
  // as near-black. See the EXPOSURE comment above for the measurement.
  const hemi = new THREE.HemisphereLight(0x8ea6f0, 0x453a5c, 1.35)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xffd9b4, 2.3)
  sun.position.set(38, 58, -30)
  sun.castShadow = true
  sun.shadow.mapSize.setScalar(shadowMapSize())
  sun.shadow.camera.left = -SHADOW_EXTENT
  sun.shadow.camera.right = SHADOW_EXTENT
  sun.shadow.camera.top = SHADOW_EXTENT
  sun.shadow.camera.bottom = -SHADOW_EXTENT
  sun.shadow.camera.near = 8
  sun.shadow.camera.far = 170
  sun.shadow.bias = -0.0009
  sun.shadow.normalBias = 0.035
  scene.add(sun)
  scene.add(sun.target)

  const bounce = new THREE.DirectionalLight(0x6f8fff, 1.1)
  bounce.position.set(-34, 20, 42)
  scene.add(bounce)

  function onResize(): void {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap()))
    renderer.setSize(window.innerWidth, window.innerHeight)
  }
  window.addEventListener('resize', onResize)

  const size = new THREE.Vector2()
  window.__riftlaneRenderInfo = () => {
    renderer.getDrawingBufferSize(size)
    return {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      lines: renderer.info.render.lines,
      points: renderer.info.render.points,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
      drawWidth: size.x,
      drawHeight: size.y,
      pixelRatio: renderer.getPixelRatio(),
      shadowMapSize: sun.shadow.mapSize.x,
      toneMappingExposure: renderer.toneMappingExposure,
    }
  }

  return {
    renderer,
    scene,
    camera,
    materials,
    dispose(): void {
      window.removeEventListener('resize', onResize)
      delete window.__riftlaneRenderInfo
      scene.remove(sky)
      disposeObject3D(sky)
      scene.environment = null
      envRT.dispose()
      materials.dispose()
      renderer.dispose()
    },
  }
}
