import {
  MatchSim,
  toSnapPlayer,
  clamp,
  TICK_DT,
  TICK_RATE,
  SNAPSHOT_RATE,
  WARMUP_SEC,
  type PlayerInput,
  type PlayerState,
  type ServerMsg,
  type SimEvent,
  type SnapPlayer,
  type SnapProjectile,
  type MedalId,
  type Team,
} from '@riftlane/shared'
import { BotBrain, DEFAULT_DIFFICULTY, type Difficulty } from './bots/brain'
import { assignRoles, type Role } from './bots/roles'

const BOT_NAMES = ['VEX', 'TALON', 'RIVET', 'ONYX', 'JINX', 'MOSS', 'HALCYON-9', 'DITTO']

/** Bot roles are re-scored on this cadence, plus immediately on any flag event. */
const ROLE_REASSIGN_INTERVAL = 2

/** Sim-time gap the snapshot accumulator waits for between emits. TICK_RATE
 * (30Hz) and SNAPSHOT_RATE (20Hz) don't divide evenly, so this is tracked
 * as elapsed sim time rather than "every Nth tick" to stay drift-free. */
const SNAPSHOT_INTERVAL = 1 / SNAPSHOT_RATE

/** Same window the client HUD uses for its on-screen multikill banner, so
 * the medal and the banner can never disagree about the same kill chain. */
const MULTIKILL_WINDOW = 4.5

/** How long the tick loop keeps running (idle) after match_end before
 * stop() is called automatically, e.g. to leave room for a rematch vote. */
const MATCH_END_LINGER_MS = 20_000

/** Max catch-up ticks run in one timer fire when the wall clock has run
 * ahead (Windows timer coalescing fires the ~33ms timer late under load).
 * Bounds the burst of sim work a single late fire can trigger. */
const MAX_CATCHUP_TICKS = 5

/** Tick debt beyond which the scheduler forgives the backlog instead of
 * catching up (~1s: process suspend, debugger pause). Sim time simply
 * resumes from the current wall clock. */
const MAX_TICK_DEBT_TICKS = TICK_RATE

/**
 * HostedMatch: wraps a MatchSim as the authoritative server-side host of one
 * match. Owns the wall-clock -> sim-clock mapping: a self-correcting
 * setTimeout chain targets 30Hz and, when a fire lands late (Windows timer
 * coalescing), runs bounded catch-up ticks so sim time tracks the wall
 * clock; each tick advances the sim clock by exactly TICK_DT, per MatchSim's
 * fixed-timestep contract. Snapshots go out at 20Hz via a drift-free
 * accumulator of elapsed sim time.
 */
export class HostedMatch {
  readonly sim: MatchSim
  private readonly onSend: (playerId: string, msg: ServerMsg) => void
  private readonly nowFn: () => number

  private readonly humanIds = new Set<string>()
  private readonly ackSeqByPlayer = new Map<string, number>()
  private readonly seed: number
  private readonly botDifficulty: Difficulty
  private botCount = 0

  private readonly brains = new Map<string, BotBrain>()
  private roles = new Map<string, Role>()
  private lastRoleAssignAt = -Infinity

  private simNow = 0
  private tickCount = 0
  private timeSinceSnapshot = 0
  private pendingEvents: SimEvent[] = []
  /** Post-match medal bookkeeping. Never touches the snapshot path -- it is
   * read once, in broadcastMatchEnd. */
  private readonly medals = new Map<string, Partial<Record<MedalId, number>>>()
  private readonly multikill = new Map<string, number>()
  private readonly lastKillAt = new Map<string, number>()
  /** The killer's streak as of their last kill, so a Killjoy can be awarded
   * for ending it -- killPlayer zeroes the victim's own spree. */
  private readonly spreeAtDeath = new Map<string, number>()
  private ended = false

  private running = false
  private tickTimer: ReturnType<typeof setTimeout> | null = null
  private endTimeout: ReturnType<typeof setTimeout> | null = null
  /** Wall-clock time (nowFn seconds) the tick loop started at. */
  private loopStartWall = 0
  /** Ticks run since start(); ticksRun * TICK_DT should track the wall. */
  private ticksRun = 0

