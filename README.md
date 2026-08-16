# RIFTLANE

RIFTLANE is a browser-based 8-player capture-the-flag arena shooter, built as an original IP inspired by Husky Raid. Two teams of four fight across a small map, grappling and repulsor-jumping around cover, stealing the enemy flag, and capturing it at their own base. Movement is Halo-style: sprint, slide, clamber onto ledges mid-air, and forgiving jump timing. Everyone spawns with the same pair every life -- an MA40 Assault Rifle and an MK50 Sidekick -- so every fight starts from a known baseline, and the other nine weapons live on timed map pads worth fighting over: battle rifles and shotguns on short timers, the sniper, rockets and the power melee on long ones, always on the route between the bases rather than inside a flag room. Matches open with a short warmup countdown, respawns get a brief protection window, and three maps rotate: the tight lane of gutter, hairpin's U-bend, and bastion, a three-route arena about three times gutter's size. Quick Play lets you pick the bot difficulty. Carrying the flag costs you your gun -- carriers move at full speed but can only melee. Matches end at 3 captures or when the clock runs out.

Fights are the Halo two-stage kill: strip the shield first, then finish. **Headshot multipliers only pay out once a target's shield is down**, so a fight is a rhythm rather than a race, and sparks tell you which stage you are in -- blue while you are chipping the shield, red once you are into health. The S7 Sniper Rifle is the one exception: it ignores the gate and one-shots a full-shield target through the head, which is what makes holding a long lane worth it. A beatdown landed inside a target's own rear arc kills outright. A motion tracker paints anyone moving nearby, an announcer calls the match, and the post-game carnage report hands out medals. Any empty human slots are filled by server-side bots, so a match can start (and keep running through a disconnect) with as few as one human player.

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| Right click | Aim down sights (zoom, tighter spread, slower move) |
| `Shift` | Sprint (forward, cancels while firing) |
| `Ctrl` | Slide (at speed; jump out of it to keep momentum) |
| Mouse | Look |
| `Space` | Jump (with coyote time and a landing buffer) |
| Left click | Fire |
| `F` | Melee |
| `G` | Throw grenade |
| `E` | Use equipment (grapple / repulsor / camo) |
| `1` `2` / mouse wheel | Swap weapon |
| `Tab` | Scoreboard |
| `Esc` | Pause menu (settings sliders + leave match) |

### Xbox controller

Plug in (or pair) a standard-mapping controller and touch any stick or button — the game switches to it automatically, and switches back the moment the mouse moves. Movement is analog, and aim gets a mild slowdown while the reticle is over a target.

| Input | Action |
| --- | --- |
| Left stick | Move (click to sprint) |
| Right stick | Look |
| `RT` / `LT` | Fire / Aim down sights |
| `A` / `B` | Jump / Slide |
| `X` / `Y` | Equipment / Swap weapon |
| `RB` / `LB` | Grenade / Melee |
| View / Menu | Scoreboard / Pause |

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

**Render (easiest):** this repo includes `render.yaml`. In the [Render dashboard](https://dashboard.render.com), choose New, then Blueprint, pick this repo, and deploy. You get a public `https://<name>.onrender.com` URL; the client connects back over `wss://` automatically, no configuration needed. The free plan sleeps after about 15 minutes idle (first visit then takes about a minute to wake); the starter plan stays warm. A sleeping server is not an error state for the player: the client keeps retrying for as long as the page is open, says "Server is waking up" while it waits, and connects itself the moment the server answers. There is also a Reconnect button in the status bar to skip the wait.

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

## Dropping out and coming back

Losing your connection mid-match costs you the next few seconds, not the match. Your seat is held for 60 seconds while a stand-in bot plays it (inheriting your kills, deaths and captures), and the client reconnects on its own and reclaims it: same team, same score, same match. Reloading the page does the same thing, because the resume token lives in `sessionStorage`.

Two things it deliberately does not do. It does not survive the **server** restarting, since match state is in memory only, so a free-plan instance waking from sleep gives you a fresh session. And it does not preserve your position or health: you rejoin from a spawn point.

## Architecture

RIFTLANE is an npm-workspaces monorepo: `shared` holds the deterministic simulation (physics, weapons, maps, wire protocol) used by both server and client; `server` runs an authoritative 30Hz fixed-timestep simulation per match over WebSockets, broadcasting state snapshots to clients at 20Hz and hosting server-side bots for empty slots; `client` (Vite + Three.js) renders the game, predicts the local player's movement from queued inputs, and interpolates remote players between snapshots to stay smooth despite the slower snapshot rate.

## Tests

```bash
npm test          # unit + integration tests (vitest)
npm run typecheck # tsc project references across all three workspaces
npm run playtest  # real browser, real match: are the controls actually alive?
```

`npm run playtest` needs the server already running (`npm run start`, or set `RIFTLANE_URL`) and Playwright's Chromium (`npx playwright install chromium`). It joins a real match and checks the things unit tests structurally cannot see: that keys and mouse buttons reach the server, that holding fire consumes ammo, that right click scopes in, that losing pointer lock shows a resume prompt instead of silently killing every input, and that the keyboard still works once lock is gone. Every one of those was broken at some point while the unit suite was fully green.

It drives a live match against real bots, so it is not perfectly deterministic. The fire and scope checks wait for the player to be alive and retry a death mid-burst (see `waitAlive` in the script, and the 2026-08-14 entry in `docs/ERRORS.md` for why that matters). An occasional single-check failure is the test being noisy, not proof of a regression -- re-run it, and compare against the same number of runs on a clean tree before believing it.

The integration suite (`server/test/integration.test.ts`) boots a real server on an ephemeral port and drives it with real WebSocket clients, proving the snapshot stream, input ack, mid-match disconnect/bot-swap, and clean shutdown all work over real sockets. It doesn't exercise captures or the rest of match logic -- that's covered by the sim unit tests plus manual playtest.

## Asset generation keys (optional)

The game builds and runs with no environment variables. The keys in `.env.example` are only for regenerating AI-produced assets (announcer voice lines and stingers live in `client/public/assets/audio/`) with local tooling:

```bash
cp .env.example .env   # then fill in real keys
```

- `ELEVENLABS_API_KEY` -- announcer VO and SFX generation
- `GEMINI_API_KEY` -- 2D art references (logo, menu backgrounds)
- `TRIPO_API_KEY` -- 3D model generation

`.env` is gitignored; keys never ship to the client. If a generated audio file is missing at runtime, the announcer falls back to speech synthesis and the game keeps working.

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

## Support

If my tools save you time, you can support my work here:

[![Sponsor on GitHub](https://img.shields.io/badge/GitHub%20Sponsors-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ucsandman)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-%E2%98%95-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/wes_sander)
