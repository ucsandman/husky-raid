import type { Vec3, PlayerState, PlayerInput, Team, WeaponId, EquipmentId } from './types'
import type { GameMap } from './map'
import { MAPS } from './maps'
import { add, sub, scale, dot, cross, normalize, length, distSq } from './math'
import { stepMovement, viewDir } from './physics'
import {
  applyDamage,
  tickShield,
  raycast,
  stepProjectile,
  explode,
  checkSwarmPop,
  type Projectile,
} from './combat'
import { WEAPONS, rollLoadout, ONE_HIT_KILL_DAMAGE } from './weapons'
import { mulberry32 } from './rng'
import {
  TICK_DT,
  MAX_SHIELD,
  MAX_HEALTH,
  EYE_HEIGHT,
  MELEE_DAMAGE,
  MELEE_RANGE,
  MELEE_COOLDOWN,
  MELEE_VIEW_CONE,
  RESPAWN_DELAY,
  FLAG_RETURN_TIME,
  FLAG_PICKUP_RADIUS,
  CAPTURE_RADIUS,
  CAPTURES_TO_WIN,
  MATCH_TIME,
  CAMO_DURATION,
  GRAPPLE_RANGE,
  GRAPPLE_CHARGES,
  GRAPPLE_COOLDOWN,
  GRAPPLE_MAX_SPEED,
  REPULSOR_CHARGES,
  REPULSOR_RADIUS,
  REPULSOR_IMPULSE,
  REPULSOR_COOLDOWN,
  GRENADE_THROW_SPEED,
  FRAG_DAMAGE,
  FRAG_RADIUS,
  FRAG_FUSE,
  MAG_DAMAGE,
  MAG_RADIUS,
  MAG_FUSE,
  SWARM_POP_DAMAGE,
  SPAWN_CROWD_RADIUS,
  PROJECTILE_LIFETIME,
  GRENADE_COOLDOWN,
  HITSCAN_MAX_RANGE,
  DEFAULT_PROJECTILE_SPEED,
  SWAP_COOLDOWN,
  RELOAD_TIME,
  HOMING_CONE_ANGLE,
  MELEE_LUNGE_SPEED,
  BACKSMACK_VIEW_CONE,
  ADS_SPREAD_MULT,
} from './constants'

export interface FlagState {
  state: 'stand' | 'carried' | 'dropped'
  pos: Vec3
  carrierId?: string
  droppedAt?: number
}

export type SimEvent =
  /** `streak` is the killer's kills-since-last-death AFTER this kill, so the
   * client can bark sprees without keeping its own tally (which prediction
   * would fabricate). Optional, matching the sprint/slideRequest precedent:
   * hand-built events in older tests omit it and stay valid. 0 for a
   * self-kill, which is never a spree. */
  | { type: 'kill'; killerId: string; victimId: string; weapon: string; head: boolean; streak?: number }
  | { type: 'capture'; playerId: string; team: Team }
  | { type: 'flag_taken' | 'flag_dropped' | 'flag_returned'; team: Team; playerId?: string }
  | { type: 'shot'; playerId: string; weapon: WeaponId }
  | { type: 'explosion'; pos: Vec3 }
  | { type: 'match_end'; winner: Team | null }