  constructor(
    mapName: string,
    seed: number,
    onSend: (playerId: string, msg: ServerMsg) => void,
    nowFn: () => number = () => performance.now() / 1000,
    botDifficulty: Difficulty = DEFAULT_DIFFICULTY
  ) {
    this.sim = new MatchSim(mapName, seed)
    this.onSend = onSend
    this.nowFn = nowFn
    this.seed = seed
    this.botDifficulty = botDifficulty
  }

  /** Roles only drive bot AI, so each team's role scoring only ever sees
   * that team's bots (humans steer themselves and never need a Role). */
  private recomputeRoles(): void {
    const bots = [...this.sim.players.values()].filter((p) => p.bot)
    const team0 = bots.filter((p) => p.team === 0)
    const team1 = bots.filter((p) => p.team === 1)
    this.roles = new Map([...assignRoles(team0, this.sim), ...assignRoles(team1, this.sim)])
  }

  private teamCounts(): [number, number] {
    const counts: [number, number] = [0, 0]
    for (const p of this.sim.players.values()) counts[p.team]++
    return counts
  }

  private pickTeam(): Team {
    const [t0, t1] = this.teamCounts()
    return t0 <= t1 ? 0 : 1
  }

  /** `team` is passed only when restoring a player to the side they were
   * already on (see Lobby.resume) -- otherwise the balancer picks. */
  addHuman(id: string, name: string, team: Team = this.pickTeam()): PlayerState {
    const player = this.sim.addPlayer(id, name, team, false)
    this.humanIds.add(id)
    this.ackSeqByPlayer.set(id, 0)
    return player
  }

  addBot(): PlayerState {
    const name = BOT_NAMES[this.botCount % BOT_NAMES.length]
    const id = `bot-${this.botCount}`
    // Distinct per-bot seed derived from the match seed, so a full replay of
    // the same match seed reproduces identical bot behavior (determinism
    // contract) without brains sharing a stream or touching the sim's rng.
    const brainSeed = this.seed * 1000 + this.botCount + 1
    this.botCount++
    const team = this.pickTeam()
    const player = this.sim.addPlayer(id, name, team, true)
    this.brains.set(id, new BotBrain(id, this.botDifficulty, brainSeed))
    return player
  }

  /**
   * Removes a bot (e.g. to free its slot for a joining human mid-match).
   * Prunes its BotBrain too -- brains is private to this class, so calling
   * sim.removePlayer directly from outside (as Lobby used to) deletes the
   * sim-side player but leaks the Map entry here forever, since nothing
   * else ever visits it again.
   */
  removeBot(id: string): void {
    this.sim.removePlayer(id)
    this.brains.delete(id)
  }

  /**
   * Trust-boundary sanitization: `input` arrives as untrusted client JSON
   * (network trust boundary), so every field is coerced/clamped here before
   * it ever reaches the sim -- a NaN/Infinity yaw or pitch would otherwise
   * propagate through viewDir's sin/cos into NaN positions across the whole
   * deterministic sim (see fix 3).
   */
  handleInput(id: string, input: PlayerInput): void {
    const sanitized = sanitizeInput(input)
    this.sim.setInput(id, sanitized)
    if (this.humanIds.has(id)) this.ackSeqByPlayer.set(id, sanitized.seq)
  }

  /**
   * Removes a human mid-match and replaces them with a bot, preserving the
   * outgoing player's kills/deaths/captures under the bot's new identity
   * (sim.addPlayer always zeroes a fresh player's stats). Used by Lobby for
   * disconnect handling -- humanIds/ackSeqByPlayer are private to this class,
   * so the swap can't be done from outside via sim.removePlayer alone.
   */
  removeHuman(id: string): PlayerState {
    const outgoing = this.sim.players.get(id)
    this.sim.removePlayer(id)
    this.humanIds.delete(id)
    this.ackSeqByPlayer.delete(id)
    const bot = this.addBot()
    if (outgoing) {
      bot.kills = outgoing.kills
      bot.deaths = outgoing.deaths
      bot.captures = outgoing.captures
    }
    return bot
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.simNow = this.nowFn()
    this.tickCount = 0
    this.timeSinceSnapshot = 0
    this.pendingEvents = []
    this.ended = false
    this.loopStartWall = this.nowFn()
    this.ticksRun = 0
    this.scheduleNextTick()
  }

