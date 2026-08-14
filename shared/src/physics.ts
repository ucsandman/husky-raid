import type { Vec3, AABB, PlayerState, PlayerInput } from './types'
import type { GameMap } from './map'
import { add, sub, scale, dot, normalize, length, distSq } from './math'
import {
  MOVE_SPEED,
  ACCEL_GROUND,
  ACCEL_AIR,
  FRICTION_GROUND,
  GRAVITY,
  JUMP_SPEED,
  PLAYER_RADIUS,
  PLAYER_HEIGHT,
  FLAG_CARRIER_SPEED_MULT,
  TELEPORT_COOLDOWN,
  TELEPORT_ARRIVAL_OFFSET,
} from './constants'

function playerAABB(pos: Vec3): AABB {
  return {
    min: { x: pos.x - PLAYER_RADIUS, y: pos.y, z: pos.z - PLAYER_RADIUS },
    max: { x: pos.x + PLAYER_RADIUS, y: pos.y + PLAYER_HEIGHT, z: pos.z + PLAYER_RADIUS },
  }
}

function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  )
}

/**
 * Reusable capsule-vs-AABB movement core, also used by bots' unstick checks.
 * v1 simplification: the player capsule is treated as its bounding AABB
 * (PLAYER_RADIUS wide, PLAYER_HEIGHT tall), not a true swept capsule.
 * Axis-separated resolution: integrate + resolve x, then y, then z.
 * Known limitation: only the Y pass pushes out a pre-existing (zero-velocity)
 * overlap, via the vel.y<=0 landing branch. X/Z overlap only resolves while
 * vel.x/vel.z is nonzero, so a capsule already stuck inside a box on the X/Z
 * axes with zero horizontal velocity will not be un-stuck by this function alone.
 */
export function collideCapsule(
  pos: Vec3,
  vel: Vec3,
  boxes: AABB[],
  dt: number
): { pos: Vec3; vel: Vec3; grounded: boolean } {
  const p: Vec3 = { ...pos }
  const v: Vec3 = { ...vel }
  let grounded = false

  p.x += v.x * dt
  for (const box of boxes) {
    if (aabbOverlap(playerAABB(p), box)) {
      if (v.x > 0) p.x = box.min.x - PLAYER_RADIUS
      else if (v.x < 0) p.x = box.max.x + PLAYER_RADIUS
      v.x = 0
    }
  }

  p.y += v.y * dt
  for (const box of boxes) {
    if (aabbOverlap(playerAABB(p), box)) {
      if (v.y <= 0) {
        p.y = box.max.y
        grounded = true
      } else {
        p.y = box.min.y - PLAYER_HEIGHT
      }
      v.y = 0
    }
  }

  p.z += v.z * dt
  for (const box of boxes) {
    if (aabbOverlap(playerAABB(p), box)) {
      if (v.z > 0) p.z = box.min.z - PLAYER_RADIUS
      else if (v.z < 0) p.z = box.max.z + PLAYER_RADIUS
      v.z = 0
    }
  }

  return { pos: p, vel: v, grounded }
}

function accelerate(vel: Vec3, wishDir: Vec3, wishSpeed: number, accel: number, dt: number): Vec3 {
  const currentSpeed = dot(vel, wishDir)
  const addSpeed = wishSpeed - currentSpeed
  if (addSpeed <= 0) return vel
  const accelSpeed = Math.min(accel * dt, addSpeed)
  return { x: vel.x + wishDir.x * accelSpeed, y: vel.y, z: vel.z + wishDir.z * accelSpeed }
}

function applyFriction(vel: Vec3, dt: number): Vec3 {
  const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z)
  if (speed < 1e-6) return { x: 0, y: vel.y, z: 0 }
  const drop = speed * FRICTION_GROUND * dt
  const newSpeed = Math.max(speed - drop, 0)
  const f = newSpeed / speed
  return { x: vel.x * f, y: vel.y, z: vel.z * f }
}

