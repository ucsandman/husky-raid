import { describe, it, expect, vi, afterEach } from 'vitest'
import { HostedMatch } from '../src/match'
import type { PlayerInput, ServerMsg } from '@riftlane/shared'
import { TICK_DT, CAPTURES_TO_WIN } from '@riftlane/shared'

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
