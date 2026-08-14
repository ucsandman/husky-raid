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
npm run start          # serves the built client + WebSocket API on :8080
```

Then open `http://localhost:8080`. Set `PORT` to run on a different port.

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

The integration suite (`server/test/integration.test.ts`) boots a real server on an ephemeral port and drives it with real WebSocket clients through a full match lifecycle, including a mid-match disconnect and bot replacement.

## Project structure

```
shared/   deterministic sim: physics, weapons, maps, wire protocol, prediction
server/   authoritative match host, lobby/rooms, bots, WebSocket + HTTP server
client/   Vite + Three.js renderer, input, prediction/interpolation, HUD, audio
docs/     architecture decisions and design spec
```