function defaultInput(p: PlayerState): PlayerInput {
  return {
    seq: 0,
    dt: TICK_DT,
    yaw: p.yaw,
    pitch: p.pitch,
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

function eyePos(p: PlayerState): Vec3 {
  return { x: p.pos.x, y: p.pos.y + EYE_HEIGHT, z: p.pos.z }
}

/**
 * Jitters `dir` by a random angle up to `spread` radians off-axis, using
 * the sim's own PRNG stream (sim.nextRand()) so pellet spread stays
 * deterministic under a given seed + input script. spread<=0 returns dir
 * unchanged (no rand consumed, e.g. equipment aiming never jitters).
 */
function jitterDir(dir: Vec3, spread: number, sim: MatchSim): Vec3 {
  if (spread <= 0) return dir
  const worldRef: Vec3 = Math.abs(dir.y) > 0.999 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  const right = normalize(cross(dir, worldRef))
  const up = cross(right, dir)
  const angle = sim.nextRand() * spread
  const rot = sim.nextRand() * Math.PI * 2
  const s = Math.sin(angle)
  const offset = add(scale(right, Math.cos(rot) * s), scale(up, Math.sin(rot) * s))
  return normalize(add(scale(dir, Math.cos(angle)), offset))
}

function equipmentChargesFor(eq: EquipmentId | null): number {
  if (eq === 'grapple') return GRAPPLE_CHARGES
  if (eq === 'repulsor') return REPULSOR_CHARGES
  if (eq === 'camo') return 1
  return 0
}

/**
 * MatchSim: the deterministic CTF simulation. Both the server (authority)
 * and the client (prediction/replay) drive the exact same tick() function,
 * so it must be a pure function of (current state, inputs, now) — no
 * Math.random, no Date.now, no non-deterministic Map/Set iteration.
 *
 * tick() order, in one pass per call:
 *   1. respawns due
 *   2. per player: movement -> fire -> grenade throw -> equipment
 *   3. projectiles step + explosions
 *   4. shield recharge
 *   5. flags (pickup / instant return / auto-return / capture)
 *   6. timers (match end)
 */
export class MatchSim {
  map: GameMap
  players: Map<string, PlayerState> = new Map()
  projectiles: Projectile[] = []
  flags: [FlagState, FlagState]
  scores: [number, number] = [0, 0]
  timeLeft: number = MATCH_TIME
  phase: 'playing' | 'ended' = 'playing'

  private rand: () => number
  private inputs: Map<string, PlayerInput> = new Map()
  private lastGroundedPos: Map<string, Vec3> = new Map()
  private nextProjectileId = 0
  private now = 0
  /** Events produced outside tick() (currently just removePlayer's forced
   * flag return) — flushed into the next tick()'s returned events so the
   * stream stays a complete transition log. */
  private pendingEvents: SimEvent[] = []

  constructor(mapName: string, seed: number) {
    const map = MAPS[mapName]
    if (!map) throw new Error(`unknown map: ${mapName}`)
    this.map = map
    this.rand = mulberry32(seed)
    this.flags = [
      { state: 'stand', pos: { ...map.flagStands[0] } },
      { state: 'stand', pos: { ...map.flagStands[1] } },
    ]
  }

  addPlayer(id: string, name: string, team: Team, bot: boolean): PlayerState {
    const loadout = rollLoadout(this.rand)
    const spawn = this.leastCrowdedSpawn(team)
    const p: PlayerState = {
      id,
      name,
      team,
      bot,
      pos: { ...spawn },
      vel: { x: 0, y: 0, z: 0 },
      yaw: this.map.spawnYaw[team],
      pitch: 0,
      grounded: true,
      shield: MAX_SHIELD,
      health: MAX_HEALTH,
      alive: true,
      respawnAt: 0,
      lastDamageAt: 0,
      weapons: loadout.weapons,
      activeWeapon: 0,
      ammo: [WEAPONS[loadout.weapons[0]].magSize, WEAPONS[loadout.weapons[1]].magSize],
      cooldownUntil: 0,
      grenadeCooldownUntil: 0,
      grenades: loadout.grenades,
      equipment: loadout.equipment,
      equipmentCharges: equipmentChargesFor(loadout.equipment),
      equipmentCooldownUntil: 0,
      swapCooldownUntil: 0,
      meleeCooldownUntil: 0,
      camoUntil: 0,
      carryingFlag: null,
      stuckDarts: 0,
      kills: 0,
      deaths: 0,
      captures: 0,
      teleportCooldownUntil: 0,
      sprinting: false,
      sliding: false,
      slideTimeRemaining: 0,
      slideCooldownRemaining: 0,
      coyoteTimeRemaining: 0,
      jumpBufferRemaining: 0,
      scoped: false,
    }
    this.players.set(id, p)
    this.lastGroundedPos.set(id, { ...spawn })
    return p
  }

  removePlayer(id: string): void {
    const p = this.players.get(id)
    if (p && p.carryingFlag !== null) {
      const flagTeam = p.carryingFlag
      const flag = this.flags[flagTeam]
      flag.state = 'stand'
      flag.pos = { ...this.map.flagStands[flagTeam] }
      flag.carrierId = undefined
      flag.droppedAt = undefined
      // This runs outside tick(), so the event can't be returned directly —
      // buffer it and flush at the top of the next tick() (see tick()).
      this.pendingEvents.push({ type: 'flag_returned', team: flagTeam, playerId: id })
    }
    this.players.delete(id)
    this.inputs.delete(id)
    this.lastGroundedPos.delete(id)
  }

  setInput(id: string, input: PlayerInput): void {
    this.inputs.set(id, input)
  }

  /** Not part of the public API surface documented in the task brief, but
   * left accessible so stepFire/stepGrenade (module-private free functions
   * below) can allocate projectile ids. */
  nextId(): number {
    return this.nextProjectileId++
  }

  /** Not part of the public API surface documented in the task brief, but
   * left accessible so stepFire's pellet-spread jitter (jitterDir, a
   * module-private free function below) can consume the sim's own PRNG
   * stream and stay deterministic under a given seed + input script. */
  nextRand(): number {
    return this.rand()
  }

  /**
   * Test-only hook: applies damage at the sim's current time (the `now`
   * from the most recent tick()), running the same death bookkeeping a
   * combat kill would (respawn timer, flag drop). Returns any events the
   * death produced (e.g. flag_dropped) since it runs outside tick().
   */
  damage(id: string, amount: number): SimEvent[] {
    const p = this.players.get(id)
    if (!p) return []
    const events: SimEvent[] = []
    const result = applyDamage(p, amount, this.now)
    if (result === 'killed') {
      this.killPlayer(p, this.now, null, 'test', { ...p.pos }, events)
    }
    return events
  }

  /**
   * Fixed-timestep contract: callers MUST call tick() at fixed TICK_DT
   * intervals, with `now` advancing by exactly TICK_DT each call (e.g.
   * `now += TICK_DT` every call, starting from any base). Every cooldown/
   * respawn/fuse/timer field in this sim is compared against `now`
   * directly (no internal delta tracking), so a skipped tick or an
   * irregular `now` step desyncs cooldown math and breaks the server/
   * client determinism guarantee this class exists for.
   */
  tick(now: number): SimEvent[] {
    if (this.phase === 'ended') return []
    this.now = now
    const events: SimEvent[] = [...this.pendingEvents]
    this.pendingEvents = []
    const dt = TICK_DT

    // 1. respawns due
    for (const p of this.players.values()) {
      if (!p.alive && now >= p.respawnAt) {
        this.respawnPlayer(p)
      }
    }

    // 2. per player: movement -> fire -> grenade -> equipment
    for (const p of this.players.values()) {
      if (!p.alive) continue
      const input = this.inputs.get(p.id) ?? defaultInput(p)

      if (p.grounded) this.lastGroundedPos.set(p.id, { ...p.pos })

      // p.scoped is set inside stepMovement itself (mirrors p.sprinting) --
      // by the time stepFire runs below, it already reflects this tick's
      // input.ads and is ready for stepFire's own ADS_SPREAD_MULT read.
      const moveResult = stepMovement(p, input, this.map, dt)
      if (moveResult === 'fell') {
        const dropPos = this.lastGroundedPos.get(p.id) ?? { ...p.pos }
        this.killPlayer(p, now, null, 'fall', dropPos, events)
        continue
      }

      stepFire(this, p, input, now, events)
      stepGrenade(this, p, input, now)
      stepEquipment(this, p, input, now)
    }

    // 3. projectiles step + explosions. frag/mag already self-detonate at
    // their FRAG_FUSE/MAG_FUSE via stepProjectile's own fuseAt check, so
    // they always come back exploded here. boomtube/ion_charge/swarm_dart
    // only explode on contact — stepProjectile never looks at their
    // fuseAt — so without an explicit check here they'd fly forever if
    // they never hit anything, leaking projectiles indefinitely. We cap
    // them at PROJECTILE_LIFETIME: boomtube/ion_charge detonate in place
    // at timeout (they're contact weapons that still deal splash/direct
    // damage), swarm_dart just vanishes (it only ever damages on a stick).
    this.projectiles = this.projectiles.filter((pr) => {
      const result = stepProjectile(pr, [...this.players.values()], this.map.boxes, dt, now)
      if (result.exploded) {
        explodeProjectile(this, pr, result.hitPlayerId, now, events)
        return false
      }
      if (now >= pr.fuseAt) {
        if (pr.kind === 'boomtube' || pr.kind === 'ion_charge') {
          explodeProjectile(this, pr, undefined, now, events)
        }
        return false
      }
      return true
    })

    // 4. shield recharge
    for (const p of this.players.values()) {
      if (p.alive) tickShield(p, now, dt)
    }

    // 5. flags
    stepFlags(this, now, events)

    // 6. timers
    this.timeLeft = Math.max(0, this.timeLeft - dt)
    if (this.scores[0] >= CAPTURES_TO_WIN || this.scores[1] >= CAPTURES_TO_WIN || this.timeLeft <= 0) {
      this.phase = 'ended'
      const winner: Team | null =
        this.scores[0] === this.scores[1] ? null : this.scores[0] > this.scores[1] ? 0 : 1
      events.push({ type: 'match_end', winner })
    }

    return events
  }

  /** Not part of the public API surface documented in the task brief, but
   * left accessible (no `private`) so stepFire/stepFlags/stepEquipment
   * (module-private free functions below) can call it directly. */
  killPlayer(
    victim: PlayerState,
    now: number,
    killerId: string | null,
    weapon: string,
    dropPos: Vec3,
    events: SimEvent[],
    head = false
  ): void {
    victim.alive = false
    victim.deaths += 1
    victim.respawnAt = now + RESPAWN_DELAY
    const finalKillerId = killerId ?? victim.id
    let streak = 0
    if (killerId && killerId !== victim.id) {
      const killer = this.players.get(killerId)
      if (killer) {
        killer.kills += 1
        streak = (killer.spree ?? 0) + 1
        killer.spree = streak
      }
    }
    // The victim's own spree ends here, in the same function that starts
    // one -- otherwise a spree only ever ends at respawn and a player who
    // stays dead keeps a live counter.
    victim.spree = 0
    events.push({ type: 'kill', killerId: finalKillerId, victimId: victim.id, weapon, head, streak })
    if (victim.carryingFlag !== null) {
      const flagTeam = victim.carryingFlag
      victim.carryingFlag = null
      const flag = this.flags[flagTeam]
      flag.state = 'dropped'
      flag.pos = { ...dropPos }
      flag.carrierId = undefined
      flag.droppedAt = now
      events.push({ type: 'flag_dropped', team: flagTeam, playerId: victim.id })
    }
  }

  private respawnPlayer(p: PlayerState): void {
    const loadout = rollLoadout(this.rand)
    const spawn = this.leastCrowdedSpawn(p.team)
    p.pos = { ...spawn }
    p.vel = { x: 0, y: 0, z: 0 }
    p.yaw = this.map.spawnYaw[p.team]
    p.pitch = 0
    p.grounded = true
    p.shield = MAX_SHIELD
    p.health = MAX_HEALTH
    p.alive = true
    p.weapons = loadout.weapons
    p.activeWeapon = 0
    p.ammo = [WEAPONS[loadout.weapons[0]].magSize, WEAPONS[loadout.weapons[1]].magSize]
    p.cooldownUntil = 0
    p.grenadeCooldownUntil = 0
    p.grenades = loadout.grenades
    p.equipment = loadout.equipment
    p.equipmentCharges = equipmentChargesFor(loadout.equipment)
    p.equipmentCooldownUntil = 0
    p.swapCooldownUntil = 0
    p.meleeCooldownUntil = 0
    p.camoUntil = 0
    p.stuckDarts = 0
    p.teleportCooldownUntil = 0
    p.sprinting = false
    p.sliding = false
    p.slideTimeRemaining = 0
    p.slideCooldownRemaining = 0
    p.coyoteTimeRemaining = 0
    p.jumpBufferRemaining = 0
    p.scoped = false
    this.lastGroundedPos.set(p.id, { ...spawn })
  }

  private leastCrowdedSpawn(team: Team): Vec3 {
    const spawns = this.map.spawns[team]
    const alive = [...this.players.values()].filter((p) => p.alive)
    let best = spawns[0]
    let bestCount = Infinity
    for (const spawn of spawns) {
      let count = 0
      for (const p of alive) {
        if (distSq(p.pos, spawn) < SPAWN_CROWD_RADIUS * SPAWN_CROWD_RADIUS) count++
      }
      if (count < bestCount) {
        bestCount = count
        best = spawn
      }
    }
    return { ...best }
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers (not exported).
// ---------------------------------------------------------------------------

/**
 * Nearest living enemy within a ~30deg forward cone of `dir`, or undefined
 * if none qualify. Iterates sim.players in Map insertion order so target
 * acquisition stays deterministic under a given seed + input script.
 */
function findHomingTarget(sim: MatchSim, shooter: PlayerState, dir: Vec3): string | undefined {
  const cosHalfCone = Math.cos(HOMING_CONE_ANGLE)
  let bestId: string | undefined
  let bestDist = Infinity
  for (const target of sim.players.values()) {
    if (target.id === shooter.id || target.team === shooter.team || !target.alive) continue
    const toTarget = sub(target.pos, shooter.pos)
    const dist = length(toTarget)
    if (dist < 1e-6) continue
    const cosAngle = dot(dir, scale(toTarget, 1 / dist))
    if (cosAngle < cosHalfCone) continue
    if (dist < bestDist) {
      bestDist = dist
      bestId = target.id
    }
  }
  return bestId
}

function projectileKindForWeapon(id: WeaponId): Projectile['kind'] | null {
  switch (id) {
    case 'boomtube':
      return 'boomtube'
    case 'swarm_pod':
      return 'swarm_dart'
    case 'ion_charger':
      return 'ion_charge'
    default:
      return null
  }
}

function weaponIdForProjectileKind(kind: Projectile['kind']): string {
  switch (kind) {
    case 'boomtube':
      return 'boomtube'
    case 'swarm_dart':
      return 'swarm_pod'
    case 'ion_charge':
      return 'ion_charger'
    case 'frag':
      return 'frag'
    case 'mag':
      return 'mag'
  }
}

function doMeleeAttack(
  sim: MatchSim,
  attacker: PlayerState,
  range: number,
  damage: number,
  weapon: string,
  now: number,
  events: SimEvent[]
): void {
  // Melee cone is computed against flat (pitch-ignored) forward -- intentional for v1.
  const forward = viewDir(attacker.yaw, 0)
  const cosHalfCone = Math.cos(MELEE_VIEW_CONE / 2)
  let best: PlayerState | null = null
  let bestDist = Infinity

  for (const target of sim.players.values()) {
    if (target.id === attacker.id || !target.alive) continue
    const toTarget = sub(target.pos, attacker.pos)
    const dist = length(toTarget)
    if (dist > range || dist < 1e-6) continue
    const cosAngle = dot(forward, normalize(toTarget))
    if (cosAngle < cosHalfCone) continue
    if (dist < bestDist) {
      bestDist = dist
      best = target
    }
  }

  if (!best) return
  // Melee lunge: horizontal-only nudge toward the target, grounded only,
  // vel.y left untouched (no free height from meleeing an airborne target).
  if (attacker.grounded) {
    const d = sub(best.pos, attacker.pos)
    const h = Math.hypot(d.x, d.z)
    if (h > 1e-6) {
      attacker.vel = { x: (d.x / h) * MELEE_LUNGE_SPEED, y: attacker.vel.y, z: (d.z / h) * MELEE_LUNGE_SPEED }
    }
  }
  // Backsmack: a beatdown landed inside the target's own rear arc kills
  // outright, as in Halo. Measured against the TARGET's facing, not the
  // attacker's -- a target that turns to face its attacker in time has
  // defended itself, which is what makes the flank a read rather than a
  // damage bonus. Power-melee weapons already deal ONE_HIT_KILL_DAMAGE, so
  // this is a no-op for them rather than a special case.
  const toAttacker = sub(attacker.pos, best.pos)
  const hAttacker = Math.hypot(toAttacker.x, toAttacker.z)
  let effectiveDamage = damage
  let effectiveWeapon = weapon
  if (hAttacker > 1e-6) {
    const targetForward = viewDir(best.yaw, 0)
    const behindness = -dot(targetForward, {
      x: toAttacker.x / hAttacker,
      y: 0,
      z: toAttacker.z / hAttacker,
    })
    if (behindness >= Math.cos(BACKSMACK_VIEW_CONE / 2)) {
      effectiveDamage = ONE_HIT_KILL_DAMAGE
      // Reported as its own weapon so the kill feed, the kill sound and the
      // announcer can all tell a backsmack from a normal beatdown without a
      // new SimEvent field. `weapon` on the kill event is already `string`.
      effectiveWeapon = 'backsmack'
    }
  }
  // best was filtered to target.alive above, so applyDamage always starts
  // from a live target -- no need to snapshot "was alive" before checking.
  applyDamage(best, effectiveDamage, now)
  if (!best.alive) {
    sim.killPlayer(best, now, attacker.id, effectiveWeapon, { ...best.pos }, events)
  }
}

/** Fire handling: weapon-slot swap on its own cooldown, then fire itself
 * rate-limited by cooldownUntil. Melee/power-melee resolve in a view
 * cone; hitscan/burst cast one jittered raycast per pellet; projectile/
 * charge weapons spawn a Projectile stepped in phase 3. */
function stepFire(sim: MatchSim, p: PlayerState, input: PlayerInput, now: number, events: SimEvent[]): void {
  if (input.swap && now >= p.swapCooldownUntil) {
    p.activeWeapon = p.activeWeapon === 0 ? 1 : 0
    p.swapCooldownUntil = now + SWAP_COOLDOWN
  }

  // Melee runs on its OWN cooldown, ahead of and independent of the weapon's
  // rate-of-fire and reload lockouts. Sharing cooldownUntil meant an empty
  // magazine left the player with no action at all for RELOAD_TIME, which is
  // the worst possible moment to be disarmed. Flag carriers can still melee
  // (spec §2) -- only shooting is denied them, below.
  if (input.melee) {
    if (now >= p.meleeCooldownUntil) {
      doMeleeAttack(sim, p, MELEE_RANGE, MELEE_DAMAGE, 'melee', now, events)
      p.meleeCooldownUntil = now + MELEE_COOLDOWN
    }
    return
  }

  if (now < p.cooldownUntil) return

  // Reload completes here rather than at the instant the mag ran dry, so the
  // magazine the HUD shows is the magazine the gun actually has. Refilling on
  // the emptying shot (as this used to) displayed a FULL mag through the whole
  // RELOAD_TIME lockout, which reads as "the gun just won't shoot".
  if (p.ammo[p.activeWeapon] <= 0) {
    p.ammo[p.activeWeapon] = WEAPONS[p.weapons[p.activeWeapon]].magSize
  }

  // Flag carrier cannot shoot (spec §2).
  if (p.carryingFlag !== null) return

  if (!input.fire) return

  const weaponId = p.weapons[p.activeWeapon]
  const weapon = WEAPONS[weaponId]

  if (weapon.kind === 'power_melee') {
    doMeleeAttack(sim, p, weapon.lungeRange ?? MELEE_RANGE, weapon.damage, weaponId, now, events)
    // Bug fix (diagnosis-confirmed): this branch returned before the 'shot'
    // event below, so arc_blade/grav_maul dealt real damage but the client
    // never got the event it gates ALL fire feedback on (sound/kick/hit-
    // marker) -- looked exactly like "the gun did nothing" for that weapon.
    events.push({ type: 'shot', playerId: p.id, weapon: weaponId })
    p.cooldownUntil = now + 1 / weapon.rof
    return
  }

  // Ammo/reload: the shot that empties the mag still fires, then the weapon
  // locks out for RELOAD_TIME instead of the usual 1/rof. Ammo stays at 0 for
  // that whole window and is refilled by the reload-completion branch at the
  // top of this function, so the HUD can show an empty mag while it lasts.
  // Power-melee weapons never reach here (returned above), matching the
  // "power melee exempt from reload" ruling with no extra branching.
  p.ammo[p.activeWeapon] -= 1
  if (p.ammo[p.activeWeapon] <= 0) {
    p.cooldownUntil = now + RELOAD_TIME
  } else {
    p.cooldownUntil = now + 1 / weapon.rof
  }
  events.push({ type: 'shot', playerId: p.id, weapon: weaponId })
  // Camo breaks on a committed shot (spec §3), not on melee/power-melee/swap/blocked fire.
  p.camoUntil = 0

  const eye = eyePos(p)
  const dir = viewDir(p.yaw, p.pitch)

  if (weapon.kind === 'hitscan' || weapon.kind === 'burst') {
    const maxRange = weapon.maxRange ?? HITSCAN_MAX_RANGE
    // ADS: scoping meaningfully tightens the cone (spec: "a scope that
    // doesn't improve accuracy is a lie"). Single point WeaponDef.spread is
    // consumed for hitscan/burst weapons -- see jitterDir below.
    const spread = p.scoped ? weapon.spread * ADS_SPREAD_MULT : weapon.spread
    const playersArr = [...sim.players.values()]
    for (let i = 0; i < weapon.pellets; i++) {
      const pelletDir = jitterDir(dir, spread, sim)
      const hit = raycast(eye, pelletDir, maxRange, sim.map.boxes, playersArr, p.id)
      if (hit.kind === 'player' && hit.playerId) {
        const target = sim.players.get(hit.playerId)
        if (target && target.alive) {
          // Halo's two-stage kill: the headshot multiplier only pays out
          // once the shield is already down. Read before applyDamage, so a
          // multi-pellet burst can strip the shield with pellet 1 and have
          // pellet 2 land the multiplied finisher inside one trigger pull.
          const mult = hit.head && target.shield <= 0 ? weapon.headshotMult : 1
          applyDamage(target, weapon.damage * mult, now)
          if (!target.alive) {
            sim.killPlayer(target, now, p.id, weaponId, { ...target.pos }, events, !!hit.head)
          }
        }
      }
    }
    return
  }

  const kind = projectileKindForWeapon(weaponId)
  if (kind) {
    const projectile: Projectile = {
      id: sim.nextId(),
      kind,
      pos: eye,
      vel: scale(dir, weapon.projectileSpeed ?? DEFAULT_PROJECTILE_SPEED),
      ownerId: p.id,
      team: p.team,
      fuseAt: now + PROJECTILE_LIFETIME,
    }
    if (weapon.homing) {
      const targetId = findHomingTarget(sim, p, dir)
      if (targetId) projectile.homingTargetId = targetId
    }
    sim.projectiles.push(projectile)
  }
}

function stepGrenade(sim: MatchSim, p: PlayerState, input: PlayerInput, now: number): void {
  if (!input.grenade) return
  if (now < p.grenadeCooldownUntil) return
  let kind: 'frag' | 'mag' | null = null
  if (p.grenades.frag > 0) kind = 'frag'
  else if (p.grenades.mag > 0) kind = 'mag'
  if (!kind) return

  p.grenades[kind] -= 1
  p.grenadeCooldownUntil = now + GRENADE_COOLDOWN
  const eye = eyePos(p)
  const dir = viewDir(p.yaw, p.pitch)
  sim.projectiles.push({
    id: sim.nextId(),
    kind,
    pos: eye,
    vel: scale(dir, GRENADE_THROW_SPEED),
    ownerId: p.id,
    team: p.team,
    fuseAt: now + (kind === 'frag' ? FRAG_FUSE : MAG_FUSE),
  })
}

function stepEquipment(sim: MatchSim, p: PlayerState, input: PlayerInput, now: number): void {
  if (!input.equipment || !p.equipment) return
  if (now < p.equipmentCooldownUntil) return

  if (p.equipmentCharges <= 0) return

  if (p.equipment === 'camo') {
    p.camoUntil = now + CAMO_DURATION
    p.equipmentCooldownUntil = now + CAMO_DURATION
    p.equipmentCharges -= 1
    return
  }

  if (p.equipment === 'grapple') {
    const eye = eyePos(p)
    const dir = viewDir(p.yaw, p.pitch)
    const hit = raycast(eye, dir, GRAPPLE_RANGE, sim.map.boxes, [...sim.players.values()], p.id)
    if (hit.kind === 'none') return
    const impulseSpeed = Math.min(hit.dist / TICK_DT, GRAPPLE_MAX_SPEED)
    p.vel = scale(dir, impulseSpeed)
    p.equipmentCharges -= 1
    p.equipmentCooldownUntil = now + GRAPPLE_COOLDOWN
    return
  }

  if (p.equipment === 'repulsor') {
    for (const target of sim.players.values()) {
      if (target.id === p.id || !target.alive) continue
      const toTarget = sub(target.pos, p.pos)
      const dist = length(toTarget)
      if (dist >= REPULSOR_RADIUS || dist < 1e-6) continue
      const falloff = 1 - dist / REPULSOR_RADIUS
      target.vel = add(target.vel, scale(normalize(toTarget), REPULSOR_IMPULSE * falloff))
    }
    for (const pr of sim.projectiles) {
      const toPr = sub(pr.pos, p.pos)
      const dist = length(toPr)
      if (dist >= REPULSOR_RADIUS || dist < 1e-6) continue
      const falloff = 1 - dist / REPULSOR_RADIUS
      pr.vel = add(pr.vel, scale(normalize(toPr), REPULSOR_IMPULSE * falloff))
    }
    p.equipmentCharges -= 1
    p.equipmentCooldownUntil = now + REPULSOR_COOLDOWN
  }
}

function explodeProjectile(
  sim: MatchSim,
  pr: Projectile,
  hitPlayerId: string | undefined,
  now: number,
  events: SimEvent[]
): void {
  events.push({ type: 'explosion', pos: { ...pr.pos } })
  const playersArr = [...sim.players.values()]
  const aliveBefore = new Map(playersArr.map((p) => [p.id, p.alive]))

  switch (pr.kind) {
    case 'swarm_dart': {
      if (hitPlayerId) {
        const target = sim.players.get(hitPlayerId)
        if (target && target.alive) {
          applyDamage(target, WEAPONS.swarm_pod.damage, now)
          if (checkSwarmPop(target, now)) applyDamage(target, SWARM_POP_DAMAGE, now)
        }
      }
      break
    }
    case 'ion_charge': {
      if (hitPlayerId) {
        const target = sim.players.get(hitPlayerId)
        if (target && target.alive) applyDamage(target, WEAPONS.ion_charger.damage, now)
      }
      break
    }
    case 'boomtube':
      explode(pr.pos, WEAPONS.boomtube.damage, WEAPONS.boomtube.splashRadius ?? 0, playersArr, now)
      break
    case 'frag':
      explode(pr.pos, FRAG_DAMAGE, FRAG_RADIUS, playersArr, now)
      break
    case 'mag':
      explode(pr.pos, MAG_DAMAGE, MAG_RADIUS, playersArr, now)
      break
  }

  for (const p of playersArr) {
    if (aliveBefore.get(p.id) && !p.alive) {
      sim.killPlayer(p, now, pr.ownerId, weaponIdForProjectileKind(pr.kind), { ...p.pos }, events)
    }
  }
}

function returnFlagHome(sim: MatchSim, flagTeam: Team, now: number, events: SimEvent[], playerId?: string): void {
  const flag = sim.flags[flagTeam]
  flag.state = 'stand'
  flag.pos = { ...sim.map.flagStands[flagTeam] }
  flag.carrierId = undefined
  flag.droppedAt = undefined
  events.push({ type: 'flag_returned', team: flagTeam, playerId })
}

/** Flag rules: pickup on 1.5m touch by an enemy (from stand or ground),
 * instant return on touch by the flag's own team while dropped, timed
 * auto-return, capture when the carrier is within 2m of their own stand. */
function stepFlags(sim: MatchSim, now: number, events: SimEvent[]): void {
  const playersArr = [...sim.players.values()]

  for (const flagTeam of [0, 1] as const) {
    const flag = sim.flags[flagTeam]
    const homePos = sim.map.flagStands[flagTeam]

    if (flag.state === 'carried' && flag.carrierId) {
      const carrier = sim.players.get(flag.carrierId)
      if (!carrier) {
        // Dangling reference (carrier no longer exists, e.g. removed via a
        // path that didn't clean up the flag) -- self-heal instead of
        // leaving the flag stuck in 'carried' limbo forever.
        returnFlagHome(sim, flagTeam, now, events)
        continue
      }
      flag.pos = { ...carrier.pos }
      if (length(sub(carrier.pos, sim.map.flagStands[carrier.team])) <= CAPTURE_RADIUS) {
        sim.scores[carrier.team] += 1
        carrier.captures += 1
        carrier.carryingFlag = null
        flag.state = 'stand'
        flag.pos = { ...homePos }
        flag.carrierId = undefined
        events.push({ type: 'capture', playerId: carrier.id, team: carrier.team })
      }
      continue
    }

    let pickedUp = false
    for (const p of playersArr) {
      if (!p.alive || p.team === flagTeam) continue
      if (length(sub(p.pos, flag.pos)) <= FLAG_PICKUP_RADIUS) {
        flag.state = 'carried'
        flag.carrierId = p.id
        flag.pos = { ...p.pos }
        flag.droppedAt = undefined
        p.carryingFlag = flagTeam
        events.push({ type: 'flag_taken', team: flagTeam, playerId: p.id })
        pickedUp = true
        break
      }
    }
    if (pickedUp) continue

    if (flag.state === 'dropped') {
      let returned = false
      for (const p of playersArr) {
        if (!p.alive || p.team !== flagTeam) continue
        if (length(sub(p.pos, flag.pos)) <= FLAG_PICKUP_RADIUS) {
          returnFlagHome(sim, flagTeam, now, events, p.id)
          returned = true
          break
        }
      }
      if (!returned && flag.droppedAt !== undefined && now - flag.droppedAt >= FLAG_RETURN_TIME) {
        returnFlagHome(sim, flagTeam, now, events)
      }
    }
  }
}
