import * as THREE from 'three'
import type { Vec3 } from '@riftlane/shared'

/**
 * physics.ts's forward/right convention (yaw=0 -> +z, right-handed, up=+y):
 * forward = (sin yaw, 0, cos yaw), right = forward x up = (-cos yaw, 0, sin
 * yaw) -- see shared/src/physics.ts's stepMovement, which inlines this
 * rather than exporting it as a standalone helper. Duplicated here citing
 * that source of truth, same as audio.ts's stereo panner and effects.ts's
 * tracer viewDir already do -- there is no shared export to import instead.
 */
export function forwardXZ(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) }
}

export function rightXZ(yaw: number): { x: number; z: number } {
  return { x: -Math.cos(yaw), z: Math.sin(yaw) }
}

/**
 * Bearing of `source` relative to an observer standing at `origin` facing
 * `originYaw`, in radians: 0 = straight ahead, +PI/2 = right, -PI/2 = left,
 * +-PI = directly behind. Used for the damage-direction HUD indicator.
 */
export function bearing(origin: Vec3, originYaw: number, source: Vec3): number {
  const dx = source.x - origin.x
  const dz = source.z - origin.z
  const horiz = Math.hypot(dx, dz)
  if (horiz < 1e-4) return 0
  const f = forwardXZ(originYaw)
  const r = rightXZ(originYaw)
  const fwd = dx * f.x + dz * f.z
  const right = dx * r.x + dz * r.z
  return Math.atan2(right, fwd)
}

/** Exponential-decay a scalar toward `target` with time constant `tau`
 * seconds -- frame-rate independent (see game-feel.md's FOV-punch recipe). */
export function decayTo(value: number, target: number, dt: number, tau: number): number {
  const k = 1 - Math.exp(-dt / tau)
  return value + (target - value) * k
}

const TRAUMA_MAX = 1
const TRAUMA_DECAY = 1.7 // trauma units/sec
// RIFTLANE's camera sits at head height in a tight arena -- the reference
// doc's 0.55/0.1 read as a wild swing here, scaled down to stay readable.
const MAX_OFFSET = 0.14 // world units at full shake
const MAX_ROLL = 0.05 // radians at full shake

/** Deterministic value noise in [-1, 1], seeded per-axis so axes don't
 * lock-step. Driven by accumulated game time (passed in via update's dt),
 * never wall clock -- keeps shake reproducible under the seed()/reduced-
 * motion test hooks. */
function pseudoNoise(t: number, seed: number): number {
  const x = Math.sin(t * 12.9898 + seed * 78.233) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

/**
 * Trauma-based screenshake (see game-feel.md). Shake magnitude is
 * trauma^2 so small events barely move the camera and big ones snap hard;
 * trauma decays linearly per second and is hard-capped. Caller applies
 * `update()` every frame AFTER the camera's base pose (prediction position
 * + rotation.x/y) has been written, and must zero rotation.z beforehand --
 * this class only ever ADDS an offset, it never re-derives or resets the
 * base transform, so nothing here can leak into the real player transform.
 */
export class ShakeRig {
  private trauma = 0
  private time = 0

  addTrauma(amount: number): void {
    this.trauma = Math.min(TRAUMA_MAX, this.trauma + amount)
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.time += dt
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt)
    if (this.trauma <= 0) return
    const shake = this.trauma * this.trauma
    const freq = this.time * 32
    camera.position.x += MAX_OFFSET * shake * pseudoNoise(freq, 1)
    camera.position.y += MAX_OFFSET * shake * pseudoNoise(freq, 2)
    camera.rotation.z += MAX_ROLL * shake * pseudoNoise(freq, 3)
  }
}
