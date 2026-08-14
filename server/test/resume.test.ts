import { describe, it, expect } from 'vitest'
import { Lobby } from '../src/lobby'
import type { ServerMsg } from '@riftlane/shared'

/**
 * Session resumption: a dropped socket costs you the rest of the round, not
 * the whole match. The seat is held, a stand-in bot plays it, and the token
 * from `welcome` buys it back.
 */

function fakeRand(): () => number {
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

/** Boots a lobby with one human in a running match. */
function startSoloMatch(now: () => number = () => Date.now()) {
  const lobby = new Lobby(fakeRand(), now)
  const a = makePlayer('a')
  const token = lobby.connect(a.id, 'Alice', a.send)
  lobby.handle(a.id, { t: 'create_room' })
  const code = a.received.find(isRoom)!.code
  lobby.handle(a.id, { t: 'start_match' })
  return { lobby, a, token, code }
}

describe('Lobby: session resumption', () => {
  it('keeps a solo player match alive when they drop, with a bot standing in', () => {
    const { lobby, code } = startSoloMatch()

    lobby.disconnect('a')

    // Before this feature the last human leaving stopped the match and
    // deleted the room outright, so there was nothing left to come back to.
    const room = lobby.getRoom(code)
    expect(room?.match).toBeTruthy()
    expect(room!.matchEnded).toBe(false)
    expect(room!.match!.sim.players.size).toBe(8)
    expect([...room!.match!.sim.players.values()].every((p) => p.bot)).toBe(true)

    lobby.stop()
  })

  it('puts a returning player back in the same match, team and score intact', () => {
    const { lobby, token, code } = startSoloMatch()
    const room = lobby.getRoom(code)!

    const before = room.match!.sim.players.get('a')!
    const team = before.team
    before.kills = 3
    before.deaths = 2
    before.captures = 1

    lobby.disconnect('a')
    const returning = makePlayer('a')
    const resumedId = lobby.resume(token, returning.send)

    expect(resumedId).toBe('a')
    const after = room.match!.sim.players.get('a')!
    expect(after.bot).toBe(false)
    expect(after.team).toBe(team)
    expect(after.kills).toBe(3)
    expect(after.deaths).toBe(2)
    expect(after.captures).toBe(1)
    expect(room.match!.sim.players.size).toBe(8)

    // match_start goes out through the players map, so receiving it on the
    // NEW sink is also the proof that snapshots will follow it there.
    expect(returning.received.find(isMatchStart)).toBeDefined()

    lobby.stop()
  })

  it('accepts the same token again after a second drop', () => {
    const { lobby, token } = startSoloMatch()

    lobby.disconnect('a')
    expect(lobby.resume(token, makePlayer('a').send)).toBe('a')
    lobby.disconnect('a')
    expect(lobby.resume(token, makePlayer('a').send)).toBe('a')

    lobby.stop()
  })

  it('refuses a token it never issued', () => {
    const { lobby } = startSoloMatch()

    expect(lobby.resume('not-a-real-token', makePlayer('x').send)).toBeNull()

    lobby.stop()
  })

  it('refuses a token whose owner is still connected', () => {
    const { lobby, token } = startSoloMatch()

    // No drop happened, so there is no seat being held and nothing to claim.
    expect(lobby.resume(token, makePlayer('thief').send)).toBeNull()

    lobby.stop()
  })

  it('releases the seat once the grace window passes', () => {
    let now = 1_000_000
    const { lobby, token, code } = startSoloMatch(() => now)

    lobby.disconnect('a')
    expect(lobby.getRoom(code)).toBeDefined()

    now += 61_000
    expect(lobby.resume(token, makePlayer('a').send)).toBeNull()
    // Last human gone for good: the room goes with them.
    expect(lobby.getRoom(code)).toBeUndefined()

    lobby.stop()
  })

  it('refuses to resume into a match that already ended', () => {
    const { lobby, token, code } = startSoloMatch()
    const room = lobby.getRoom(code)!

    lobby.disconnect('a')
    room.matchEnded = true

    expect(lobby.resume(token, makePlayer('a').send)).toBeNull()

    lobby.stop()
  })

  it('does not strand the other players: their match keeps running', () => {
    const lobby = new Lobby(fakeRand())
    const a = makePlayer('a')
    const b = makePlayer('b')
    lobby.connect(a.id, 'Alice', a.send)
    const bToken = lobby.connect(b.id, 'Bob', b.send)
    lobby.handle(a.id, { t: 'create_room' })
    const code = a.received.find(isRoom)!.code
    lobby.handle(b.id, { t: 'join_room', code })
    lobby.handle(a.id, { t: 'start_match' })

    lobby.disconnect(b.id)
    const room = lobby.getRoom(code)!
    expect(room.match!.sim.players.size).toBe(8)
    expect(room.match!.sim.players.get('a')!.bot).toBe(false)

    expect(lobby.resume(bToken, makePlayer('b').send)).toBe('b')
    expect(room.match!.sim.players.get('b')!.bot).toBe(false)
    expect(room.match!.sim.players.size).toBe(8)

    lobby.stop()
  })
})
