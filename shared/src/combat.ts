import type { Vec3, AABB, PlayerState, Team } from './types'
import { add, sub, scale, dot, normalize, length, distSq, lerpV, clamp } from './math'
import {
  MAX_SHIELD,
  SHIELD_RECHARGE_DELAY,
  SHIELD_RECHARGE_RATE,
  GRAVITY,
  PLAYER_BODY_CENTER_Y,
  PLAYER_BODY_RADIUS,
  PLAYER_HEAD_CENTER_Y,
  PLAYER_HEAD_RADIUS,
  FRAG_BOUNCE_DAMPING,
  HOMING_TURN_RATE,
  SWARM_POP_THRESHOLD,
} from './constants'

/**
 * Applies damage to a player: shield absorbs first, overflow spills to
 * health. Sets lastDamageAt (drives shield recharge delay) and breaks
 * camo. 'absorbed' is returned (no-op, no mutation) for an already-dead
 * target, e.g. splash that reaches a corpse — distinct from 'hit', which
 * covers live damage that neither breaks the shield nor kills.
 */
export function applyDamage(
  target: PlayerState,
  amount: number,
  now: number
): 'absorbed' | 'shield_break' | 'hit' | 'killed' {
  if (!target.alive) return 'absorbed'

  target.lastDamageAt = now
  target.camoUntil = 0

  let remaining = amount
  let shieldBroke = false

  if (target.shield > 0) {
    if (remaining >= target.shield) {
      remaining -= target.shield
      target.shield = 0
      shieldBroke = true
    } else {
      target.shield -= remaining
      remaining = 0
    }
  }

  if (remaining > 0) {
    target.health -= remaining
    if (target.health <= 0) {
      target.health = 0
      target.alive = false
      return 'killed'
    }
  }

  return shieldBroke ? 'shield_break' : 'hit'
}

/** Recharges shield per constants.ts, gated by SHIELD_RECHARGE_DELAY since lastDamageAt. */
export function tickShield(p: PlayerState, now: number, dt: number): void {
  if (now - p.lastDamageAt < SHIELD_RECHARGE_DELAY) return
  if (p.shield >= MAX_SHIELD) return
  p.shield = Math.min(MAX_SHIELD, p.shield + SHIELD_RECHARGE_RATE * dt)
}

function bodyCenter(pos: Vec3): Vec3 {
  return { x: pos.x, y: pos.y + PLAYER_BODY_CENTER_Y, z: pos.z }
}

function headCenter(pos: Vec3): Vec3 {
  return { x: pos.x, y: pos.y + PLAYER_HEAD_CENTER_Y, z: pos.z }
}

function pointInBox(p: Vec3, box: AABB): boolean {
  return (
    p.x >= box.min.x &&
    p.x <= box.max.x &&
    p.y >= box.min.y &&
    p.y <= box.max.y &&
    p.z >= box.min.z &&
    p.z <= box.max.z
  )
}

/** Nearest positive t where the ray enters box, or null if it misses. */
function raySlab(origin: Vec3, dir: Vec3, box: AABB): number | null {
  let tmin = 0
  let tmax = Infinity
  const axes: (keyof Vec3)[] = ['x', 'y', 'z']
  for (const axis of axes) {
    const o = origin[axis]
    const d = dir[axis]
    const mn = box.min[axis]
    const mx = box.max[axis]
    if (Math.abs(d) < 1e-9) {
      if (o < mn || o > mx) return null
      continue
    }
    let t1 = (mn - o) / d
    let t2 = (mx - o) / d
    if (t1 > t2) [t1, t2] = [t2, t1]
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return null
  }
  return tmin
}

/** Nearest positive t where the ray enters the sphere, or null if it misses. */
function raySphere(origin: Vec3, dir: Vec3, center: Vec3, radius: number): number | null {
  const oc = sub(origin, center)
  const a = dot(dir, dir)
  const b = 2 * dot(oc, dir)
  const c = dot(oc, oc) - radius * radius
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const sqrtDisc = Math.sqrt(disc)
  const t1 = (-b - sqrtDisc) / (2 * a)
  const t2 = (-b + sqrtDisc) / (2 * a)
  if (t1 >= 0) return t1
  if (t2 >= 0) return t2
  return null
}

/**
 * Slab-tests walls and two-sphere-tests players (body + head), returns the
 * nearest hit. seeCamo defaults true: hitscan always hits camo'd players.
 * Bots will pass seeCamo=false to skip currently-camo'd players for line-of
 * -sight checks (Task 10) — pass sim time as `now` in that case, matching
 * the codebase's *Until convention (camoUntil is an absolute timestamp, not
 * a flag; there's no zeroing-on-expiry, so comparing against a live `now`
 * is what makes camo wear off instead of becoming permanent after first use).
 */
export function raycast(
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  boxes: AABB[],
  players: PlayerState[],
  ignoreId: string,
  seeCamo: boolean = true,
  now: number = 0
): { kind: 'none' | 'wall' | 'player'; dist: number; playerId?: string; head?: boolean } {
  let bestDist = maxDist
  let kind: 'none' | 'wall' | 'player' = 'none'
  let playerId: string | undefined
  let head: boolean | undefined

  for (const box of boxes) {
    const d = raySlab(origin, dir, box)
    if (d !== null && d < bestDist) {
      bestDist = d
      kind = 'wall'
      playerId = undefined
      head = undefined
    }
  }

  for (const p of players) {
    if (p.id === ignoreId || !p.alive) continue
    if (!seeCamo && p.camoUntil > now) continue

    const bodyT = raySphere(origin, dir, bodyCenter(p.pos), PLAYER_BODY_RADIUS)
    if (bodyT !== null && bodyT < bestDist) {
      bestDist = bodyT
      kind = 'player'
      playerId = p.id
      head = false
    }
    const headT = raySphere(origin, dir, headCenter(p.pos), PLAYER_HEAD_RADIUS)
    if (headT !== null && headT < bestDist) {
      bestDist = headT
      kind = 'player'
      playerId = p.id
      head = true
    }
  }

  return { kind, dist: kind === 'none' ? maxDist : bestDist, playerId, head }
}

