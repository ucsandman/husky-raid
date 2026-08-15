import { describe, it, expect, vi, afterEach } from 'vitest'
import { HostedMatch } from '../src/match'
import { BotBrain, DEFAULT_DIFFICULTY, DIFFICULTIES } from '../src/bots/brain'
import { Navigator } from '../src/bots/nav'
import type { PlayerInput, ServerMsg, SimEvent } from '@riftlane/shared'
import { MatchSim, TICK_DT, CAPTURES_TO_WIN, WARMUP_SEC } from '@riftlane/shared'

function makeInput(overrides?: Partial<PlayerInput>): PlayerInput {
  return {
    seq: 0,
    dt: TICK_DT,
    yaw: 0,
    pitch: 0,
    forward: 0,
    strafe: 0,
    jump: false,
    fire: false,
    melee: false,
    grenade: false,
    equipment: false,
    swap: false,
    ...overrides,
  }
}

function isSnapshot(msg: ServerMsg): msg is Extract<ServerMsg, { t: 'snapshot' }> {
  return msg.t === 'snapshot'
}

function isMatchEnd(msg: ServerMsg): msg is Extract<ServerMsg, { t: 'match_end' }> {
  return msg.t === 'match_end'
}

afterEach(() => {
  vi.useRealTimers()
})

describe('HostedMatch: team auto-balance', () => {
  it('fills teams balanced when adding 3 humans and 5 bots', () => {
    const match = new HostedMatch('gutter', 1, () => {})
    match.addHuman('h1', 'Human1')
    match.addHuman('h2', 'Human2')
    match.addHuman('h3', 'Human3')
    for (let i = 0; i < 5; i++) match.addBot()

    const counts: [number, number] = [0, 0]
    for (const p of match.sim.players.values()) counts[p.team]++
    expect(counts[0]).toBe(4)
    expect(counts[1]).toBe(4)
    expect(match.sim.players.size).toBe(8)
  })
})

describe('HostedMatch: snapshot loop', () => {
  it('delivers >=8 snapshots to each human in 500ms and echoes ackSeq', () => {
    vi.useFakeTimers()
    const received: Record<string, ServerMsg[]> = { h1: [], h2: [] }
    const match = new HostedMatch('gutter', 2, (id, msg) => {
      received[id]?.push(msg)
    }, () => 1000)
    match.addHuman('h1', 'Human1')
    match.addHuman('h2', 'Human2')
    match.handleInput('h1', makeInput({ seq: 7 }))

    match.start()
    vi.advanceTimersByTime(500)
    match.stop()

    const h1Snaps = received.h1.filter(isSnapshot)
    const h2Snaps = received.h2.filter(isSnapshot)
    expect(h1Snaps.length).toBeGreaterThanOrEqual(8)
    expect(h2Snaps.length).toBeGreaterThanOrEqual(8)
    expect(h1Snaps[h1Snaps.length - 1].ackSeq).toBe(7)
    expect(h2Snaps[h2Snaps.length - 1].ackSeq).toBe(0)
  })
})

