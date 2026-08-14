import type { ClientMsg, ServerMsg } from '@riftlane/shared'

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'disconnected'

export interface Net {
  send(msg: ClientMsg): void
  onMsg(cb: (msg: ServerMsg) => void): () => void
  onStatus(cb: (status: NetStatus) => void): () => void
  close(): void
}

const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_BASE_DELAY_MS = 1000

/** WebSocket client: reconnects up to MAX_RECONNECT_ATTEMPTS times with a
 * linear backoff, then reports 'disconnected' for good (caller shows an
 * error banner). Each reconnect is a brand-new socket -- the server has no
 * session resumption, so callers must re-send `hello` after every 'open'. */
export function connect(url: string): Net {
  const msgListeners = new Set<(msg: ServerMsg) => void>()
  const statusListeners = new Set<(status: NetStatus) => void>()
  let ws: WebSocket | null = null
  let attempts = 0
  let stopped = false

  function emitStatus(status: NetStatus): void {
    for (const fn of statusListeners) fn(status)
  }

  function open(): void {
    emitStatus(attempts === 0 ? 'connecting' : 'reconnecting')
    ws = new WebSocket(url)

    ws.addEventListener('open', () => {
      attempts = 0
      emitStatus('open')
    })

    ws.addEventListener('message', (ev) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg
      } catch {
        return
      }
      for (const fn of msgListeners) fn(msg)
    })

    ws.addEventListener('close', () => {
      if (stopped) return
      if (attempts < MAX_RECONNECT_ATTEMPTS) {
        attempts++
        setTimeout(open, RECONNECT_BASE_DELAY_MS * attempts)
      } else {
        emitStatus('disconnected')
      }
    })

    // 'close' always follows 'error' for browser WebSockets, so the
    // reconnect/give-up logic above is enough; nothing to do here.
    ws.addEventListener('error', () => {})
  }

  open()

  return {
    send(msg: ClientMsg): void {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    },
    onMsg(cb: (msg: ServerMsg) => void): () => void {
      msgListeners.add(cb)
      return () => msgListeners.delete(cb)
    },
    onStatus(cb: (status: NetStatus) => void): () => void {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
    close(): void {
      stopped = true
      ws?.close()
    },
  }
}