/**
 * Steps one player one tick. Deterministic: a pure function of
 * (p, input, map, dt) — no Math.random, no Date.now. Mutates p's
 * pos/vel/grounded/yaw/pitch/teleportCooldownUntil in place.
 *
 * Forward convention: yaw=0 -> +z, yaw=Math.PI -> -z (forward = (sin
 * yaw, 0, cos yaw)). This matches gutter's spawnYaw: team 0 spawns at
 * z=-27 with spawnYaw 0, facing +z toward the enemy base at z=+26;
 * team 1 spawns at z=27 with spawnYaw PI, facing -z toward z=-26.
 *
 * NOTE on teleportCooldownUntil: stepMovement receives no global clock,
 * only a per-tick dt, so this field is implemented as a *countdown*
 * (seconds remaining) rather than an absolute timestamp: it counts down
 * toward 0 every tick and resets to 1s on teleport.
 */
export function stepMovement(
  p: PlayerState,
  input: PlayerInput,
  map: GameMap,
  dt: number
): 'ok' | 'fell' {
  p.yaw = input.yaw
  p.pitch = input.pitch

  const forwardVec: Vec3 = { x: Math.sin(p.yaw), y: 0, z: Math.cos(p.yaw) }
  // right = forward x up (right-handed world, up = +y): (sinψ,0,cosψ) x (0,1,0)
  // = (0*0 - cosψ*1, cosψ*0 - sinψ*0, sinψ*1 - 0*0) = (-cosψ, 0, sinψ).
  const rightVec: Vec3 = { x: -Math.cos(p.yaw), y: 0, z: Math.sin(p.yaw) }
  const wish = add(scale(forwardVec, input.forward), scale(rightVec, input.strafe))
  const wishDir = normalize(wish)
  const speedMult = p.carryingFlag !== null ? FLAG_CARRIER_SPEED_MULT : 1
  const wishSpeed = MOVE_SPEED * speedMult

  if (length(wishDir) > 0) {
    const accel = p.grounded ? ACCEL_GROUND : ACCEL_AIR
    p.vel = accelerate(p.vel, wishDir, wishSpeed, accel, dt)
  } else if (p.grounded) {
    p.vel = applyFriction(p.vel, dt)
  }

  if (input.jump && p.grounded) {
    p.vel = { ...p.vel, y: JUMP_SPEED }
  }

  p.vel = { ...p.vel, y: p.vel.y - GRAVITY * dt }

  let forcedAirborne = false
  for (const pad of map.launchPads) {
    const dx = p.pos.x - pad.pos.x
    const dz = p.pos.z - pad.pos.z
    const withinRadius = dx * dx + dz * dz <= pad.radius * pad.radius
    const withinHeight = Math.abs(p.pos.y - pad.pos.y) < PLAYER_HEIGHT
    if (withinRadius && withinHeight) {
      p.vel = { ...pad.velocity }
      forcedAirborne = true
    }
  }

  p.teleportCooldownUntil = Math.max(0, p.teleportCooldownUntil - dt)
  if (p.teleportCooldownUntil <= 0) {
    for (const tp of map.teleporters) {
      const distSqA = distSq(p.pos, tp.a)
      const distSqB = distSq(p.pos, tp.b)
      if (distSqA <= tp.radius * tp.radius) {
        const dir = normalize(sub(tp.b, tp.a))
        p.pos = add(tp.b, scale(dir, TELEPORT_ARRIVAL_OFFSET))
        p.teleportCooldownUntil = TELEPORT_COOLDOWN
        break
      } else if (distSqB <= tp.radius * tp.radius) {
        const dir = normalize(sub(tp.a, tp.b))
        p.pos = add(tp.a, scale(dir, TELEPORT_ARRIVAL_OFFSET))
        p.teleportCooldownUntil = TELEPORT_COOLDOWN
        break
      }
    }
  }

  const result = collideCapsule(p.pos, p.vel, map.boxes, dt)
  p.pos = result.pos
  p.vel = result.vel
  p.grounded = forcedAirborne ? false : result.grounded

  if (p.pos.y < map.deathY) return 'fell'
  return 'ok'
}
