import {
  MatchSim,
  toSnapPlayer,
  TICK_DT,
  TICK_RATE,
  SNAPSHOT_RATE,
  type PlayerInput,
  type PlayerState,
  type ServerMsg,
  type SimEvent,
  type SnapPlayer,
  type SnapProjectile,
  type Team,
} from '@riftlane/shared'
import { BotBrain, DEFAULT_DIFFICULTY } from './bots/brain'
import { assignRoles, type Role } from './bots/roles'

const BOT_NAMES = ['VEX', 'TALON', 'RIVET', 'ONYX', 'JINX', 'MOSS', 'HALCYON-9', 'DITTO']

/** Bot roles are re-scored on this cadence, plus immediately on any flag event. */
const ROLE_REASSIGN_INTERVAL = 2

/** Sim-time gap the snapshot accumulator waits for between emits. TICK_RATE
 * (30Hz) and SNAPSHOT_RATE (20Hz) don't divide evenly, so this is tracked
 * as elapsed sim time rather than "every Nth tick" to stay drift-free. */
const SNAPSHOT_INTERVAL = 1 / SNAPSHOT_RATE

/** How long the tick loop keeps running (idle) after match_end before
 * stop() is called automatically, e.g. to leave room for a rematch vote. */
const MATCH_END_LINGER_MS = 20_000

/**
 * HostedMatch: wraps a MatchSim as the authoritative server-side host of one
 * match. Owns the wall-clock -> sim-clock mapping (a 30Hz setInterval drives
 * ticks; each tick advances the sim clock by exactly TICK_DT, per MatchSim's
 * fixed-timestep contract, regardless of real setInterval jitter) and the
 * 20Hz snapshot cadence via a drift-free accumulator of elapsed sim time.
 */
export class HostedMatch {
  readonly sim: MatchSim
  private readonly onSend: (playerId: string, msg: ServerMsg) => void
  private readonly nowFn: () => number

  private readonly humanIds = new Set<string>()
  private readonly ackSeqByPlayer = new Map<string, number>()
  private readonly seed: number
  private botCount = 0

  private readonly brains = new Map<string, BotBrain>()
  private roles = new Map<string, Role>()
  private lastRoleAssignAt = -Infinity

  private simNow = 0
  private tickCount = 0
  private timeSinceSnapshot = 0
  private pendingEvents: SimEvent[] = []
  private ended = false

  private interval: ReturnType<typeof setInterval> | null = null
  private endTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(
    mapName: string,
    seed: number,
    onSend: (playerId: string, msg: ServerMsg) => void,
    nowFn: () => number = () => performance.now() / 1000
  ) {
    this.sim = new MatchSim(mapName, seed)
    this.onSend = onSend
    this.nowFn = nowFn
    this.seed = seed
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

  addHuman(id: string, name: string): PlayerState {
    const team = this.pickTeam()
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
    this.brains.set(id, new BotBrain(id, DEFAULT_DIFFICULTY, brainSeed))
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

  handleInput(id: string, input: PlayerInput): void {
    this.sim.setInput(id, input)
    if (this.humanIds.has(id)) this.ackSeqByPlayer.set(id, input.seq)
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
    if (this.interval) return
    this.simNow = this.nowFn()
    this.tickCount = 0
    this.timeSinceSnapshot = 0
    this.pendingEvents = []
    this.ended = false
    this.interval = setInterval(() => this.tickOnce(), 1000 / TICK_RATE)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    if (this.endTimeout) {
      clearTimeout(this.endTimeout)
      this.endTimeout = null
    }
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
      }
      this.onSend(id, msg)
    }
  }

  private broadcastMatchEnd(winner: Team | null): void {
    const board = [...this.sim.players.values()].map((p) => ({
      name: p.name,
      kills: p.kills,
      deaths: p.deaths,
      captures: p.captures,
    }))
    const msg: ServerMsg = { t: 'match_end', winner, scores: this.sim.scores, board }
    for (const id of this.humanIds) this.onSend(id, msg)
  }
}
