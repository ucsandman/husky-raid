import * as THREE from 'three'
import { EYE_HEIGHT } from '@riftlane/shared'

const FOV_DEGREES = 75
const NEAR = 0.05
const FAR = 500
const SKY_COLOR = 0x0a0d18
const FOG_NEAR = 20
const FOG_FAR = 90

export interface SceneCtx {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** Removes the resize listener and frees GPU resources. Does NOT remove
   * `renderer.domElement` from the DOM -- callers render into the existing
   * #game-canvas element, they don't own it. */
  dispose(): void
}

/**
 * Builds the renderer/scene/camera trio for one match. The camera is added
 * to the scene graph (not left detached) so objects parented to it --
 * game.ts's viewmodel rig, effects.ts's death-fade overlay -- are actually
 * traversed and drawn by renderer.render(scene, camera).
 */
export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(SKY_COLOR)
  scene.fog = new THREE.Fog(SKY_COLOR, FOG_NEAR, FOG_FAR)

  const camera = new THREE.PerspectiveCamera(FOV_DEGREES, window.innerWidth / window.innerHeight, NEAR, FAR)
  camera.rotation.order = 'YXZ'
  camera.position.set(0, EYE_HEIGHT, 0)
  scene.add(camera)

  const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x1a1410, 0.9)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xfff2df, 1.1)
  sun.position.set(30, 50, -20)
  scene.add(sun)

  function onResize(): void {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  }
  window.addEventListener('resize', onResize)

  return {
    renderer,
    scene,
    camera,
    dispose(): void {
      window.removeEventListener('resize', onResize)
      renderer.dispose()
    },
  }
}
