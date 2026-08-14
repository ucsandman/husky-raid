import { describe, it, expect } from 'vitest'
import WebSocket from 'ws'
import { startServer } from '../src/net'
import { TICK_DT } from '@riftlane/shared'
import type { ClientMsg, PlayerInput, ServerMsg } from '@riftlane/shared'

/**
 * End-to-end proof that the whole stack (net -> lobby -> match -> sim) works
 * over real sockets, not just in-process fakes like lobby.test.ts/match.test.ts
 * use. Boots a real server on an ephemeral port and drives it with two real
 * `ws` clients.
 */

const TEST_TIMEOUT_MS = 20_000
const INPUT_SCRIPT_MS = 5_000

function makeInput(seq: number): PlayerInput {
  return {
    seq,
    dt: TICK_DT,
    yaw: 0,
    pitch: 0,
    forward: 1, // client A holds forward for the whole script
    strafe: 0,
    jump: false,
    fire: false,
    melee: false,
    grenade: false,
    equipment: false,
    swap: false,
  }
}

function isWelcome(m: ServerMsg): m is Extract<ServerMsg, { t: 'welcome' }> {
  return m.t === 'welcome'
}
function isRoom(m: ServerMsg): m is Extract<ServerMsg, { t: 'room' }> {
  return m.t === 'room'
}
function isMatchStart(m: ServerMsg): m is Extract<ServerMsg, { t: 'match_start' }> {
  return m.t === 'match_start'
}
function isSnapshot(m: ServerMsg): m is Extract<ServerMsg, { t: 'snapshot' }> {
  return m.t === 'snapshot'
}

/** Thin wrapper around a real `ws` client that records every ServerMsg it
 * receives and lets the test await the next message matching a predicate
 * (already-received messages resolve immediately). */
class TestClient {
  readonly received: ServerMsg[] = []
  private readonly waiters: { predicate: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []

  constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMsg
      this.received.push(msg)
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].predicate(msg)) {
          const [w] = this.waiters.splice(i, 1)
          w.resolve(msg)
        }
      }
    })
  }

  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg))
  }

  waitFor<T extends ServerMsg>(predicate: (m: ServerMsg) => m is T, timeoutMs = 5000): Promise<T> {
    const existing = this.received.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m as T)
        },
      })
    })
  }

  close(): void {
    this.ws.close()
  }
}

