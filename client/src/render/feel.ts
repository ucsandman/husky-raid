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
