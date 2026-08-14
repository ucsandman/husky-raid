import * as THREE from 'three'
import type { Team } from '@riftlane/shared'

export const TEAM_HULL: Record<Team, number> = { 0: 0x36599f, 1: 0xa85c2c }
export const TEAM_GLOW: Record<Team, number> = { 0: 0x5b9dff, 1: 0xff9a48 }
export const TELEPORT_A_COLOR = 0x49b6ff
export const TELEPORT_B_COLOR = 0xffa54d
export const LAUNCH_COLOR = 0x5cffd0
export const SKY_ZENITH = 0x070a1c
export const SKY_HIGH = 0x1b1f4d
export const SKY_HORIZON = 0x59306b
export const SKY_GLOW = 0xff9a6a
export const FOG_COLOR = 0x1d1c3c

const PANEL_TEX_SIZE = 256
const DECK_TEX_SIZE = 256
const NOISE_TEX_SIZE = 128

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null } {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return { canvas, ctx: canvas.getContext('2d') }
}

function finishTexture(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  return tex
}

/** Deterministic value noise so every client paints identical textures --
 * Math.random here would make screenshot diffs unstable. */
function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

/** Hard-surface panel plating: seams, inset panels, bolts, grime. Tiles
 * seamlessly because every mark is drawn inside the 0..size square with
 * wrapped duplicates along both edges. */