describe('HostedMatch: match end', () => {
  it('broadcasts a scoreboard on match_end and stops the loop after 20s', () => {
    vi.useFakeTimers()
    const received: ServerMsg[] = []
    const match = new HostedMatch('gutter', 3, (_id, msg) => received.push(msg), () => 2000)
    match.addHuman('h1', 'Human1')
    match.addHuman('h2', 'Human2')
    match.start()

    vi.advanceTimersByTime(100)
    match.sim.scores = [CAPTURES_TO_WIN, 0]
    vi.advanceTimersByTime(50)

    const endMsg = received.find(isMatchEnd)
    expect(endMsg).toBeDefined()
    expect(endMsg?.scores).toEqual([CAPTURES_TO_WIN, 0])
    expect(endMsg?.winner).toBe(0)
    expect(endMsg?.board.length).toBe(2)

    const snapCountAtEnd = received.filter(isSnapshot).length
    vi.advanceTimersByTime(5000)
    expect(received.filter(isSnapshot).length).toBe(snapCountAtEnd)

    vi.advanceTimersByTime(20000)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('HostedMatch: self-correcting tick scheduler', () => {
  it('catches sim time up to the wall clock when timers fire late (coalescing)', () => {
    vi.useFakeTimers()
    const received: ServerMsg[] = []
    let wall = 5000
    const match = new HostedMatch('gutter', 6, (_id, msg) => received.push(msg), () => wall)
    match.addHuman('h1', 'Human1')
    match.start()

    // Simulate Windows timer coalescing: the ~33ms tick timer actually fires
    // only once per 100ms of wall time. A bare setInterval runs one tick per
    // fire and silently drops the rest; a self-correcting scheduler must run
    // catch-up ticks so sim time tracks the wall clock.
    for (let i = 0; i < 30; i++) {
      wall += 0.1
      vi.advanceTimersToNextTimer()
    }
    match.stop()

    // 3s of wall time at 20Hz nominal => ~60 snapshots. A non-correcting
    // loop only manages ~20 (30 fires -> 1s of sim time).
    const snaps = received.filter(isSnapshot)
    expect(snaps.length).toBeGreaterThanOrEqual(54)
  })
})

describe('HostedMatch: input sanitization at the trust boundary (fix 3)', () => {
  it('coerces malformed input fields so the sim never goes non-finite', () => {
    const match = new HostedMatch('gutter', 5, () => {})
    match.addHuman('h1', 'Human1')

    match.handleInput('h1', {
      seq: Infinity,
      dt: 9e9,
      yaw: Infinity,
      pitch: 999,
      forward: 9e9,
      strafe: -9e9,
      jump: 'x' as unknown as boolean,
      fire: false,
      melee: false,
      grenade: false,
      equipment: false,
      swap: false,
    })

    const p = match.sim.players.get('h1')!
    match.sim.tick(TICK_DT)

    expect(Number.isFinite(p.pos.x)).toBe(true)
    expect(Number.isFinite(p.pos.y)).toBe(true)
    expect(Number.isFinite(p.pos.z)).toBe(true)
    expect(Number.isFinite(p.vel.x)).toBe(true)
    expect(Number.isFinite(p.vel.y)).toBe(true)
    expect(Number.isFinite(p.vel.z)).toBe(true)
    expect(Number.isFinite(p.yaw)).toBe(true)
    expect(p.pitch).toBeGreaterThanOrEqual(-Math.PI / 2)
    expect(p.pitch).toBeLessThanOrEqual(Math.PI / 2)
  })
})

describe('HostedMatch: SnapPlayer HUD fields (Task 14)', () => {
  it('sends ammo/grenades/equipment/equipmentCharges with sane values for every player', () => {
    vi.useFakeTimers()
    const received: ServerMsg[] = []
    // Fake single client -- one human "hello"s in, the rest of the roster
    // is bots, matching how a real HUD-driving browser session would see
    // this snapshot stream.
    const match = new HostedMatch('gutter', 4, (_id, msg) => received.push(msg), () => 3000)
    match.addHuman('h1', 'Human1')
    for (let i = 0; i < 3; i++) match.addBot()
    match.start()

    vi.advanceTimersByTime(100)
    match.stop()

    const snap = received.filter(isSnapshot).at(-1)
    expect(snap).toBeDefined()
    expect(snap!.players.length).toBe(4)
    for (const p of snap!.players) {
      expect(p.ammo).toHaveLength(2)
      for (const a of p.ammo) {
        expect(Number.isInteger(a)).toBe(true)
        expect(a).toBeGreaterThanOrEqual(0)
      }
      expect(Number.isInteger(p.grenades.frag)).toBe(true)
      expect(p.grenades.frag).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(p.grenades.mag)).toBe(true)
      expect(p.grenades.mag).toBeGreaterThanOrEqual(0)
      expect(['grapple', 'repulsor', 'camo', null]).toContain(p.equipment)
      expect(Number.isInteger(p.equipmentCharges)).toBe(true)
      expect(p.equipmentCharges).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('HostedMatch: carnage report medals', () => {
  afterEach(() => vi.useRealTimers())

  /** Feeds kill events straight to the tally. tickOnce() already hands it
   * exactly what sim.tick() returns, so what needs pinning here is the medal
   * ladder itself, not the wiring -- and driving five real shield-gated
   * headshot kills through a live sim would pin the bots, not the medals. */
  function feed(match: HostedMatch, events: SimEvent[]): void {
    ;(match as unknown as { tallyMedals(e: SimEvent[]): void }).tallyMedals(events)
  }

  function kill(killerId: string, victimId: string, extra: Partial<Extract<SimEvent, { type: 'kill' }>> = {}) {
    return { type: 'kill' as const, killerId, victimId, weapon: 'triad_rifle', head: false, streak: 1, ...extra }
  }

  it('tallies headshot, assassination and spree onto the match_end board', () => {
    vi.useFakeTimers()
    const received: ServerMsg[] = []
    const match = new HostedMatch('gutter', 7, (_id, msg) => received.push(msg), () => 2000)
    match.addHuman('h1', 'Hunter')
    match.addHuman('h2', 'Prey')
    match.start()
    vi.advanceTimersByTime(100)

    feed(match, [
      kill('h1', 'h2', { streak: 1, head: true }),
      kill('h1', 'h2', { streak: 2, weapon: 'backsmack' }),
      kill('h1', 'h2', { streak: 5 }),
    ])

    match.sim.scores = [CAPTURES_TO_WIN, 0]
    vi.advanceTimersByTime(50)

    const row = received.find(isMatchEnd)!.board.find((r) => r.id === 'h1')!
    expect(row.medals.headshot).toBe(1)
    expect(row.medals.assassination).toBe(1)
    expect(row.medals.spree).toBe(1)
    expect(row.team).toBe(match.sim.players.get('h1')!.team)
  })

  it('awards a killjoy for ending a spree, and never credits a self-kill', () => {
    vi.useFakeTimers()
    const received: ServerMsg[] = []
    const match = new HostedMatch('gutter', 8, (_id, msg) => received.push(msg), () => 2000)
    match.addHuman('h1', 'Hunter')
    match.addHuman('h2', 'Prey')
    match.start()
    vi.advanceTimersByTime(100)

    // h2 builds a 5-kill spree, then h1 ends it -> Killjoy for h1.
    feed(match, [kill('h2', 'h1', { streak: 5 })])
    feed(match, [kill('h1', 'h2', { streak: 1 })])
    // A fall death (killer === victim) must earn nothing at all.
    feed(match, [kill('h1', 'h1', { streak: 0, weapon: 'fall' })])

    match.sim.scores = [CAPTURES_TO_WIN, 0]
    vi.advanceTimersByTime(50)

    const board = received.find(isMatchEnd)!.board
    const hunter = board.find((r) => r.id === 'h1')!
    expect(hunter.medals.killjoy).toBe(1)
    expect(hunter.medals.spree).toBeUndefined()
    expect(board.find((r) => r.id === 'h2')!.medals.spree).toBe(1)
  })
})

describe('BotBrain: defender patrol re-roll bypasses the goal-refresh gate', () => {
  it('pushes every periodic patrol re-roll to the Navigator, not just ones that clear GOAL_REFRESH_DIST', () => {
    const sim = new MatchSim('gutter', 60)
    const bot = sim.addPlayer('bot-1', 'Bot', 0, true)
    bot.pos = { ...sim.map.flagStands[0] }

    const brain = new BotBrain('bot-1', DEFAULT_DIFFICULTY, 600)
    const setGoalSpy = vi.spyOn(Navigator.prototype, 'setGoal')

    // DEFENDER_PATROL_RESET_INTERVAL is 4s -- resets land at t=0,4,8,12,16,20.
    // Most re-rolled jitter points land within GOAL_REFRESH_DIST (3m) of the
    // last one pushed, since the patrol radius itself is only 3m -- the gate
    // at the setGoal callsite must not be allowed to swallow those, or the
    // bot vibrates in place instead of patrolling (the exact bug this guards).
    let now = 0
    while (now < 21) {
      brain.think(sim, sim.map, 'defender', now)
      now += TICK_DT
    }

    expect(setGoalSpy.mock.calls.length).toBeGreaterThanOrEqual(6)
    setGoalSpy.mockRestore()
  })
})

describe('HostedMatch: warmup', () => {
  it('snapshots carry phase "warmup" while sim.beginWarmup is in effect (the call launchMatch makes in lobby.ts)', () => {
    vi.useFakeTimers()
    const received: ServerMsg[] = []
    const match = new HostedMatch('gutter', 9, (_id, msg) => received.push(msg), () => 4000)
    match.addHuman('h1', 'Human1')
    match.sim.beginWarmup(WARMUP_SEC)
    match.start()

    vi.advanceTimersByTime(100)
    match.stop()

    expect(match.sim.phase).toBe('warmup')
    expect(match.sim.timeLeft).toBeLessThanOrEqual(WARMUP_SEC)
    const snaps = received.filter(isSnapshot)
    expect(snaps.length).toBeGreaterThan(0)
    for (const s of snaps) expect(s.phase).toBe('warmup')
  })
})

describe('HostedMatch: snapshot pickups field', () => {
  it('includes pickups (index-aligned with map.powerPickups) for a map that has pads', () => {
    vi.useFakeTimers()
    const received: ServerMsg[] = []
    // gutter has one powerPickups pad.
    const match = new HostedMatch('gutter', 10, (_id, msg) => received.push(msg), () => 5000)
    match.addHuman('h1', 'Human1')
    match.start()

    vi.advanceTimersByTime(100)
    match.stop()

    const snap = received.filter(isSnapshot).at(-1)
    expect(snap).toBeDefined()
    expect(snap!.pickups).toEqual([true])
  })
})

describe('HostedMatch: botDifficulty threading', () => {
  it('constructs bots with the hard difficulty preset when passed to the constructor', () => {
    const match = new HostedMatch('gutter', 11, () => {}, undefined, DIFFICULTIES.hard)
    const bot = match.addBot()
    const brain = (match as unknown as { brains: Map<string, { difficulty: unknown }> }).brains.get(bot.id)
    expect(brain).toBeDefined()
    expect((brain as unknown as { difficulty: typeof DIFFICULTIES.hard }).difficulty).toEqual(DIFFICULTIES.hard)
  })
})
