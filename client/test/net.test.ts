import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connect, serverUrl, type NetStatus } from '../src/net'
import type { ServerMsg } from '@riftlane/shared'

/**
 * Regression cover for the "Lost connection to the server. Refresh to try
 * again." dead end: the client used to give up after 3 attempts spread over
 * ~6 seconds, which cannot outlast the ~60s cold start of a free-tier host
 * that has gone to sleep. Every test here is about surviving an outage that
 * lasts longer than a few seconds.
 */

type Listener = (ev: { data?: string }) => void

/** How long a fake connect attempt takes to fail. Browsers end a failed
 * connect with 'error' then 'close'; nothing here would ever produce a
 * second attempt without that. */
const CONNECT_FAIL_MS = 500

class FakeSocket {
  static readonly OPEN = 1
  static instances: FakeSocket[] = []

  readyState = 0
  readonly sent: string[] = []
  private readonly listeners: Record<string, Listener[]> = {}

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
    setTimeout(() => {
      if (this.readyState === 0) this.drop()
    }, CONNECT_FAIL_MS)
  }

  addEventListener(type: string, cb: Listener): void {
    ;(this.listeners[type] ??= []).push(cb)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  private emit(type: string, ev?: { data?: string }): void {
    for (const cb of this.listeners[type] ?? []) cb(ev ?? {})
  }

  /** The server accepted the connection. */
  accept(): void {
    this.readyState = FakeSocket.OPEN
    this.emit('open')
  }

  /** The connection failed, or an established one dropped. */
  drop(): void {
    this.readyState = 3
    this.emit('close')
  }

  deliver(msg: ServerMsg): void {
    this.emit('message', { data: JSON.stringify(msg) })
  }
}

const latest = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1]

beforeEach(() => {
  FakeSocket.instances = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('client net: which server to dial', () => {
  const loc = (protocol: string, host: string): Pick<Location, 'protocol' | 'hostname' | 'host' | 'port'> => {
    const [hostname, port = ''] = host.split(':')
    return { protocol, host, hostname, port }
  }

  // The regression: an https page has an EMPTY location.port (443 is
  // implicit), which the old code read as "no port to go on" and answered
  // with :8080 -- a port no TLS host exposes. It could never connect.
  it('dials the page origin on a deployed https site', () => {
    expect(serverUrl(loc('https:', 'riftlane.onrender.com'))).toBe('wss://riftlane.onrender.com')
  })

  it('dials the page origin on a plain-http host with no explicit port', () => {
    expect(serverUrl(loc('http:', 'riftlane.example.com'))).toBe('ws://riftlane.example.com')
  })

  it('keeps a non-default port, so any PORT the server was started with works', () => {
    expect(serverUrl(loc('http:', 'localhost:8123'))).toBe('ws://localhost:8123')
  })

  it('crosses from the Vite dev server to the separate game server', () => {
    expect(serverUrl(loc('http:', 'localhost:5173'))).toBe('ws://localhost:8080')
  })
})

describe('client net: reconnect', () => {
  it('keeps retrying through a 60 second outage instead of giving up', async () => {
    const seen: NetStatus[] = []
    const net = connect('ws://test')
    net.onStatus((s) => seen.push(s))

    latest().drop() // first connect fails: server asleep
    await vi.advanceTimersByTimeAsync(60_000)

    // The old client stopped at 4 sockets (1 + 3 retries) and then reported
    // 'disconnected' for good. Anything that survives a cold start makes
    // many more, and never lands in a terminal state.
    expect(FakeSocket.instances.length).toBeGreaterThan(4)
    expect(seen).not.toContain('disconnected')

    // ...and the attempt that finally lands still works.
    latest().accept()
    expect(seen[seen.length - 1]).toBe('open')
  })

  it('caps the backoff so a long outage keeps getting retries', async () => {
    connect('ws://test')
    latest().drop()

    await vi.advanceTimersByTimeAsync(120_000)
    const afterTwoMinutes = FakeSocket.instances.length

    await vi.advanceTimersByTimeAsync(60_000)
    // Still trying at least every 15s two minutes in (10s cap plus jitter
    // plus the time each attempt takes to fail), not backing off to never.
    expect(FakeSocket.instances.length - afterTwoMinutes).toBeGreaterThanOrEqual(4)
  })

  it('reconnects on demand without waiting out the backoff', async () => {
    const net = connect('ws://test')
    latest().drop()
    await vi.advanceTimersByTimeAsync(30_000) // deep into the backoff ladder
    const before = FakeSocket.instances.length

    net.retryNow()

    expect(FakeSocket.instances.length).toBe(before + 1)
  })

  it('waits for the network instead of hammering a dead one, then recovers', async () => {
    const handlers: Record<string, () => void> = {}
    vi.stubGlobal('navigator', { onLine: false })
    vi.stubGlobal('window', {
      addEventListener: (type: string, cb: () => void) => {
        handlers[type] = cb
      },
      removeEventListener: () => {},
    })

    const seen: NetStatus[] = []
    const net = connect('ws://test')
    net.onStatus((s) => seen.push(s))
    latest().drop()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(seen).toContain('disconnected')
    expect(FakeSocket.instances.length).toBe(1) // nothing to retry against

    // The browser says the network is back.
    vi.stubGlobal('navigator', { onLine: true })
    handlers.online()

    expect(FakeSocket.instances.length).toBe(2)
  })

  it('stops retrying once closed', async () => {
    const net = connect('ws://test')
    latest().accept()
    net.close()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.instances.length).toBe(1)
  })
})

describe('client net: heartbeat', () => {
  it('pings an idle socket so nothing in the path calls it dead', async () => {
    connect('ws://test')
    const sock = latest()
    sock.accept()

    await vi.advanceTimersByTimeAsync(26_000)

    expect(sock.sent).toContain(JSON.stringify({ t: 'ping' }))
  })

  it('replaces a socket that goes silent', async () => {
    connect('ws://test')
    latest().accept()

    // No pong, no snapshot, nothing: black-holed rather than closed. Still
    // inside the stale window, so the socket is given the benefit of the
    // doubt and nothing is replaced yet.
    await vi.advanceTimersByTimeAsync(50_000)
    expect(FakeSocket.instances.length).toBe(1)

    // Past it: the socket is written off rather than sat on.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(FakeSocket.instances.length).toBeGreaterThan(1)
  })

  it('keeps a socket that answers', async () => {
    connect('ws://test')
    const sock = latest()
    sock.accept()

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(25_000)
      sock.deliver({ t: 'pong' })
    }

    expect(FakeSocket.instances.length).toBe(1)
  })

  it('does not hand pong traffic to the app', async () => {
    const net = connect('ws://test')
    const msgs: ServerMsg[] = []
    net.onMsg((m) => msgs.push(m))
    const sock = latest()
    sock.accept()

    sock.deliver({ t: 'pong' })
    sock.deliver({ t: 'welcome', playerId: 'p1', resumeToken: 'tok' })

    expect(msgs).toEqual([{ t: 'welcome', playerId: 'p1', resumeToken: 'tok' }])
  })
})
