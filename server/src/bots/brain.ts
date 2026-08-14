import type { GameMap, MatchSim, PlayerInput, PlayerState, Team, Vec3, WeaponId } from '@riftlane/shared'
import { EYE_HEIGHT, PLAYER_BODY_CENTER_Y, TICK_DT, WEAPONS, add, distSq, dot, length, mulberry32, normalize, raycast, scale, sub } from '@riftlane/shared'
import { Navigator } from './nav'
import type { Role } from './roles'

export interface Difficulty {
  reactionMs: number
  aimErrorDeg: number
}

/** v1: one fixed difficulty for every bot. */
export const DEFAULT_DIFFICULTY: Difficulty = { reactionMs: 350, aimErrorDeg: 4 }

/** All bot tuning knobs live here -- never inline a magic number in the
 * logic below. Distances are meters, times are seconds unless noted. */
const BRAIN = {
  /** Camo'd enemies are invisible to bots beyond this distance, visible within it. */
  CAMO_VISIBLE_DIST: 4,
  /** Below this range: power melee if held, else scattergun-class. */
  CLOSE_RANGE: 4,
  /** Above this range: railspike/triad if held. 4..LONG_RANGE is "mid". */
  LONG_RANGE: 25,
  /** Debounce between brain-issued weapon swaps (sim's own SWAP_COOLDOWN is 0.5s too). */
  SWAP_INTERNAL_COOLDOWN: 0.5,
  /** Bot-level throttle on grenade throws (much longer than the sim's 1s GRENADE_COOLDOWN). */
  GRENADE_BOT_COOLDOWN: 6,
  GRENADE_MIN_RANGE: 8,
  GRENADE_MAX_RANGE: 25,
  /** Two enemies count as "clumped" within this distance of each other. */
  GRENADE_CLUMP_DIST: 4,
  /** Repulsor trigger distance for an incoming boomtube round or a nearby arc-blade enemy. */
  REPULSOR_TRIGGER_DIST: 6,
  /** Runner activates camo within this distance of the enemy flag stand. */
  CAMO_GRAB_DIST: 15,
  /** Escort holds station this far behind its own flag carrier. */
  ESCORT_FOLLOW_DIST: 4,
  /** Defender patrols within this radius of its own flag stand. */
  DEFENDER_PATROL_RADIUS: 3,
  /** How often the defender re-rolls its patrol jitter point (nav.ts oscillates
   * ~1.5m around a static goal with no stop state, so a fixed goal alone would
   * just have the bot vibrate in place forever -- periodic re-jitter keeps it patrolling). */
  DEFENDER_PATROL_RESET_INTERVAL: 4,
  /** Aim error halves once the bot has held continuous LOS on its target this long. */
  AIM_ERROR_HALF_LIFE: 1,
  /** Only push a new goal to the Navigator when it moved more than this far,
   * so a moving target (e.g. enemy flag carrier) doesn't force a full re-path every tick. */
  GOAL_REFRESH_DIST: 3,
} as const

function eyePos(p: PlayerState): Vec3 {
  return { x: p.pos.x, y: p.pos.y + EYE_HEIGHT, z: p.pos.z }
}

function chestPos(p: PlayerState): Vec3 {
  return { x: p.pos.x, y: p.pos.y + PLAYER_BODY_CENTER_Y, z: p.pos.z }
}

function yawPitchTo(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const d = sub(to, from)
  const yaw = Math.atan2(d.x, d.z)
  const horiz = Math.hypot(d.x, d.z)
  const pitch = Math.atan2(d.y, horiz)
  return { yaw, pitch }
}

/** Box-Muller, drawn from the bot's own seeded stream (never Math.random). */
function gaussian(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-9)
  const u2 = rand()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** yaw=0 -> +z convention, matching stepMovement/Navigator. */
function forwardVecOf(yaw: number): Vec3 {
  return { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }
}

function rightVecOf(yaw: number): Vec3 {
  return { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) }
}

/** stepMovement derives its movement basis from input.yaw itself (forward/
 * strafe are relative to facing), so overriding yaw for combat aim would
 * silently redirect movement too unless we re-express the Navigator's
 * intended world-space direction against the new yaw. */
