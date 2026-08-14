import type { ClientMsg, ServerMsg } from '@riftlane/shared'

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'disconnected'

export interface Net {
  send(msg: ClientMsg): void
  onMsg(cb: (msg: ServerMsg) => void): () => void
  onStatus(cb: (status: NetStatus, attempt: number) => void): () => void
  /** Abandon the current backoff wait and connect right now (Reconnect button). */
  retryNow(): void
  close(): void
}

const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 10_000
/** Keepalive period. Under the idle timeout of every proxy in the path, so a
 * player sitting on the menu -- a socket that would otherwise carry zero
 * bytes until they press a button -- is never mistaken for a dead one. */
const HEARTBEAT_MS = 25_000
/** Total silence for this long means the socket is black-holed: pongs land
 * every HEARTBEAT_MS and a live match sends snapshots 20x a second. */
const STALE_MS = 60_000

/** WebSocket client that keeps trying for as long as the page is open.
 *
 * It never reaches a dead end while the browser is online: the backoff caps
 * at RECONNECT_MAX_DELAY_MS and keeps going, because the server it talks to
 * may be a sleeping free-tier instance that needs ~60s to boot -- far longer
 * than any fixed attempt budget would wait. 'disconnected' now means only
 * "the browser reports no network", and even that recovers by itself when
 * the 'online' event fires.
 *
 * Each attempt is a brand-new socket -- the server has no session
 * resumption, so callers must re-send `hello` after every 'open'. */
export function connect(url: string): Net {
  const msgListeners = new Set<(msg: ServerMsg) => void>()
  const statusListeners = new Set<(status: NetStatus, attempt: number) => void>()
  const win = typeof window === 'undefined' ? undefined : window
  const doc = typeof document === 'undefined' ? undefined : document

  let ws: WebSocket | null = null
  /** Bumped whenever a socket is superseded, so late events from an
   * abandoned socket (a close that arrives after we gave up on it) can't
   * drive the state machine of its replacement. */
  let gen = 0
  /** Consecutive failed connects; back to 0 the moment one opens. */
  let attempt = 0
  let stopped = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let lastRecvAt = 0

  function emitStatus(status: NetStatus): void {
    for (const fn of statusListeners) fn(status, attempt)
  }

  function rawSend(msg: ClientMsg): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer === null) return
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  function startHeartbeat(): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastRecvAt > STALE_MS) {
        dropSocket()
        scheduleReconnect()
        return
      }
      rawSend({ t: 'ping' })
    }, HEARTBEAT_MS)
  }

  /** Retires the current socket without letting its teardown events run. */
  function dropSocket(): void {
    gen++
    stopHeartbeat()
    const dead = ws
    ws = null
    dead?.close()
  }

  function backoffMs(n: number): number {
    const base = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (n - 1), RECONNECT_MAX_DELAY_MS)
    // Jitter, so several tabs (or several players) don't retry in lockstep
    // and hit a waking server all at the same instant.
    return Math.round(base * (0.8 + Math.random() * 0.4))
  }

  function scheduleReconnect(): void {
    if (stopped || retryTimer !== null) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // Nothing to retry against. The 'online' listener picks it back up.
      emitStatus('disconnected')
      return
    }
    attempt++
    emitStatus('reconnecting')
    retryTimer = setTimeout(() => {
      retryTimer = null
      open()
    }, backoffMs(attempt))
  }

  function open(): void {
    if (stopped) return
    const myGen = ++gen
    emitStatus(attempt === 0 ? 'connecting' : 'reconnecting')

    const sock = new WebSocket(url)
    ws = sock

    sock.addEventListener('open', () => {
      if (myGen !== gen) return
      attempt = 0
      lastRecvAt = Date.now()
      startHeartbeat()
      emitStatus('open')
    })

    sock.addEventListener('message', (ev) => {
      if (myGen !== gen) return
      lastRecvAt = Date.now()
      let msg: ServerMsg
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg
      } catch {
        return
      }
      if (msg.t === 'pong') return // keepalive traffic, not for the app
      for (const fn of msgListeners) fn(msg)
    })

    sock.addEventListener('close', () => {
      if (myGen !== gen || stopped) return
      stopHeartbeat()
      ws = null
      scheduleReconnect()
    })

    // 'close' always follows 'error' for browser WebSockets, so the
    // reconnect logic above is enough; nothing to do here.
    sock.addEventListener('error', () => {})
  }

  function retryNow(): void {
    if (stopped || (ws && ws.readyState === WebSocket.OPEN)) return
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    dropSocket() // also cancels a connect that is hanging
    attempt = 0 // a deliberate retry restarts the backoff ladder
    open()
  }

  // Recover the moment the environment says recovery is possible instead of
  // waiting out a backoff: the network came back, or the player returned to
  // a tab whose timers the browser had been throttling.
  const onOnline = (): void => retryNow()
  const onVisible = (): void => {
    if (doc?.visibilityState === 'visible') retryNow()
  }
  win?.addEventListener('online', onOnline)
  doc?.addEventListener('visibilitychange', onVisible)

  open()

  return {
    send: rawSend,
    onMsg(cb: (msg: ServerMsg) => void): () => void {
      msgListeners.add(cb)
      return () => msgListeners.delete(cb)
    },
    onStatus(cb: (status: NetStatus, attempt: number) => void): () => void {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
    retryNow,
    close(): void {
      stopped = true
      win?.removeEventListener('online', onOnline)
      doc?.removeEventListener('visibilitychange', onVisible)
      if (retryTimer !== null) clearTimeout(retryTimer)
      dropSocket()
    },
  }
}
