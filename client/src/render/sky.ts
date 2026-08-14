import * as THREE from 'three'
import { SKY_GLOW, SKY_HIGH, SKY_HORIZON, SKY_ZENITH } from './materials'

const DOME_RADIUS = 420
const STAR_RADIUS = 400
const STAR_COUNT_SMALL = 900
const STAR_COUNT_BRIGHT = 90

const VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAGMENT_SHADER = /* glsl */ `
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHigh;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSunDir;

void main() {
  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uHorizon, uHigh, smoothstep(0.5, 0.72, h));
  col = mix(col, uZenith, smoothstep(0.72, 1.0, h));
  col = mix(uHorizon * 0.35, col, smoothstep(0.42, 0.52, h));

  float sun = max(dot(vDir, uSunDir), 0.0);
  col += uGlow * pow(sun, 6.0) * 0.55;
  col += uGlow * pow(sun, 1.6) * 0.10;

  float band = exp(-pow((h - 0.5) * 18.0, 2.0));
  col += uGlow * band * 0.16;

  // ordered dither -- a 4-stop vertical ramp bands badly on 8-bit output.
  float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (d - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0);
}
`

function starGeometry(count: number, seed: number, minY: number): THREE.BufferGeometry {
  const pos = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const a = hash(i + seed) * Math.PI * 2
    const y = minY + hash(i * 2.7 + seed) * (1 - minY)
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    pos[i * 3] = Math.cos(a) * r * STAR_RADIUS
    pos[i * 3 + 1] = y * STAR_RADIUS
    pos[i * 3 + 2] = Math.sin(a) * r * STAR_RADIUS
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  return geom
}

function hash(n: number): number {
  const s = Math.sin(n * 91.3458 + 17.13) * 47453.5453
  return s - Math.floor(s)
}

/**
 * Backdrop layers drawn before everything else: a gradient dome, two star
 * shells and a warm horizon band. All three opt out of fog and depth so the
 * dome can sit inside camera.far without ever clipping world geometry, and
 * the whole group is static -- the arena is ~60m across against a 420m dome,
 * so parallax from player movement is below a pixel.
 */
export function buildSky(dotTexture: THREE.Texture): THREE.Group {
  const group = new THREE.Group()
  group.name = 'sky'

  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(SKY_ZENITH) },
      uHigh: { value: new THREE.Color(SKY_HIGH) },
      uHorizon: { value: new THREE.Color(SKY_HORIZON) },
      uGlow: { value: new THREE.Color(SKY_GLOW) },
      uSunDir: { value: new THREE.Vector3(0.45, 0.1, -0.88).normalize() },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 20), domeMat)
  dome.renderOrder = -3
  dome.frustumCulled = false
  group.add(dome)

  const smallStars = new THREE.Points(
    starGeometry(STAR_COUNT_SMALL, 0, -0.05),
    new THREE.PointsMaterial({
      color: 0xbfd4ff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    })
  )
  smallStars.renderOrder = -2
  smallStars.frustumCulled = false
  group.add(smallStars)

  const brightStars = new THREE.Points(
    starGeometry(STAR_COUNT_BRIGHT, 71, 0.08),
    new THREE.PointsMaterial({
      map: dotTexture,
      color: 0xfff0d8,
      size: 6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    })
  )
  brightStars.renderOrder = -2
  brightStars.frustumCulled = false
  group.add(brightStars)

  const bandGeom = new THREE.CylinderGeometry(DOME_RADIUS * 0.94, DOME_RADIUS * 0.94, 150, 48, 1, true)
  const bandMat = new THREE.MeshBasicMaterial({
    map: horizonRamp(),
    color: 0xff8f5e,
    transparent: true,
    opacity: 0.5,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
  const band = new THREE.Mesh(bandGeom, bandMat)
  band.position.y = 20
  band.renderOrder = -1
  band.frustumCulled = false
  group.add(band)

  return group
}

function horizonRamp(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, 64)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.55, 'rgba(255,190,140,0.55)')
    g.addColorStop(0.72, 'rgba(255,140,90,0.9)')
    g.addColorStop(1, 'rgba(120,40,90,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 4, 64)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