function reprojectMovement(
  navYaw: number,
  navForward: number,
  navStrafe: number,
  finalYaw: number
): { forward: number; strafe: number } {
  const worldDir = add(scale(forwardVecOf(navYaw), navForward), scale(rightVecOf(navYaw), navStrafe))
  return { forward: dot(worldDir, forwardVecOf(finalYaw)), strafe: dot(worldDir, rightVecOf(finalYaw)) }
}

function weaponRangeScore(id: WeaponId, dist: number): number {
  const def = WEAPONS[id]
  if (dist < BRAIN.CLOSE_RANGE) {
    if (def.kind === 'power_melee') return 3
    if (id === 'scattergun') return 2
    return 1
  }
  if (dist <= BRAIN.LONG_RANGE) {
    if (def.kind === 'power_melee') return 0
    if (id === 'railspike') return 1
    return 2
  }
  if (id === 'railspike' || id === 'triad_rifle') return 3
  if (def.kind === 'power_melee') return 0
  return 1
}

/**
 * Nearest enemy with clear LOS. Camo'd enemies are pre-filtered by distance
 * (invisible beyond CAMO_VISIBLE_DIST, visible within it) before the
 * raycast runs, so the raycast itself is called with seeCamo=true -- it
 * only needs to resolve physical wall/body blocking at that point, not
 * re-apply camo invisibility we've already decided on for this candidate.
 */
function findVisibleTarget(
  bot: PlayerState,
  enemies: PlayerState[],
  map: GameMap,
  allPlayers: PlayerState[],
  now: number
): PlayerState | null {
  const eye = eyePos(bot)
  let best: PlayerState | null = null
  let bestDistSq = Infinity

  for (const enemy of enemies) {
    if (!enemy.alive) continue
    const toTarget = sub(chestPos(enemy), eye)
    const dist = length(toTarget)
    if (dist < 1e-6) continue
    if (enemy.camoUntil > now && dist > BRAIN.CAMO_VISIBLE_DIST) continue

    const dir = scale(toTarget, 1 / dist)
    const hit = raycast(eye, dir, dist + 0.1, map.boxes, allPlayers, bot.id, true, now)
    if (hit.kind === 'player' && hit.playerId === enemy.id) {
      const dSq = dist * dist
      if (dSq < bestDistSq) {
        bestDistSq = dSq
        best = enemy
      }
    }
  }
  return best
}

function neutralInput(yaw: number, pitch: number): PlayerInput {
  return {
    seq: 0,
    dt: TICK_DT,
    yaw,
    pitch,
    forward: 0,
    strafe: 0,
    jump: false,
    fire: false,
    melee: false,
    grenade: false,
    equipment: false,
    swap: false,
  }
}

/**
 * Per-bot AI. Owns its own Navigator and its own seeded PRNG stream (never
 * touches the sim's rng -- that stays reserved for sim-side rolls per the
 * determinism contract). think() is called once per tick, before sim.tick(),
 * and its result is fed straight into sim.setInput.
 */
export class BotBrain {
  private readonly id: string
  private readonly difficulty: Difficulty
  private readonly rand: () => number
  private readonly navigator = new Navigator()

  private targetId: string | null = null
  private targetSince = 0
  private nextSwapAllowedAt = 0
  private lastGrenadeAt = -Infinity
  private lastGoalPos: Vec3 | null = null
  private patrolGoal: Vec3 | null = null
  private patrolSetAt = -Infinity

  constructor(id: string, difficulty: Difficulty, seed: number) {
    this.id = id
    this.difficulty = difficulty
    this.rand = mulberry32(seed)
  }