  stop(): void {
    this.running = false
    if (this.tickTimer) {
      clearTimeout(this.tickTimer)
      this.tickTimer = null
    }
    if (this.endTimeout) {
      clearTimeout(this.endTimeout)
      this.endTimeout = null
    }
  }

  private scheduleNextTick(): void {
    const nextDueWall = this.loopStartWall + (this.ticksRun + 1) * TICK_DT
    // Clamp to [0, TICK_DT]: never sleep past one tick period, and fire
    // immediately when already overdue.
    const delaySec = Math.min(Math.max(nextDueWall - this.nowFn(), 0), TICK_DT)
    this.tickTimer = setTimeout(() => this.runDueTicks(), delaySec * 1000)
  }

  /** One timer fire: run the tick(s) the wall clock says are due. A timer
   * that fired late (coalesced) owes more than one tick; run up to
   * MAX_CATCHUP_TICKS of them now so sim time tracks the wall clock. */
  private runDueTicks(): void {
    if (!this.running) return
    const owedTotal = Math.floor((this.nowFn() - this.loopStartWall) / TICK_DT)
    let owed = owedTotal - this.ticksRun
    if (owed > MAX_TICK_DEBT_TICKS) {
      // Long stall (suspend, debugger): forgive the backlog instead of
      // bursting a huge catch-up; sim time resumes from the wall clock.
      this.ticksRun = owedTotal
      owed = 0
    }
    const ticks = Math.max(1, Math.min(owed, MAX_CATCHUP_TICKS))
    for (let i = 0; i < ticks; i++) this.tickOnce()
    this.ticksRun += ticks
    if (this.running) this.scheduleNextTick()
  }

  private tickOnce(): void {
    if (this.ended) return

    this.simNow += TICK_DT
    this.tickCount++

    if (this.simNow - this.lastRoleAssignAt >= ROLE_REASSIGN_INTERVAL) {
      this.recomputeRoles()
      this.lastRoleAssignAt = this.simNow
    }
    for (const [id, brain] of this.brains) {
      if (!this.sim.players.has(id)) continue
      const role = this.roles.get(id) ?? 'defender'
      this.sim.setInput(id, brain.think(this.sim, this.sim.map, role, this.simNow))
    }

    const events = this.sim.tick(this.simNow)
    this.pendingEvents.push(...events)
    this.tallyMedals(events)

    if (events.some((e) => e.type === 'flag_taken' || e.type === 'flag_dropped' || e.type === 'flag_returned')) {
      this.recomputeRoles()
      this.lastRoleAssignAt = this.simNow
    }

    this.timeSinceSnapshot += TICK_DT
    if (this.timeSinceSnapshot >= SNAPSHOT_INTERVAL) {
      this.timeSinceSnapshot -= SNAPSHOT_INTERVAL
      this.broadcastSnapshot()
    }

    const matchEnd = events.find((e): e is Extract<SimEvent, { type: 'match_end' }> => e.type === 'match_end')
    if (matchEnd) {
      this.ended = true
      this.broadcastMatchEnd(matchEnd.winner)
      this.endTimeout = setTimeout(() => this.stop(), MATCH_END_LINGER_MS)
    }
  }

  private broadcastSnapshot(): void {
    const players: SnapPlayer[] = [...this.sim.players.values()].map((p) => toSnapPlayer(p, this.simNow))
    const projectiles: SnapProjectile[] = this.sim.projectiles.map((pr) => ({
      id: pr.id,
      kind: pr.kind,
      pos: pr.pos,
      vel: pr.vel,
    }))
    const events = this.pendingEvents
    this.pendingEvents = []
    const pickups = this.sim.map.powerPickups ? this.sim.pickupsUp() : undefined

    for (const id of this.humanIds) {
      const msg: ServerMsg = {
        t: 'snapshot',
        tick: this.tickCount,
        ackSeq: this.ackSeqByPlayer.get(id) ?? 0,
        time: this.simNow,
        players,
        projectiles,
        flags: this.sim.flags,
        scores: this.sim.scores,
        timeLeft: this.sim.timeLeft,
        events,
        phase: this.sim.phase,
        pickups,
      }
      this.onSend(id, msg)
    }
  }