function connect(port: number, name: string, resume?: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.once('error', reject)
    ws.once('open', () => {
      const client = new TestClient(ws)
      client.send(resume ? { t: 'hello', name, resume } : { t: 'hello', name })
      resolve(client)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** How many matches the lobby currently considers live, per GET /health. */
async function activeMatches(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/health`)
  const body = (await res.json()) as { ok: boolean; matches: number }
  return body.matches
}

describe('integration: full match lifecycle over real websockets', () => {
  it(
    'connects two real clients, plays a scripted match, handles a mid-match disconnect, and shuts down with no leaked handles',
    async () => {
      const server = await startServer(0)

      const a = await connect(server.port, 'Alice')
      const b = await connect(server.port, 'Bob')

      const aWelcome = await a.waitFor(isWelcome)
      const bWelcome = await b.waitFor(isWelcome)
      expect(aWelcome.playerId).toBeTruthy()
      expect(bWelcome.playerId).toBeTruthy()

      a.send({ t: 'create_room' })
      const roomMsg = await a.waitFor(isRoom)
      expect(roomMsg.hostId).toBe(aWelcome.playerId)

      b.send({ t: 'join_room', code: roomMsg.code })
      await b.waitFor(isRoom)

      a.send({ t: 'start_match' })
      const aStart = await a.waitFor(isMatchStart)
      const bStart = await b.waitFor(isMatchStart)
      expect(aStart.players.length).toBe(8)
      expect(bStart.players.length).toBe(8)

      // Script 5s of fixed-dt inputs from A, holding forward. Snapshots are
      // 20Hz (~50ms) server-side; sending slightly faster than that is fine
      // -- the sim just uses the latest input it has at tick time.
      const scriptStart = Date.now()
      let seq = 0
      const inputTimer = setInterval(() => {
        seq++
        a.send({ t: 'input', input: makeInput(seq) })
      }, 33) // ~30/s, comfortably faster than the server's 30Hz tick
      await sleep(INPUT_SCRIPT_MS)
      clearInterval(inputTimer)
      const scriptElapsedSec = (Date.now() - scriptStart) / 1000

      const aSnaps = a.received.filter(isSnapshot)
      expect(aSnaps.length).toBeGreaterThan(0)

      // Cadence: server broadcasts at 20Hz nominal (30Hz tick loop, snapshot
      // every ~1.5 ticks). Windows timer coalescing fires Node timers late
      // under load; the self-correcting scheduler in HostedMatch runs
      // catch-up ticks per fire so sim time (and thus snapshot count) tracks
      // the wall clock even when fires land late. A bare setInterval on this
      // dev box measured as low as ~14/s; with catch-up the bar is the
      // plan's original >=15/s, with headroom below the 20/s nominal for
      // real-time jitter this test can't control.
      const snapshotRate = aSnaps.length / scriptElapsedSec
      expect(snapshotRate).toBeGreaterThanOrEqual(15)

      // A's position changed under sustained forward input.
      const firstA = aSnaps[0].players.find((p) => p.id === aWelcome.playerId)
      const lastA = aSnaps.at(-1)!.players.find((p) => p.id === aWelcome.playerId)
      expect(firstA).toBeDefined()
      expect(lastA).toBeDefined()
      expect(lastA!.pos).not.toEqual(firstA!.pos)

      // ackSeq echoes A's last-processed input seq.
      expect(aSnaps.at(-1)!.ackSeq).toBeGreaterThan(0)
      expect(aSnaps.at(-1)!.ackSeq).toBeLessThanOrEqual(seq)

      const botsBefore = aSnaps.at(-1)!.players.filter((p) => p.bot).length

      // Disconnect B mid-match -- Lobby swaps in a bot, keeping the room at 8.
      // Poll for the actual swap to land, not just "a newer snapshot arrived"
      // -- the tick loop can emit one more snapshot in the pre-disconnect
      // state before the server finishes processing the socket close event.
      b.close()

      const afterDisconnect = await new Promise<Extract<ServerMsg, { t: 'snapshot' }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bot replacement never showed up in a snapshot')), 3000)
        const check = (): void => {
          const latest = a.received.filter(isSnapshot).at(-1)
          if (latest && latest.players.filter((p) => p.bot).length === botsBefore + 1) {
            clearTimeout(timer)
            resolve(latest)
          } else {
            setTimeout(check, 25)
          }
        }
        check()
      })

      expect(afterDisconnect.players.length).toBe(8)

      // Close A too. Every human is now gone, but the match deliberately
      // keeps running: their seats are held for the resume window, played by
      // stand-in bots (Lobby.RESUME_GRACE_MS). Before session resumption the
      // room was deleted here and the match stopped.
      a.close()
      await sleep(250)
      expect(await activeMatches(server.port)).toBe(1)

      // A returns with the token from their welcome and lands back in the
      // SAME match under the same id, rather than as a new player.
      const aAgain = await connect(server.port, 'Alice', aWelcome.resumeToken)
      const againWelcome = await aAgain.waitFor(isWelcome)
      expect(againWelcome.playerId).toBe(aWelcome.playerId)

      const rejoin = await aAgain.waitFor(isMatchStart)
      expect(rejoin.yourId).toBe(aWelcome.playerId)
      expect(rejoin.players.length).toBe(8)

      // Snapshots follow them onto the new socket, which is what makes the
      // match actually playable again rather than just re-entered.
      const resumedSnap = await aAgain.waitFor(isSnapshot)
      expect(resumedSnap.players.some((p) => p.id === aWelcome.playerId && !p.bot)).toBe(true)

      aAgain.close()
      // server.close() -> lobby.stop() stops every running match, so no tick
      // interval outlives the test even with a seat still being held.
      server.close()
    },
    TEST_TIMEOUT_MS
  )
})
