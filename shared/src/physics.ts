import type { Vec3, AABB, PlayerState, PlayerInput } from './types'
import type { GameMap } from './map'
import { add, sub, scale, dot, normalize, length, distSq, clamp } from './math'
import {
  MOVE_SPEED,
  ACCEL_GROUND,
  ACCEL_AIR,
  FRICTION_GROUND,
  PLAYER_GRAVITY,
  JUMP_SPEED,
  PLAYER_RADIUS,
  PLAYER_HEIGHT,
  FLAG_CARRIER_SPEED_MULT,
  ADS_MOVE_MULT,
  TELEPORT_COOLDOWN,
  TELEPORT_ARRIVAL_OFFSET,
  COYOTE_TIME,
  JUMP_BUFFER_TIME,
  SPRINT_SPEED_MULT,
  SPRINT_MIN_FORWARD,
  SLIDE_SPEED_MULT,
  SLIDE_DURATION,
  SLIDE_FRICTION,
  SLIDE_MIN_SPEED,
  SLIDE_COOLDOWN,
  CLAMBER_MIN_HEIGHT,
  CLAMBER_MAX_HEIGHT,
  CLAMBER_CHECK_DISTANCE,
  CLAMBER_BOOST_SPEED,
} from './constants'

/**
 * Canonical pitched view-direction convention: yaw=0 -> +z (matching
 * stepMovement's forwardVec below), pitch positive looks up. The single
 * source of truth for aim/tracer/melee direction math -- see
 * docs/ERRORS.md's "Three separate sign-convention inversion bugs" entry
 * for why every call site must use this instead of re-deriving its own trig.
 */
export function viewDir(yaw: number, pitch: number): Vec3 {
  return normalize({
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  })
}

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
 * Airborne ledge clamber: probes CLAMBER_CHECK_DISTANCE ahead of `pos`
 * along `wishDir` for a box whose top sits between CLAMBER_MIN_HEIGHT and
 * CLAMBER_MAX_HEIGHT above `pos`, and whose x/z footprint (padded by
 * PLAYER_RADIUS) contains the probe point. Rejects a candidate if any
 * other box occupies the headroom column [box.max.y, box.max.y +
 * PLAYER_HEIGHT] at the probe (nothing to stand up into). Returns the
 * ledge's top y, or null if no box qualifies. Pure -- no mutation.
 */