  /**
   * Accumulates end-of-match medals off the SimEvent stream this tick loop
   * already drains. Deliberately server-side and end-of-match only: it never
   * touches the 20Hz snapshot path, so it costs nothing per tick and cannot
   * affect the 60fps budget.
   *
   * Multikill uses the same 4.5s window as the client's on-screen banner.
   */
  private tallyMedals(events: SimEvent[]): void {
    for (const ev of events) {
      if (ev.type !== 'kill') continue
      const selfKill = ev.killerId === ev.victimId
      if (!selfKill) {
        if (ev.head) this.bumpMedal(ev.killerId, 'headshot')
        if (ev.weapon === 'backsmack') this.bumpMedal(ev.killerId, 'assassination')

        const streak = ev.streak ?? 0
        if (streak === 5) this.bumpMedal(ev.killerId, 'spree')
        if (streak === 10) this.bumpMedal(ev.killerId, 'frenzy')
        if (streak === 15) this.bumpMedal(ev.killerId, 'riot')

        const last = this.lastKillAt.get(ev.killerId) ?? -Infinity
        const chain = this.simNow - last <= MULTIKILL_WINDOW ? (this.multikill.get(ev.killerId) ?? 1) + 1 : 1
        this.multikill.set(ev.killerId, chain)
        this.lastKillAt.set(ev.killerId, this.simNow)
        if (chain === 2) this.bumpMedal(ev.killerId, 'double')
        if (chain === 3) this.bumpMedal(ev.killerId, 'triple')
        if (chain >= 4) this.bumpMedal(ev.killerId, 'overkill')

        // Killjoy: ending someone else's spree. The victim's own spree is
        // zeroed inside killPlayer, so it has to be read before that -- which
        // is exactly why the streak rides the event instead of being read
        // off PlayerState here.
        if ((this.spreeAtDeath.get(ev.victimId) ?? 0) >= 5) {
          this.bumpMedal(ev.killerId, 'killjoy')
        }
      }
      // Dying ends the victim's multikill chain and their recorded spree.
      this.multikill.set(ev.victimId, 0)
      this.lastKillAt.set(ev.victimId, -Infinity)
      this.spreeAtDeath.set(ev.victimId, 0)
      if (!selfKill) this.spreeAtDeath.set(ev.killerId, ev.streak ?? 0)
    }
  }

  private bumpMedal(playerId: string, medal: MedalId): void {
    let row = this.medals.get(playerId)
    if (!row) {
      row = {}
      this.medals.set(playerId, row)
    }
    row[medal] = (row[medal] ?? 0) + 1
  }

  private broadcastMatchEnd(winner: Team | null): void {
    const board = [...this.sim.players.values()].map((p) => ({
      id: p.id,
      team: p.team,
      name: p.name,
      kills: p.kills,
      deaths: p.deaths,
      captures: p.captures,
      medals: this.medals.get(p.id) ?? {},
    }))
    const msg: ServerMsg = { t: 'match_end', winner, scores: this.sim.scores, board }
    for (const id of this.humanIds) this.onSend(id, msg)
  }
}

/** Finite-number guard with a fallback for a value that may not even be a number at runtime. */
function finiteOr(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

/**
 * Coerces every field of an inbound `input` message at the trust boundary
 * (fix 3): numeric fields are finite-guarded (with a fallback) before any
 * clamping, pitch is clamped to +/-90deg, forward/strafe to [-1, 1],
 * booleans are forced via `!!`, and dt is forced to TICK_DT regardless of
 * what the client sent (the sim is a fixed-timestep contract; the client's
 * dt is never trusted).
 */
function sanitizeInput(input: PlayerInput): PlayerInput {
  return {
    seq: finiteOr(input.seq, 0),
    dt: TICK_DT,
    yaw: finiteOr(input.yaw, 0),
    pitch: clamp(finiteOr(input.pitch, 0), -Math.PI / 2, Math.PI / 2),
    forward: clamp(finiteOr(input.forward, 0), -1, 1),
    strafe: clamp(finiteOr(input.strafe, 0), -1, 1),
    jump: !!input.jump,
    fire: !!input.fire,
    melee: !!input.melee,
    grenade: !!input.grenade,
    equipment: !!input.equipment,
    swap: !!input.swap,
    sprint: !!input.sprint,
    slideRequest: !!input.slideRequest,
    ads: !!input.ads,
  }
}
