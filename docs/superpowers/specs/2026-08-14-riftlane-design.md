# RIFTLANE — Design Spec

Date: 2026-08-14
Status: Approved design, pre-implementation
Working title: **RIFTLANE** (renameable; repo folder stays `husky-raid`)

## 1. What this is

A browser FPS inspired by the Husky Raid community mode: linear Capture
the Flag with random weapons on small, narrow maps. Online multiplayer
with an authoritative Node server, smart server-side bots, and a
Three.js client. All assets are original and procedural — no Halo
models, names, sounds, or files. Zero downloaded assets.

Non-goals for v1: accounts, persistence, ranked play, lag-compensated
rewind, mobile controls, hosting/deployment (local only).

## 2. Game rules

- 4v4, CTF only. First team to 3 captures wins, or the higher score at
  8 minutes. Tie allowed at time-out (sudden-death is a v2 item).
- Spawn loadout, re-rolled every respawn:
  - 2 random weapons from the roster (no duplicate pair)
  - 2 grenades (random split of Frag / Mag)
  - 1 equipment slot: Grapple, Repulsor, Camo, or empty (equal odds)
- Health model: 70 shield + 30 health. Shield recharges at 35/s after
  4 s without taking damage. Health does not regenerate.
- Melee always available (35 damage, 0.8 s cooldown). Power melee
  weapons (Arc Blade, Grav Maul) kill in one hit within lunge range.
- Flag rules (Husky style):
  - Score at your own stand any time; your flag does NOT need to be home.
  - Carrier moves at 90% speed, cannot shoot; melee only (instant kill
    with flag is a v2 consideration, not in v1).
  - Flag drops on death; returns to its stand after 15 s untouched.
    Defenders touch it to return it instantly.
- Respawn 4 s after death, at the team's spawn zone, facing the lane.
- Falling into a death pit kills instantly (counts as suicide; flag drops
  at the pit edge, not in the pit).

## 3. Weapon roster

All hitscan unless noted. Numbers are starting tunings, expected to change
in playtesting.

| Name | Analog | Type | Notes |
|---|---|---|---|
| Pulse SMG | AR | auto hitscan | 10/s, 8 dmg, big spread |
| Triad Rifle | BR | 3-round burst | 3×12 dmg, mid accuracy |
| Railspike | Sniper | single hitscan | 100 dmg body, 2× head, slow ROF |
| Boomtube | Rockets | projectile | 120 dmg, 3 m splash radius, 2-round mag |
| Scattergun | Shotgun | 8-pellet hitscan | 8×12 dmg, tight range falloff |
| Sidearm | Pistol | semi hitscan | 15 dmg, fast, accurate |
| Swarm Pod | Needler | homing projectiles | 7 dmg each; 6 stuck in one target = 80 dmg pop |
| Ion Charger | Plasma pistol | charge projectile | tap 10 dmg; full charge strips entire shield, slight tracking |
| Arc Blade | Energy sword | power melee | one-hit lunge, 5 m lock range |
| Grav Maul | Grav hammer | power melee | one-hit AoE slam, 4 m radius, 1.2 s wind-up |

Grenades: **Frag** (bounces, 2 s fuse, 90 dmg / 4 m falloff), **Mag**
(sticks to players and surfaces, 1.5 s fuse, 110 dmg on stick).

Equipment (one charge per life unless noted):
- **Grapple** — fire at surface ≤ 20 m, pull player; 3 charges, 2 s cooldown.
- **Repulsor** — radial impulse; shoves players, flags, and projectiles
  away; 2 charges.
- **Camo** — 8 s near-invisibility; shooting or taking damage breaks it.

## 4. Maps

- Format: JSON data files in `shared/maps/`. Schema includes: axis-aligned
  boxes (walls/floors/ramps as rotated boxes are v2; v1 uses stepped boxes
  for ramps), launch pads (position + launch velocity vector), teleporter
  pairs, team spawn zones, flag stands, death-pit volumes, light/color
  hints for the client, and a bot waypoint graph (nodes + edges, edges
  tagged walk / launchpad / teleporter / grapple).
- Both server and client load the same file. The server never touches
  Three.js.
- Collision: player capsule vs AABB only. Projectiles are spheres vs AABB.
- v1 ships 2 mirror-symmetric maps:
  - **Gutter** — straight lane, mid launch pad crossing, teleporter side
    flank, pits both sides.
  - **Hairpin** — U-shaped lane, teleporter shortcut across the U's gap,
    one high walkway reachable by grapple or launch pad.

## 5. Netcode

- Server simulation at 30 ticks/s. Server is authoritative for movement
  validation, hits, damage, deaths, flags, pickups, equipment, and timers.
- Client → server: input packets (sequence number, buttons, view angles),
  sent every client frame, coalesced.
