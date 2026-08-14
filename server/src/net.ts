import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import * as WS from 'ws'
import type { ClientMsg, ServerMsg } from '@riftlane/shared'
import { Lobby } from './lobby'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const CLIENT_DIST = join(__dirname, '..', '..', 'client', 'dist')

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
}

/** Starts the server and resolves once it is actually listening, so callers
 * (tests booting on an ephemeral port via startServer(0)) can read the real
 * bound port off the result -- `server.listen(0)` only assigns a port
 * asynchronously, there's no synchronous way to know it beforehand. */
export function startServer(port: number): Promise<{ close(): void; port: number }> {
  const lobby = new Lobby()

  const server = createServer((req, res) => {
    handleHttp(req, res, lobby).catch((err: unknown) => {
      res.statusCode = 500
      res.end(String(err))
    })
  })

  const wss = new WS.WebSocketServer({ server })
  wss.on('connection', (ws: WS.WebSocket) => handleConnection(ws, lobby))

  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address()
      const boundPort = address && typeof address === 'object' ? address.port : port
      resolve({
        port: boundPort,
        close(): void {
          lobby.stop()
          wss.close()
          server.close()
        },
      })
    })
  })
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, lobby: Lobby): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/health') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, matches: lobby.matchCount() }))
    return
  }

  const filePath = await resolveStaticFile(url.pathname)
  if (filePath) {
    const body = await readFile(filePath)
    res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream')
    res.end(body)
    return
  }

  res.setHeader('content-type', 'text/plain')
  res.end('riftlane server: client/dist not found. Run `npm run dev:client` (Vite) to build the client.')
}

/** Resolves a URL path to a file under client/dist, SPA-falling-back to
 * index.html for unknown paths. Returns null when client/dist (or the
 * requested + fallback files) don't exist. */
async function resolveStaticFile(pathname: string): Promise<string | null> {
  const rel = pathname === '/' ? '/index.html' : pathname
  const filePath = join(CLIENT_DIST, rel)
  // Guard against path traversal: a startsWith(CLIENT_DIST) check alone
  // would also match a sibling directory that happens to share the prefix
  // (e.g. CLIENT_DIST + '-evil'), so require the full separator boundary --
  // except for CLIENT_DIST itself, kept as an exact-index match.
  if (filePath !== CLIENT_DIST && !filePath.startsWith(CLIENT_DIST + sep)) return null

  try {
    const s = await stat(filePath)
    if (s.isFile()) return filePath
  } catch {
    // fall through to SPA fallback
  }

  try {
    const indexPath = join(CLIENT_DIST, 'index.html')
    const s = await stat(indexPath)
    if (s.isFile()) return indexPath
  } catch {
    return null
  }
  return null
}

/** Trust-boundary coercion for the hello message's `name` field (fix 3):
 * client JSON is untrusted, so a non-string name falls back to 'Player'
 * and any string is capped at 24 chars before it ever reaches the lobby. */
export function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') return 'Player'
  return name.slice(0, 24)
}

function handleConnection(ws: WS.WebSocket, lobby: Lobby): void {
  let playerId: string | null = null

  function send(msg: ServerMsg): void {
    if (ws.readyState === WS.WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  ws.on('message', (data) => {
    let msg: ClientMsg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      send({ t: 'error', message: 'malformed JSON' })
      return
    }

    if (!playerId) {
      if (msg.t !== 'hello') {
        send({ t: 'error', message: 'first message must be hello' })
        return
      }
      playerId = randomUUID()
      lobby.connect(playerId, sanitizeName(msg.name), send)
      send({ t: 'welcome', playerId })
      return
    }

    lobby.handle(playerId, msg)
  })

  ws.on('close', () => {
    if (playerId) lobby.disconnect(playerId)
  })
}
