import { describe, it, expect, vi, afterEach } from 'vitest'
import { Lobby } from '../src/lobby'
import type { ServerMsg } from '@riftlane/shared'

function fakeRand(): () => number {
  // deterministic sequence in [0, 1) so room codes are reproducible in tests
  let n = 0
  return () => {
    n = (n + 0.13) % 1
    return n
  }
}

function makePlayer(id: string) {
  const received: ServerMsg[] = []
  return { id, received, send: (msg: ServerMsg) => received.push(msg) }
}

function isMatchStart(msg: ServerMsg): msg is Extract<ServerMsg, { t: 'match_start' }> {
  return msg.t === 'match_start'
}

function isRoom(msg: ServerMsg): msg is Extract<ServerMsg, { t: 'room' }> {
  return msg.t === 'room'
}

function isError(msg: ServerMsg): msg is Extract<ServerMsg, { t: 'error' }> {
  return msg.t === 'error'
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Lobby: room create/join/start', () => {
  it('creates a room, joins, starts, and fills bots to 8 in balanced teams', () => {
    const lobby = new Lobby(fakeRand())
    const a = makePlayer('a')
    const b = makePlayer('b')
    lobby.connect(a.id, 'Alice', a.send)
    lobby.connect(b.id, 'Bob', b.send)

    lobby.handle(a.id, { t: 'create_room' })
    const roomMsg = a.received.find(isRoom)
    expect(roomMsg).toBeDefined()
    expect(roomMsg?.code).toMatch(/^[A-HJ-NP-Z]{4}$/)

    lobby.handle(b.id, { t: 'join_room', code: roomMsg!.code })
    lobby.handle(a.id, { t: 'start_match' })

    const aStart = a.received.find(isMatchStart)
    const bStart = b.received.find(isMatchStart)
    expect(aStart).toBeDefined()
    expect(bStart).toBeDefined()
    expect(aStart?.players.length).toBe(8)

    const bots = aStart!.players.filter((p) => p.bot)
    expect(bots.length).toBe(6)
    const counts: [number, number] = [0, 0]
    for (const p of aStart!.players) counts[p.team]++
    expect(counts[0]).toBe(4)
    expect(counts[1]).toBe(4)

    lobby.stop()
  })
})

describe('Lobby: non-host cannot start', () => {
  it('sends an error when a non-host tries to start the match', () => {
    const lobby = new Lobby(fakeRand())
    const a = makePlayer('a')
    const b = makePlayer('b')
    lobby.connect(a.id, 'Alice', a.send)
    lobby.connect(b.id, 'Bob', b.send)

    lobby.handle(a.id, { t: 'create_room' })
    const code = a.received.find(isRoom)!.code
    lobby.handle(b.id, { t: 'join_room', code })

    lobby.handle(b.id, { t: 'start_match' })

    expect(b.received.find(isError)).toBeDefined()
    expect(b.received.find(isMatchStart)).toBeUndefined()
    expect(a.received.find(isMatchStart)).toBeUndefined()

    lobby.stop()
  })
})

describe('Lobby: quick play pairs after 10s', () => {
  it('starts a match for two queued humans once both have waited 10s', () => {
    vi.useFakeTimers()
    const lobby = new Lobby(fakeRand())
    const a = makePlayer('a')
    const b = makePlayer('b')
    lobby.connect(a.id, 'Alice', a.send)
    lobby.connect(b.id, 'Bob', b.send)

    lobby.handle(a.id, { t: 'quick_play' })
    lobby.handle(b.id, { t: 'quick_play' })

    expect(a.received.find(isMatchStart)).toBeUndefined()

    vi.advanceTimersByTime(10_000)

    expect(a.received.find(isMatchStart)).toBeDefined()
    expect(b.received.find(isMatchStart)).toBeDefined()

    lobby.stop()
  })
})

describe('Lobby: single human waits', () => {
  it('does not start a bot-only match for a lone queued human', () => {
    vi.useFakeTimers()
    const lobby = new Lobby(fakeRand())
    const a = makePlayer('a')
    lobby.connect(a.id, 'Alice', a.send)

    lobby.handle(a.id, { t: 'quick_play' })
    vi.advanceTimersByTime(30_000)

    expect(a.received.find(isMatchStart)).toBeUndefined()

    lobby.stop()
  })
})

describe('Lobby: disconnect mid-match swaps in a bot', () => {
  it('replaces a disconnected human with a bot, keeping the match at 8 players', () => {
    const lobby = new Lobby(fakeRand())
    const a = makePlayer('a')
    const b = makePlayer('b')
    lobby.connect(a.id, 'Alice', a.send)
    lobby.connect(b.id, 'Bob', b.send)

    lobby.handle(a.id, { t: 'create_room' })
    const code = a.received.find(isRoom)!.code
    lobby.handle(b.id, { t: 'join_room', code })
    lobby.handle(a.id, { t: 'start_match' })

    const aStart = a.received.find(isMatchStart)!
    const botsBefore = aStart.players.filter((p) => p.bot).length

    lobby.disconnect(b.id)

    const room = lobby.getRoom(code)!
    expect(room.match).toBeDefined()
    expect(room.match!.sim.players.size).toBe(8)
    const botsAfter = [...room.match!.sim.players.values()].filter((p) => p.bot).length
    expect(botsAfter).toBe(botsBefore + 1)

    lobby.stop()
  })
})

describe('Lobby: rematch votes from departed players expire', () => {
  it('does not let a stale vote from a disconnected player count toward the majority', () => {
    const lobby = new Lobby(fakeRand())
    const a = makePlayer('a')
    const b = makePlayer('b')
    const c = makePlayer('c')
    const d = makePlayer('d')
    lobby.connect(a.id, 'Alice', a.send)
    lobby.connect(b.id, 'Bob', b.send)
    lobby.connect(c.id, 'Carol', c.send)
    lobby.connect(d.id, 'Dave', d.send)

    lobby.handle(a.id, { t: 'create_room' })
    const code = a.received.find(isRoom)!.code
    lobby.handle(b.id, { t: 'join_room', code })
    lobby.handle(c.id, { t: 'join_room', code })
    lobby.handle(d.id, { t: 'join_room', code })
    lobby.handle(a.id, { t: 'start_match' })

    const room = lobby.getRoom(code)!
    // Simulate the match having ended -- the real match_end flow runs through
    // HostedMatch's tick loop, but rematch bookkeeping is purely Lobby-side.
    room.matchEnded = true

    lobby.handle(a.id, { t: 'rematch_vote' })
    lobby.handle(b.id, { t: 'rematch_vote' })
    expect(room.rematchVotes.size).toBe(2)

    // A and B leave. With 4 members, their 2 votes would be a majority
    // (2*2 > 4 is false actually -- but against the post-leave membership of
    // 2, a stale {a,b} vote set is 2*2 > 2, a false majority) unless their
    // votes are dropped.
    lobby.disconnect(a.id)
    lobby.disconnect(b.id)

    expect(room.rematchVotes.size).toBe(0)
    expect(room.memberIds.size).toBe(2)

    const cStartsBefore = c.received.filter(isMatchStart).length

    // One of the two remaining members alone is not a majority.
    lobby.handle(c.id, { t: 'rematch_vote' })
    expect(c.received.filter(isMatchStart).length).toBe(cStartsBefore)

    // Both remaining members (2 of 2) is a real majority.
    lobby.handle(d.id, { t: 'rematch_vote' })
    expect(c.received.filter(isMatchStart).length).toBe(cStartsBefore + 1)

    lobby.stop()
  })
})