- Server → client: snapshots at 20/s — positions, velocities, health,
  weapon states, flag states, events (kills, captures, sounds).
- Client-side prediction for the local player: apply inputs immediately
  using the shared movement code; on each snapshot, rewind to the server
  state and replay unacknowledged inputs. Correction smoothing over 100 ms.
- Remote entities interpolate 100 ms behind the newest snapshot.
- Transport: WebSocket (`ws`), JSON messages first. Binary encoding only
  if profiling shows the need (decision recorded then).
- Hitscan is evaluated against current server state (no lag-compensated
  rewind in v1; acceptable under ~100 ms ping; v2 item).

## 6. Server, rooms, queue

- One Node process: HTTP (serves built client + health endpoint) +
  WebSocket upgrade on the same port.
- **Rooms:** client requests create → server returns 4-letter code →
  friends join via `/#room=CODE`. Room creator can start the match early;
  otherwise auto-start when full. Bots fill empty slots at start.
- **Quick-play:** clients enter a queue; when ≥ 2 humans have waited 10 s
  (or 8 humans at any time), a match starts and bots fill to 8 players.
- Match lifecycle: lobby → 5 s countdown → play → scoreboard (20 s) →
  rematch vote (majority of humans) → countdown or back to menu.
- Multiple concurrent matches in one process; each match is an isolated
  sim instance. No accounts, no database, nothing persisted.
- Mid-match join fills a bot slot (human replaces a bot); mid-match leave
  replaces the human with a bot.

## 7. Bots (server-side)

- Run inside the server sim at tick rate, sharing the exact player
  movement/combat code paths (a bot is a player whose inputs come from AI).
- Role assignment by utility score, re-evaluated every 2 s and on events
  (flag taken, carrier died): **Runner** (fetch enemy flag), **Escort**
  (guard own carrier), **Hunter** (kill enemy carrier), **Defender**
  (hold own flag stand). Team keeps at least one Runner and one Defender.
- Navigation: A* over the map's waypoint graph; edges tagged with the
  required action (walk, launch pad, teleporter, grapple). Local steering
  between waypoints; unstick logic if displaced.
- Combat model: reaction delay (250–500 ms by difficulty) + aim error
  cone that shrinks while line-of-sight holds. Weapon choice by range.
  Grenades at clustered enemies; power melee when inside lunge range.
- Equipment use: Repulsor against incoming rockets or lunges, Camo before
  a flag grab, Grapple for tagged graph edges and escapes with the flag.
- One difficulty setting in v1 (medium), tunable constants in one file.

## 8. Client

- Stack: Vite + TypeScript + Three.js. Pointer-lock mouse look, WASD,
  Space jump, F melee, G grenade, E equipment / interact, 1-2 or wheel
  weapon swap, Tab scoreboard.
- Rendering: flat-shaded low-poly. Soldiers are procedural capsule +
  armor-plate meshes, team-colored (blue vs orange), name tags for
  humans. Maps rendered from the same JSON the server simulates, with
  color/light hints. Instanced meshes for repeated geometry. Target
  60 fps on integrated graphics.
- HUD: HTML/CSS overlay — shield/health bar, ammo, grenade count,
  equipment icon + charges, kill feed, flag status arrows, score, timer,
  hit markers, respawn countdown.
- Menus: name entry, Quick Play, Create Room, Join Room, settings
  (sensitivity, volume). All HTML/CSS.
- Audio: synthesized WebAudio (oscillator/noise-based shots, shield pop,
  explosion, capture jingle, announcer beeps). No audio files.

## 9. Repo structure

```
husky-raid/
  package.json          # npm workspaces root
  shared/               # TS: physics, combat, weapons, map schema+maps,
                        #     message types, constants
  server/               # TS: sim loop, netcode, match/room/queue, bots
  client/               # TS: Vite + Three.js, prediction, input, HUD, audio
  docs/superpowers/specs/
```

- `shared/` has zero dependencies and no DOM/Node APIs, so it runs
  identically on both sides and in tests.

## 10. Testing & verification

- Vitest on `shared/`: movement determinism, damage/shield math, flag
  state machine, weapon fire logic, map schema validation.
- Vitest on `server/`: bot role assignment, A* pathing on a fixture map,
  room/queue lifecycle.
- Integration: headless scripted match — fake WebSocket clients join,
  move, shoot, capture; assert score and clean shutdown.
- Manual: two browser windows + bots on localhost, played and seen
  rendered before any "done" claim.

## 11. v2 parking lot (explicitly out of v1)

Lag-compensated hitscan rewind, binary protocol, sudden death, more
maps, difficulty settings, mobile/gamepad input, hosting/deploy,
spectator mode, cosmetics.