export function tryClamber(pos: Vec3, wishDir: Vec3, boxes: AABB[]): number | null {
  const probe = add(pos, scale(wishDir, CLAMBER_CHECK_DISTANCE))

  for (const box of boxes) {
    if (
      probe.x < box.min.x - PLAYER_RADIUS ||
      probe.x > box.max.x + PLAYER_RADIUS ||
      probe.z < box.min.z - PLAYER_RADIUS ||
      probe.z > box.max.z + PLAYER_RADIUS
    ) {
      continue
    }

    const height = box.max.y - pos.y
    if (height < CLAMBER_MIN_HEIGHT || height > CLAMBER_MAX_HEIGHT) continue

    let blocked = false
    for (const other of boxes) {
      if (other === box) continue
      if (probe.x < other.min.x || probe.x > other.max.x || probe.z < other.min.z || probe.z > other.max.z) {
        continue
      }
      if (other.min.y < box.max.y + PLAYER_HEIGHT && other.max.y > box.max.y) {
        blocked = true
        break
      }
    }
    if (blocked) continue

    return box.max.y
  }

  return null
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

  // ADS task (sim-owning agent, authorized edit -- touched outside this
  // file's normal ownership, see PR/task notes): p.scoped mirrors exactly
  // how p.sprinting is stored AND computed -- recomputed every tick
  // straight from input.ads, right here (before speedMult/wishSpeed/
  // sprinting below all read it) rather than in sim.ts's tick(),
  // specifically so shared/src/predict.ts's client-side replay (which calls
  // this function directly, bypassing MatchSim.tick() entirely) also gets a
  // correct p.scoped without any wiring changes on its end.
  p.scoped = input.ads === true

  // Analog move axes, clamped defensively: these arrive over the wire from
  // an untrusted client, and an unclamped 50 on either axis is a speed hack
  // that costs one line to close.
  const moveF = clamp(input.forward, -1, 1)
  const moveS = clamp(input.strafe, -1, 1)

  const forwardVec: Vec3 = { x: Math.sin(p.yaw), y: 0, z: Math.cos(p.yaw) }
  // right = forward x up (right-handed world, up = +y): (sinψ,0,cosψ) x (0,1,0)
  // = (0*0 - cosψ*1, cosψ*0 - sinψ*0, sinψ*1 - 0*0) = (-cosψ, 0, sinψ).
  const rightVec: Vec3 = { x: -Math.cos(p.yaw), y: 0, z: Math.sin(p.yaw) }
  const wish = add(scale(forwardVec, moveF), scale(rightVec, moveS))
  const wishDir = normalize(wish)
  // Analog throttle: a half-pushed stick walks at half speed. Capped at 1 so
  // a keyboard diagonal (magnitude sqrt2) is bit-identical to before, and a
  // dead stick gives 0 with no division anywhere -- wishDir is already
  // normalize()'d, which returns the zero vector rather than dividing by 0.
  const throttle = Math.min(1, Math.hypot(moveF, moveS))
  // Scoped players move at ADS_MOVE_MULT, same multiplicative slot as the
  // existing flag-carrier penalty.
  const speedMult = (p.carryingFlag !== null ? FLAG_CARRIER_SPEED_MULT : 1) * (p.scoped ? ADS_MOVE_MULT : 1)

  // Slide: cooldown ticks down every tick; a fresh slide can start once
  // grounded, not already sliding, off cooldown, and moving fast enough.
  p.slideCooldownRemaining = Math.max(0, p.slideCooldownRemaining - dt)
  const hSpeed = Math.hypot(p.vel.x, p.vel.z)
  if (
    input.slideRequest === true &&
    p.grounded &&
    !p.sliding &&
    p.slideCooldownRemaining <= 0 &&
    hSpeed > SLIDE_MIN_SPEED
  ) {
    p.sliding = true
    p.slideTimeRemaining = SLIDE_DURATION
    p.vel = { x: p.vel.x * SLIDE_SPEED_MULT, y: p.vel.y, z: p.vel.z * SLIDE_SPEED_MULT }
  }

  // ADS task: sprint must be impossible while scoped (p.scoped is set at
  // the top of this function) -- added to the existing exclusivity chain
  // (already excludes sliding/firing) rather than a separate gate.
  p.sprinting =
    input.sprint === true &&
    p.grounded &&
    !p.sliding &&
    !p.scoped &&
    moveF > SPRINT_MIN_FORWARD &&
    !input.fire
  const wishSpeed = MOVE_SPEED * speedMult * (p.sprinting ? SPRINT_SPEED_MULT : 1) * throttle

  if (p.sliding) {
    // Skip accelerate()/applyFriction() while sliding -- decay horizontal
    // speed with the same drop formula as applyFriction, but SLIDE_FRICTION.
    const speed = Math.sqrt(p.vel.x * p.vel.x + p.vel.z * p.vel.z)
    if (speed < 1e-6) {
      p.vel = { x: 0, y: p.vel.y, z: 0 }
    } else {
      const drop = speed * SLIDE_FRICTION * dt
      const newSpeed = Math.max(speed - drop, 0)
      const f = newSpeed / speed
      p.vel = { x: p.vel.x * f, y: p.vel.y, z: p.vel.z * f }
    }
    p.slideTimeRemaining -= dt
    if (p.slideTimeRemaining <= 0 || !p.grounded || input.jump) {
      p.sliding = false
      p.slideCooldownRemaining = SLIDE_COOLDOWN
      // Ending via jump must NOT zero vel.x/z here -- a free slide-cancel jump.
    }
  } else {
    // Friction runs on EVERY grounded tick, before accelerate -- not only on
    // ticks with no movement key held. accelerate() only ever adds speed
    // along wishDir, so nothing else bleeds off the velocity component
    // orthogonal to it: a player already running forward who then adds a
    // strafe key used to deflect ~10 degrees instead of 45 and never
    // converge. Quake/Source run friction then acceleration for this reason.
    if (p.grounded) p.vel = applyFriction(p.vel, dt)
    if (length(wishDir) > 0) {
      const accel = p.grounded ? ACCEL_GROUND : ACCEL_AIR
      p.vel = accelerate(p.vel, wishDir, wishSpeed, accel, dt)
    }
  }

  // Coyote time: grounded refreshes the window; airborne counts it down.
  // Reads p.grounded as set by last tick's collideCapsule -- no reordering.
  if (p.grounded) {
    p.coyoteTimeRemaining = COYOTE_TIME
  } else {
    p.coyoteTimeRemaining = Math.max(0, p.coyoteTimeRemaining - dt)
  }
  const canJump = p.grounded || p.coyoteTimeRemaining > 0
  if (input.jump && canJump) {
    p.vel = { ...p.vel, y: JUMP_SPEED }
    p.coyoteTimeRemaining = 0
    p.jumpBufferRemaining = 0
  } else if (input.jump && !canJump) {
    // Too late for coyote time -- buffer the press so it fires the moment
    // this player lands.
    p.jumpBufferRemaining = JUMP_BUFFER_TIME
  } else if (p.grounded && p.jumpBufferRemaining > 0) {
    p.vel = { ...p.vel, y: JUMP_SPEED }
    p.jumpBufferRemaining = 0
  } else {
    p.jumpBufferRemaining = Math.max(0, p.jumpBufferRemaining - dt)
  }

  p.vel = { ...p.vel, y: p.vel.y - PLAYER_GRAVITY * dt }

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

  if (!p.grounded && !p.sliding && !forcedAirborne && length(wishDir) > 0) {
    const ledgeY = tryClamber(p.pos, wishDir, map.boxes)
    if (ledgeY !== null) {
      p.pos = { ...p.pos, y: ledgeY }
      p.vel = { ...p.vel, y: CLAMBER_BOOST_SPEED }
      p.grounded = false
    }
  }

  const result = collideCapsule(p.pos, p.vel, map.boxes, dt)
  p.pos = result.pos
  p.vel = result.vel
  p.grounded = forcedAirborne ? false : result.grounded

  if (p.pos.y < map.deathY) return 'fell'
  return 'ok'
}
