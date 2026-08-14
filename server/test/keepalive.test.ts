import { describe, it, expect } from 'vitest'
import WebSocket from 'ws'
import { startServer } from '../src/net'
import type { ServerMsg } from '@riftlane/shared'

/**
 * Keepalive, both directions. A player sitting on the menu holds a socket
 * that carries no bytes at all (the client defers `hello` until their first
 * action), and a player whose network dies leaves a half-open socket the
 * server would otherwise hold a match slot for. These cover both.
 */

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once('open', () => resolve()))
}

function nextMessage(ws: WebSocket): Promise<ServerMsg> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()) as ServerMsg)))
}

function closedWithin(ws: WebSocket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    ws.once('close', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

describe('net: keepalive', () => {
  it('answers ping with pong on a socket that has not said hello yet', async () => {
    const server = await startServer(0)
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await opened(ws)

    ws.send(JSON.stringify({ t: 'ping' }))
    // The hello gate must not claim this one: an idle menu socket pings
    // while still anonymous.
    expect(await nextMessage(ws)).toEqual({ t: 'pong' })

    ws.close()
    server.close()
  })

  it('terminates a socket that stops answering the liveness sweep', async () => {
    const server = await startServer(0, 60)
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { autoPong: false })
    await opened(ws)

    expect(await closedWithin(ws, 2000)).toBe(true)

    server.close()
  })

  it('leaves a socket that does answer alone', async () => {
    const server = await startServer(0, 60)
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`) // auto-pongs, as browsers do
    await opened(ws)

    expect(await closedWithin(ws, 500)).toBe(false)

    ws.close()
    server.close()
  })
})