  think(sim: MatchSim, map: GameMap, role: Role, now: number): PlayerInput {
    const p = sim.players.get(this.id)
    if (!p) return neutralInput(0, 0)
    if (!p.alive) return neutralInput(p.yaw, p.pitch)

    const ourTeam = p.team
    const enemyTeam: Team = ourTeam === 0 ? 1 : 0
    const allPlayers = [...sim.players.values()]
    const enemies = allPlayers.filter((e) => e.team === enemyTeam)

    const visible = findVisibleTarget(p, enemies, map, allPlayers, now)
    if (visible) {
      if (this.targetId !== visible.id) {
        this.targetId = visible.id
        this.targetSince = now
      }
    } else {
      this.targetId = null
    }
    const canFire = visible !== null && (now - this.targetSince) * 1000 >= this.difficulty.reactionMs

    const goal = this.computeGoal(p, role, sim, map, ourTeam, enemyTeam, now)
    if (goal && (!this.lastGoalPos || distSq(goal, this.lastGoalPos) > BRAIN.GOAL_REFRESH_DIST * BRAIN.GOAL_REFRESH_DIST)) {
      this.navigator.setGoal(goal)
      this.lastGoalPos = { ...goal }
    }
    const steer = this.navigator.steer(p, map, now)
    const navYaw = steer.input.yaw ?? p.yaw
    const navForward = steer.input.forward ?? 0
    const navStrafe = steer.input.strafe ?? 0

    let yaw = navYaw
    let pitch = steer.input.pitch ?? p.pitch
    let fire = false
    let swap = false

    if (visible) {
      const dist = Math.sqrt(distSq(p.pos, visible.pos))
      const desiredSlot = this.desiredWeaponSlot(p, dist)
      if (desiredSlot !== p.activeWeapon && now >= this.nextSwapAllowedAt) {
        swap = true
        this.nextSwapAllowedAt = now + BRAIN.SWAP_INTERNAL_COOLDOWN
      }
      const aim = this.computeAim(p, visible, now)
      yaw = aim.yaw
      pitch = aim.pitch
      fire = canFire
    }

    let grenade = false
    const cluster = this.findGrenadeCluster(p, enemies, now)
    if (cluster) {
      grenade = true
      fire = false
      const aim = yawPitchTo(eyePos(p), cluster)
      yaw = aim.yaw
      pitch = Math.max(aim.pitch, 0.15)
      this.lastGrenadeAt = now
    }

    let equipment = false
    if (steer.wantGrapple && p.equipment === 'grapple') {
      equipment = true
      yaw = navYaw
      pitch = 0
      grenade = false
      fire = false
    } else if (p.equipment === 'repulsor' && this.shouldRepulse(p, sim, enemies)) {
      equipment = true
    } else if (p.equipment === 'camo' && role === 'runner' && this.nearEnemyFlagStand(p, map, enemyTeam)) {
      equipment = true
    }

    const { forward, strafe } = reprojectMovement(navYaw, navForward, navStrafe, yaw)

    return {
      seq: 0,
      dt: TICK_DT,
      yaw,
      pitch,
      forward,
      strafe,
      jump: steer.input.jump ?? false,
      fire,
      melee: false,
      grenade,
      equipment,
      swap,
    }
  }

  private computeGoal(
    p: PlayerState,
    role: Role,
    sim: MatchSim,
    map: GameMap,
    ourTeam: Team,
    enemyTeam: Team,
    now: number
  ): Vec3 | null {
    // A flag carrier must run it home regardless of assigned role -- roles
    // are re-scored on a 2s cadence (and on flag events) with no memory of
    // "this bot is mid-return," so a carrier reassigned away from 'runner'
    // (e.g. to 'defender') would otherwise wander to a patrol-jitter point
    // up to DEFENDER_PATROL_RADIUS off the exact flag stand -- well outside
    // CAPTURE_RADIUS, so the flag would never actually get turned in.
    if (p.carryingFlag !== null) return map.flagStands[ourTeam]

    switch (role) {
      case 'runner': {
        const enemyFlag = sim.flags[enemyTeam]
        if (enemyFlag.state === 'carried') return map.flagStands[enemyTeam]
        return enemyFlag.pos
      }
      case 'escort': {
        const enemyFlag = sim.flags[enemyTeam]
        if (enemyFlag.state === 'carried' && enemyFlag.carrierId) {
          const carrier = sim.players.get(enemyFlag.carrierId)
          if (carrier) {
            const behind = scale(forwardVecOf(carrier.yaw), -BRAIN.ESCORT_FOLLOW_DIST)
            return add(carrier.pos, behind)
          }
        }
        return map.flagStands[ourTeam]
      }
      case 'hunter': {
        const ourFlag = sim.flags[ourTeam]
        if (ourFlag.state === 'carried' && ourFlag.carrierId) {
          const carrier = sim.players.get(ourFlag.carrierId)
          if (carrier) return carrier.pos
        }
        return map.flagStands[ourTeam]
      }
      case 'defender': {
        if (!this.patrolGoal || now - this.patrolSetAt >= BRAIN.DEFENDER_PATROL_RESET_INTERVAL) {
          const stand = map.flagStands[ourTeam]
          const angle = this.rand() * Math.PI * 2
          const r = this.rand() * BRAIN.DEFENDER_PATROL_RADIUS
          this.patrolGoal = { x: stand.x + Math.cos(angle) * r, y: stand.y, z: stand.z + Math.sin(angle) * r }
          this.patrolSetAt = now
        }
        return this.patrolGoal
      }
    }
  }