export interface Projectile {
  id: number
  kind: 'boomtube' | 'swarm_dart' | 'ion_charge' | 'frag' | 'mag'
  pos: Vec3
  vel: Vec3
  ownerId: string
  team: Team
  fuseAt: number
  homingTargetId?: string
  stuckToId?: string
}

function steerTowards(curDir: Vec3, targetDir: Vec3, maxAngle: number): Vec3 {
  const cosAngle = clamp(dot(curDir, targetDir), -1, 1)
  const angle = Math.acos(cosAngle)
  if (angle <= maxAngle || angle < 1e-6) return targetDir
  return normalize(lerpV(curDir, targetDir, maxAngle / angle))
}

/**
 * Advances one projectile one tick: gravity (frag/mag only), homing steer
 * (any projectile with homingTargetId set, capped at HOMING_TURN_RATE),
 * then kind-specific collision. Never calls applyDamage/explode itself —
 * callers own damage application using the projectile's kind to look up
 * the right WEAPONS/grenade damage number.
 */
export function stepProjectile(
  pr: Projectile,
  players: PlayerState[],
  boxes: AABB[],
  dt: number,
  now: number
): { exploded: boolean; hitPlayerId?: string } {
  const hasGravity = pr.kind === 'frag' || pr.kind === 'mag'
  if (hasGravity && !pr.stuckToId) {
    pr.vel = { ...pr.vel, y: pr.vel.y - GRAVITY * dt }
  }

  if (pr.homingTargetId && !pr.stuckToId) {
    const target = players.find((p) => p.id === pr.homingTargetId && p.alive)
    if (target && length(pr.vel) > 1e-6) {
      const speed = length(pr.vel)
      const curDir = normalize(pr.vel)
      const toTarget = normalize(sub(bodyCenter(target.pos), pr.pos))
      pr.vel = scale(steerTowards(curDir, toTarget, HOMING_TURN_RATE * dt), speed)
    }
  }

  if (pr.kind === 'mag' && pr.stuckToId) {
    const target = players.find((p) => p.id === pr.stuckToId)
    if (target) pr.pos = { ...target.pos }
    return { exploded: now >= pr.fuseAt }
  }

  pr.pos = add(pr.pos, scale(pr.vel, dt))

  if (pr.kind === 'frag') {
    for (const box of boxes) {
      if (pointInBox(pr.pos, box)) {
        pr.vel = scale(pr.vel, -FRAG_BOUNCE_DAMPING)
        break
      }
    }
    return { exploded: now >= pr.fuseAt }
  }

  if (pr.kind === 'mag') {
    for (const p of players) {
      if (p.id === pr.ownerId || !p.alive) continue
      if (distSq(pr.pos, bodyCenter(p.pos)) <= PLAYER_BODY_RADIUS * PLAYER_BODY_RADIUS) {
        pr.stuckToId = p.id
        pr.vel = { x: 0, y: 0, z: 0 }
        return { exploded: now >= pr.fuseAt, hitPlayerId: p.id }
      }
    }
    for (const box of boxes) {
      if (pointInBox(pr.pos, box)) {
        pr.vel = { x: 0, y: 0, z: 0 }
        break
      }
    }
    return { exploded: now >= pr.fuseAt }
  }

  if (pr.kind === 'swarm_dart') {
    for (const p of players) {
      if (p.id === pr.ownerId || !p.alive) continue
      if (distSq(pr.pos, bodyCenter(p.pos)) <= PLAYER_BODY_RADIUS * PLAYER_BODY_RADIUS) {
        p.stuckDarts += 1
        return { exploded: true, hitPlayerId: p.id }
      }
    }
    for (const box of boxes) {
      if (pointInBox(pr.pos, box)) return { exploded: true }
    }
    return { exploded: false }
  }

  // boomtube / ion_charge: detonate on any contact
  for (const p of players) {
    if (p.id === pr.ownerId || !p.alive) continue
    if (distSq(pr.pos, bodyCenter(p.pos)) <= PLAYER_BODY_RADIUS * PLAYER_BODY_RADIUS) {
      return { exploded: true, hitPlayerId: p.id }
    }
  }
  for (const box of boxes) {
    if (pointInBox(pr.pos, box)) return { exploded: true }
  }
  return { exploded: false }
}

/** Linear falloff splash damage. No self-exemption — rocket-jump risk stays. */
export function explode(
  center: Vec3,
  damage: number,
  radius: number,
  players: PlayerState[],
  now: number
): { playerId: string; damage: number }[] {
  const results: { playerId: string; damage: number }[] = []
  for (const p of players) {
    if (!p.alive) continue
    const d = length(sub(p.pos, center))
    if (d >= radius) continue
    const dmg = damage * (1 - d / radius)
    results.push({ playerId: p.id, damage: dmg })
    applyDamage(p, dmg, now)
  }
  return results
}

/** Resets stuckDarts to 0 and reports whether the swarm-pod stick bonus fires. */
// now is unused today; kept for signature parity with applyDamage/explode
// per the controller ruling, and reserved for a future timed-pop variant.
export function checkSwarmPop(p: PlayerState, now: number): boolean {
  if (p.stuckDarts >= SWARM_POP_THRESHOLD) {
    p.stuckDarts = 0
    return true
  }
  return false
}