export function makePanelTexture(): THREE.CanvasTexture {
  const size = PANEL_TEX_SIZE
  const { canvas, ctx } = makeCanvas(size)
  if (!ctx) return finishTexture(canvas, true)

  ctx.fillStyle = '#39404f'
  ctx.fillRect(0, 0, size, size)

  for (let i = 0; i < 2600; i++) {
    const v = hash01(i)
    const x = hash01(i * 3.1) * size
    const y = hash01(i * 7.7) * size
    ctx.fillStyle = v > 0.5 ? `rgba(255,255,255,${0.05 * v})` : `rgba(0,0,0,${0.09 * v})`
    ctx.fillRect(x, y, 1 + v * 2, 1 + v)
  }

  const cell = size / 2
  for (let gx = 0; gx < 2; gx++) {
    for (let gy = 0; gy < 2; gy++) {
      const x = gx * cell
      const y = gy * cell
      const inset = 10 + hash01(gx * 5 + gy) * 6
      ctx.fillStyle = `rgba(0,0,0,${0.1 + hash01(gx + gy * 3) * 0.14})`
      ctx.fillRect(x + inset, y + inset, cell - inset * 2, cell - inset * 2)
      ctx.strokeStyle = 'rgba(160,180,215,0.22)'
      ctx.lineWidth = 1
      ctx.strokeRect(x + inset + 0.5, y + inset + 0.5, cell - inset * 2, cell - inset * 2)
      for (let b = 0; b < 4; b++) {
        const bx = x + inset + (b % 2 === 0 ? 5 : cell - inset * 2 - 5)
        const by = y + inset + (b < 2 ? 5 : cell - inset * 2 - 5)
        ctx.fillStyle = 'rgba(200,215,240,0.3)'
        ctx.beginPath()
        ctx.arc(bx, by, 1.8, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  ctx.strokeStyle = 'rgba(8,10,16,0.85)'
  ctx.lineWidth = 3
  for (let i = 0; i <= 2; i++) {
    const p = i * cell
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, size)
    ctx.moveTo(0, p)
    ctx.lineTo(size, p)
    ctx.stroke()
  }

  return finishTexture(canvas, true)
}

/** Walkable deck: tread cells, direction chevrons, worn edge bands. */
export function makeDeckTexture(): THREE.CanvasTexture {
  const size = DECK_TEX_SIZE
  const { canvas, ctx } = makeCanvas(size)
  if (!ctx) return finishTexture(canvas, true)

  ctx.fillStyle = '#2c3242'
  ctx.fillRect(0, 0, size, size)

  for (let i = 0; i < 3000; i++) {
    const v = hash01(i * 1.7)
    ctx.fillStyle = v > 0.55 ? `rgba(190,205,235,${0.05 * v})` : `rgba(0,0,0,${0.12 * v})`
    ctx.fillRect(hash01(i * 2.3) * size, hash01(i * 5.9) * size, 1 + v, 1 + v)
  }

  const half = size / 2
  ctx.fillStyle = 'rgba(0,0,0,0.16)'
  ctx.fillRect(0, 0, half, half)
  ctx.fillRect(half, half, half, half)

  ctx.strokeStyle = 'rgba(12,15,22,0.9)'
  ctx.lineWidth = 4
  ctx.strokeRect(0, 0, size, size)
  ctx.beginPath()
  ctx.moveTo(half, 0)
  ctx.lineTo(half, size)
  ctx.moveTo(0, half)
  ctx.lineTo(size, half)
  ctx.stroke()

  ctx.strokeStyle = 'rgba(150,175,215,0.16)'
  ctx.lineWidth = 1
  for (let i = 1; i < 16; i++) {
    const p = (i / 16) * size
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, size)
    ctx.stroke()
  }

  return finishTexture(canvas, true)
}

/** Greyscale grain used as a roughness map so no large surface reads flat. */
export function makeNoiseTexture(): THREE.CanvasTexture {
  const size = NOISE_TEX_SIZE
  const { canvas, ctx } = makeCanvas(size)
  if (!ctx) return finishTexture(canvas, false)
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < size * size; i++) {
    const v = 120 + hash01(i * 1.31) * 110
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return finishTexture(canvas, false)
}

/** Soft radial falloff -- sprites, sparks, glow cards. */
export function makeSoftDotTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(64)
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Four-point star with a hot core -- muzzle flashes. */
export function makeFlareTexture(): THREE.CanvasTexture {
  const size = 128
  const { canvas, ctx } = makeCanvas(size)
  if (ctx) {
    const c = size / 2
    const g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.5)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.4, 'rgba(255,225,150,0.7)')
    g.addColorStop(1, 'rgba(255,160,60,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    ctx.strokeStyle = 'rgba(255,240,200,0.85)'
    ctx.lineCap = 'round'
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      const len = i % 2 === 0 ? c * 0.95 : c * 0.55
      ctx.lineWidth = i % 2 === 0 ? 5 : 3
      ctx.beginPath()
      ctx.moveTo(c - Math.cos(a) * len, c - Math.sin(a) * len)
      ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len)
      ctx.stroke()
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Bright core fading to transparent across V -- mapped round a tracer tube
 * so the bolt has a hot centre and soft edges without extra geometry. */
export function makeStreakTexture(): THREE.CanvasTexture {
  const size = 64
  const { canvas, ctx } = makeCanvas(size)
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, size)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.35, 'rgba(255,240,190,0.85)')
    g.addColorStop(0.5, 'rgba(255,255,255,1)')
    g.addColorStop(0.65, 'rgba(255,240,190,0.85)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * Shared MeshStandardMaterial roles + the procedural textures behind them,
 * built fresh per match and disposed from Game.teardown() alongside the map
 * and soldiers. Per-match (not module-level) on purpose: dispose.ts frees a
 * material's textures when it walks the scene, so a cache that outlived one
 * match would hand the next match already-disposed GPU objects.
 */
export class MaterialLibrary {
  readonly panelTex = makePanelTexture()
  readonly deckTex = makeDeckTexture()
  readonly noiseTex = makeNoiseTexture()
  readonly glowTex = makeSoftDotTexture()

  private readonly owned: THREE.Material[] = []

  readonly deck = this.track(
    new THREE.MeshStandardMaterial({
      color: 0x7d8aa0,
      map: this.deckTex,
      roughnessMap: this.noiseTex,
      roughness: 0.82,
      metalness: 0.25,
    })
  )

  readonly hull = this.track(
    new THREE.MeshStandardMaterial({
      color: 0x8f9bb2,
      map: this.panelTex,
      roughnessMap: this.noiseTex,
      roughness: 0.6,
      metalness: 0.55,
    })
  )

  readonly hullDark = this.track(
    new THREE.MeshStandardMaterial({
      color: 0x2c3140,
      map: this.panelTex,
      roughness: 0.7,
      metalness: 0.5,
    })
  )

  readonly trim = this.track(
    new THREE.MeshStandardMaterial({ color: 0xb9c6dc, roughness: 0.3, metalness: 0.85 })
  )

  readonly ground = this.track(
    new THREE.MeshStandardMaterial({
      color: 0x06070e,
      map: this.deckTex,
      roughness: 1,
      metalness: 0,
    })
  )

  readonly glass = this.track(
    new THREE.MeshStandardMaterial({
      color: 0x8ff4ff,
      emissive: 0x2ad6ff,
      emissiveIntensity: 1.4,
      roughness: 0.12,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85,
    })
  )

  readonly backdrop = this.track(
    new THREE.MeshStandardMaterial({ color: 0x161a33, roughness: 0.95, metalness: 0.1, fog: true })
  )

  private readonly teamHullMats = new Map<Team, THREE.MeshStandardMaterial>()
  private readonly teamGlowMats = new Map<Team, THREE.MeshStandardMaterial>()
  private readonly signalMats = new Map<number, THREE.MeshStandardMaterial>()
  private readonly additiveMats = new Map<number, THREE.MeshBasicMaterial>()

  private track<T extends THREE.Material>(mat: T): T {
    this.owned.push(mat)
    return mat
  }

  teamHull(team: Team): THREE.MeshStandardMaterial {
    let mat = this.teamHullMats.get(team)
    if (!mat) {
      mat = this.track(
        new THREE.MeshStandardMaterial({
          color: TEAM_HULL[team],
          map: this.panelTex,
          roughnessMap: this.noiseTex,
          roughness: 0.62,
          metalness: 0.45,
        })
      )
      this.teamHullMats.set(team, mat)
    }
    return mat
  }

  teamGlow(team: Team): THREE.MeshStandardMaterial {
    let mat = this.teamGlowMats.get(team)
    if (!mat) {
      mat = this.signal(TEAM_GLOW[team])
      this.teamGlowMats.set(team, mat)
    }
    return mat
  }

  /** Authored glow strip / status light. Emissive only -- never a whole prop. */
  signal(color: number): THREE.MeshStandardMaterial {
    let mat = this.signalMats.get(color)
    if (!mat) {
      mat = this.track(
        new THREE.MeshStandardMaterial({
          color: 0x0b0f18,
          emissive: color,
          emissiveIntensity: 1.0,
          roughness: 0.4,
          metalness: 0,
        })
      )
      this.signalMats.set(color, mat)
    }
    return mat
  }

  /** Unlit additive card for light pillars, halos and volumetric fakes. */
  additive(color: number, opacity: number): THREE.MeshBasicMaterial {
    const key = color * 1000 + Math.round(opacity * 100)
    let mat = this.additiveMats.get(key)
    if (!mat) {
      mat = this.track(
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        })
      )
      this.additiveMats.set(key, mat)
    }
    return mat
  }

  dispose(): void {
    for (const mat of this.owned) mat.dispose()
    this.owned.length = 0
    this.panelTex.dispose()
    this.deckTex.dispose()
    this.noiseTex.dispose()
    this.glowTex.dispose()
  }
}