  private desiredWeaponSlot(p: PlayerState, dist: number): 0 | 1 {
    const score0 = weaponRangeScore(p.weapons[0], dist)
    const score1 = weaponRangeScore(p.weapons[1], dist)
    if (score0 === score1) return p.activeWeapon
    return score0 > score1 ? 0 : 1
  }

  private computeAim(p: PlayerState, target: PlayerState, now: number): { yaw: number; pitch: number } {
    const base = yawPitchTo(eyePos(p), chestPos(target))
    const continuousSec = now - this.targetSince
    const errorDeg =
      continuousSec >= BRAIN.AIM_ERROR_HALF_LIFE ? this.difficulty.aimErrorDeg / 2 : this.difficulty.aimErrorDeg
    const errorRad = (errorDeg * Math.PI) / 180
    return {
      yaw: base.yaw + gaussian(this.rand) * errorRad,
      pitch: base.pitch + gaussian(this.rand) * errorRad,
    }
  }

  private findGrenadeCluster(p: PlayerState, enemies: PlayerState[], now: number): Vec3 | null {
    if (now - this.lastGrenadeAt < BRAIN.GRENADE_BOT_COOLDOWN) return null
    if (p.grenades.frag <= 0 && p.grenades.mag <= 0) return null

    const alive = enemies.filter((e) => e.alive)
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        if (distSq(alive[i].pos, alive[j].pos) > BRAIN.GRENADE_CLUMP_DIST * BRAIN.GRENADE_CLUMP_DIST) continue
        const mid: Vec3 = {
          x: (alive[i].pos.x + alive[j].pos.x) / 2,
          y: (alive[i].pos.y + alive[j].pos.y) / 2,
          z: (alive[i].pos.z + alive[j].pos.z) / 2,
        }
        const dSq = distSq(p.pos, mid)
        if (dSq >= BRAIN.GRENADE_MIN_RANGE * BRAIN.GRENADE_MIN_RANGE && dSq <= BRAIN.GRENADE_MAX_RANGE * BRAIN.GRENADE_MAX_RANGE) {
          return mid
        }
      }
    }
    return null
  }

  private shouldRepulse(p: PlayerState, sim: MatchSim, enemies: PlayerState[]): boolean {
    for (const pr of sim.projectiles) {
      if (pr.kind !== 'boomtube' || pr.team === p.team) continue
      const toBot = sub(p.pos, pr.pos)
      const dist = length(toBot)
      if (dist >= BRAIN.REPULSOR_TRIGGER_DIST || length(pr.vel) < 1e-6) continue
      if (dot(normalize(pr.vel), normalize(toBot)) > 0.3) return true
    }
    for (const e of enemies) {
      if (!e.alive || e.weapons[e.activeWeapon] !== 'arc_blade') continue
      if (length(sub(e.pos, p.pos)) <= BRAIN.REPULSOR_TRIGGER_DIST) return true
    }
    return false
  }

  private nearEnemyFlagStand(p: PlayerState, map: GameMap, enemyTeam: Team): boolean {
    return length(sub(p.pos, map.flagStands[enemyTeam])) <= BRAIN.CAMO_GRAB_DIST
  }
}
