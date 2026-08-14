# RIFTLANE

RIFTLANE is a browser-based 8-player capture-the-flag arena shooter, built as an original IP inspired by Husky Raid. Two teams of four fight across a small map, grappling and repulsor-jumping between platforms, stealing the enemy flag, and capturing it at their own base. Matches end at 3 captures or when the clock runs out. Any empty human slots are filled by server-side bots, so a match can start (and keep running through a disconnect) with as few as one human player.

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| Mouse | Look |
| `Space` | Jump |
| Left click | Fire |
| `F` | Melee |
| `G` | Throw grenade |
| `E` | Use equipment (grapple / repulsor / camo) |
| `1` `2` / mouse wheel | Swap weapon |
| `Tab` | Scoreboard |

## Running it

Requires Node.js >= 20.

### One command

```bash
python launch.py
```

Installs dependencies if missing, rebuilds the client if it is stale, starts the server, and opens the game in your browser. Uses only the Python standard library (3.8+). Flags: `--port <n>`, `--no-browser`, `--rebuild`.

### Development

```bash
npm install
npm run dev:server   # WebSocket + HTTP server on :8080
npm run dev:client   # Vite dev server, open http://localhost:5173
```

### Production

```bash
npm install
npm run build         # builds the client into client/dist
npm run start          # serves the built client + WebSocket API on one port
```

Then open `http://localhost:8080`. The client connects back to whatever host, port, and protocol (`ws://` or `wss://`, matching the page's own `http://`/`https://`) the page was loaded from, so setting `PORT` to run on a different port (e.g. because 8080 is taken), or serving behind TLS, just works -- no rebuild needed.

## Hosting it as a public website

The whole game is one Node process serving HTTP and WebSockets on a single port, so any Node host works.

**Render (easiest):** this repo includes `render.yaml`. In the [Render dashboard](https://dashboard.render.com), choose New, then Blueprint, pick this repo, and deploy. You get a public `https://<name>.onrender.com` URL; the client connects back over `wss://` automatically, no configuration needed. The free plan sleeps after about 15 minutes idle (first visit then takes about a minute to wake); the starter plan stays warm.

**Any VPS or Node host:**

```bash
npm install
npm run build
PORT=8080 npm run start
```

Put a TLS proxy (Caddy, nginx, or the host's own) in front and forward both HTTP and WebSocket upgrades to that port. The client follows the page's own host, port, and protocol, so no rebuild is needed for a new domain.

## Playing

From the menu, either:
- **Create a room** to get a 4-letter code, share it, and start the match once your friends have joined (bots fill any empty slots).
- **Join a room** with a code someone shared with you.
- **Quick play** to queue into a match automatically -- it starts once enough players have queued, or after a short wait with bots filling the rest.

## Architecture

RIFTLANE is an npm-workspaces monorepo: `shared` holds the deterministic simulation (physics, weapons, maps, wire protocol) used by both server and client; `server` runs an authoritative 30Hz fixed-timestep simulation per match over WebSockets, broadcasting state snapshots to clients at 20Hz and hosting server-side bots for empty slots; `client` (Vite + Three.js) renders the game, predicts the local player's movement from queued inputs, and interpolates remote players between snapshots to stay smooth despite the slower snapshot rate.

## Tests

```bash
npm test          # unit + integration tests (vitest)
npm run typecheck # tsc project references across all three workspaces
```

The integration suite (`server/test/integration.test.ts`) boots a real server on an ephemeral port and drives it with real WebSocket clients, proving the snapshot stream, input ack, mid-match disconnect/bot-swap, and clean shutdown all work over real sockets. It doesn't exercise captures or the rest of match logic -- that's covered by the sim unit tests plus manual playtest.

## Project structure

```
shared/   deterministic sim: physics, weapons, maps, wire protocol, prediction
server/   authoritative match host, lobby/rooms, bots, WebSocket + HTTP server
client/   Vite + Three.js renderer, input, prediction/interpolation, HUD, audio
docs/     architecture decisions and design spec
```

`PRODUCT.md` and `DESIGN.md` at the root capture the product register and the UI visual system (tokens, components, motion) for design tooling and future UI work.

## License

[MIT](LICENSE)
