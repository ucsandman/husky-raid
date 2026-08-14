# Decisions

Durable architecture and design decisions for RIFTLANE. One dated entry each; alternatives rejected noted where relevant.

## 2026-08-14: Authoritative server + client-side prediction

The server (`server/src/match.ts`) runs the only simulation that matters -- clients never decide their own outcome. Each client predicts its own local player from unacknowledged inputs (`client/src/predict.ts`) so movement feels instant, and interpolates remote players between 20Hz snapshots. Rejected: fully client-authoritative or lockstep netcode -- both are far easier to cheat and lockstep stalls the whole match on one slow client.

## 2026-08-14: JSON-first wire protocol

`shared/src/protocol.ts` messages are plain JSON over a single WebSocket. Simple to debug (readable in devtools, no schema-compiler step) and fast enough at 8 players / 20Hz. Binary encoding (e.g. a packed snapshot format) is deferred to a later version if bandwidth or parse cost becomes a real problem.

## 2026-08-14: Capsule-as-AABB collision simplification

Player collision volumes are treated as axis-aligned boxes rather than true capsules (`shared/src/physics.ts`). Cheaper to compute and good enough at this map scale; a real capsule-vs-geometry solver was judged not worth the complexity for v1.

## 2026-08-14: No lag-compensation rewind in v1

Hit registration uses current server-side positions, not a rewound history of where a shooter's target was on their screen. Simpler and avoids the "shot behind cover" fairness debates rewind can introduce; acceptable at this game's scale and LAN-to-modest-latency target. Worth revisiting if higher-latency play becomes a priority.

## 2026-08-14: Snapshot broadcast at 20Hz over a 30Hz sim tick

The sim ticks at a fixed 30Hz (`TICK_RATE`/`TICK_DT` in `shared/src/constants.ts`) for deterministic physics, but snapshots broadcast at 20Hz via a drift-free elapsed-sim-time accumulator (`HostedMatch.tickOnce` in `server/src/match.ts`), not "every Nth tick" -- 30 and 20 don't divide evenly, and an accumulator avoids cadence drift. Cuts outbound bandwidth ~33% versus broadcasting every tick; client-side interpolation absorbs the gap.

**Known limitation / follow-up (2026-08-14):** on Windows under load, Node's plain `setInterval` for the tick loop suffers timer coalescing, yielding an effective wall-clock snapshot cadence of ~14/s instead of the nominal 20/s (measured 3x independently, reproduced by a second reviewer). Sim correctness is unaffected (fixed-timestep sim time is still exact), but real-time pacing suffers. Follow-up: replace the tick loop with a self-correcting scheduler in `HostedMatch` (`setTimeout`-based drift compensation instead of bare `setInterval`).

**Resolved (2026-08-14, same day):** `HostedMatch` now drives ticks with a self-correcting `setTimeout` chain: each fire runs the ticks the wall clock says are owed (up to `MAX_CATCHUP_TICKS` = 5 per fire) and the next delay is computed against the loop's start time, so late fires are compensated instead of dropped. Debt beyond `MAX_TICK_DEBT_TICKS` (~1s, e.g. process suspend) is forgiven rather than burst-replayed. Verified by a fake-clock coalescing test (`server/test/match.test.ts`) and by restoring the integration cadence bar to the plan's original >=15/s (was lowered to >=10/s under the bug; passes 3/3 runs at >=15/s post-fix).

## 2026-08-14: Dijkstra over A* for bot navigation

Bot pathfinding (`server/src/bots/`) uses Dijkstra rather than A*. The map graph includes teleporters, whose traversal cost isn't a consistent distance metric an A* heuristic could stay admissible against, so a heuristic-free shortest-path search was the safer choice at this map size.

## 2026-08-14: Infinite ammo reserves, RELOAD_TIME gates an empty magazine

Weapons never run out of ammo permanently -- emptying a magazine locks that weapon for `RELOAD_TIME` seconds (`shared/src/constants.ts`) rather than requiring pickups or tracking reserve counts. Keeps the core gunplay loop (and its balance surface) simple; ammo pickups were judged unnecessary complexity for this match format.

## 2026-08-14: Scattergun fires per-pellet spread with a 25m falloff cap

The scattergun (`shared/src/weapons.ts`) resolves each pellet as its own spread raycast rather than a single cone check, and hitscan damage is capped at 25m so it can't out-range weapons meant for long sightlines. Keeps its close-range identity distinct from the hitscan rifles.

## 2026-08-14: Sign-convention rule for all direction math

Every place that needs "forward" or "right" derives it from `physics.ts`'s `rightVec`/`forwardVec` convention rather than re-deriving trig locally. This was made a hard rule after code review caught three separate inversion bugs (movement, aim, and bot steering each computing the sign differently) during implementation -- a single source of truth for the convention was cheaper than re-auditing every call site by hand each time.

## 2026-08-14: SnapPlayer carries ammo/grenades/equipment for the HUD

The over-the-wire `SnapPlayer` type (`shared/src/protocol.ts`) originally carried only position/health/weapon-id fields. Ammo counts, grenade counts, and equipment charge counts were added for every player (not just the local one) so the HUD can render real numbers instead of icons with no counts. Sent for all 8 players at 20Hz; the added payload (a few small numbers/objects per player) is negligible next to the rest of the snapshot.

## 2026-08-14: Maps as typed TS modules, not the spec's JSON data files

The design spec (§4) calls for map data as JSON files under `shared/maps/`. Shipped instead as typed TypeScript modules (`shared/src/maps/`) exporting `GameMap` objects directly. Rejected the JSON route: a typed module gets full compile-time checking of box/waypoint/teleporter shapes for free and needs zero runtime loader/parser/validation code, at the cost of the map data not being editable without a rebuild. Both server and client still load the exact same module, matching the spec's "both server and client load the same file" requirement. Deviation recorded; revisit if maps need to be hot-edited or authored outside the codebase.

## 2026-08-14: Grav Maul AoE + wind-up and Ion Charger charge-up cut from v1

The spec (§3) describes Grav Maul as a 4m-radius AoE slam with a 1.2s wind-up, and Ion Charger as a tap/full-charge weapon with charge-dependent damage. Both shipped simplified for v1: Grav Maul is a single-target instant power-melee hit (like Arc Blade, no AoE/wind-up), and Ion Charger fires flat-damage charge projectiles with no charge-up mechanic. The now-unused fields these would have needed (`WeaponDef.aoeRadius`, `Projectile.chargeFrac`) were removed from the types rather than left dead. Revisit for v2 if the flatter versions don't feel distinct enough in playtesting.

## 2026-08-14: Field-level input sanitization at the HostedMatch.handleInput trust boundary

Inbound `PlayerInput` (`server/src/match.ts` `handleInput`), the hello `name` field (`server/src/net.ts`), and `join_room`'s room `code` (`server/src/lobby.ts`) are all untrusted client JSON. Chose field-level coercion/clamping at each entry point (finite-number guards with fallbacks, range clamps, `!!` booleans, string-shape checks) over a schema-validation library: the message shapes are small and stable, and a library dependency wasn't worth it for a handful of fields. `handleInput` in particular matters most -- an unclamped `yaw`/`pitch` of `Infinity` would propagate as `NaN` through `viewDir`'s `sin`/`cos` into the whole deterministic sim.

## 2026-08-14: Solo Quick Play now starts a bot-filled match after the 10s wait

Quick Play originally required two queued humans to have waited out `QUEUE_MAX_WAIT_MS` before a match started, so a lone player queued forever -- contradicting the README promise that "a match can start with as few as one human player" (which only Create Room honored). Changed `Lobby.checkQueue` to start a match once ANY queued player has waited 10s (`waitedCount >= 1`); bots fill the remaining slots as they already did. `QUEUE_MIN_HUMANS` removed as unused. The old behavior was asserted by an explicit test ("does not start a bot-only match for a lone queued human"), so this is a deliberate reversal, not a bug fix: for a game whose bots are good enough to carry a match, an infinite queue is a worse player promise than a bots match.

## 2026-08-14: Procedural-only premium render pass, merged/instanced world

The client's visual upgrade uses zero external assets and no new dependencies: every texture is drawn on a canvas at build-of-scene time (`client/src/render/materials.ts`), every model is authored from Three.js primitives, and the sky is a gradient shader dome plus two star shells (`client/src/render/sky.ts`). Rejected: generated GLB/texture assets -- they would add a download step, an asset pipeline and API credentials to what is otherwise a `npm install && npm run dev` repo.

Draw-call budget is held by merging and instancing rather than by cutting detail. `mapMesh.ts` merges every deck, trim, lane strip and cover block into one mesh per material role via `BufferGeometryUtils.mergeGeometries`, instances the perimeter pylons, rift crystals and the three backdrop tower rings, and `soldier.ts` merges each player down to five meshes. Worst measured active-play frame: 131 calls / 18k triangles desktop, 60 calls / 7.5k triangles at 390x844.

Materials and their textures are owned by one per-match `MaterialLibrary` created in `createScene()` and disposed from `Game.teardown()`. Module-level caching was rejected: `render/dispose.ts` frees a material's textures when it walks the scene, so a cache outliving a match would hand the next match already-disposed GPU objects. For the same reason, anything whose opacity is animated per-prop (beacon pillars, jump-pad shockwaves) gets its own material instead of a shared library role, and pooled projectile meshes are detached rather than disposed on despawn.

`window.__riftlaneRenderInfo()` is installed by `createScene()` and removed on teardown; it returns calls/triangles/geometries/textures/programs plus DPR, shadow map size and exposure for QA and screenshot runs.

## 2026-08-14: 60fps target verified under a full 8-player bot match

Measured on the dev box (Windows 11, headed Chromium via agent-browser, vite dev build, ~2529x1221 canvas): a live Quick Play match (1 human + 7 bots, active combat, flags being capped) sampled twice with an rAF frame-time probe -- 3595 frames over 15s and a 10s repeat. Median frame 4.2ms, p99 4.3ms, worst 8.4ms, zero frames over the 16.7ms 60fps budget. rAF ran unthrottled (~240fps average), so these are true full-frame costs (sim + render), giving roughly 2-4x headroom against 60fps before any production-build minification. Follow-up closed; no rendering optimization warranted at current scene cost (see draw-call budget entry above).

## 2026-08-14: Client reconnects for as long as the page is open, instead of a fixed attempt budget

The client used to give up after 3 attempts over ~6 seconds and tell the player to refresh. That budget cannot outlast the ~60s cold start of the free Render plan this repo deploys to, so the one failure mode the deployment actually has was also the one the client could not survive. Replaced with exponential backoff (1s doubling to a 10s cap, plus jitter so several tabs don't retry in lockstep) that keeps going indefinitely while the page is open.

`disconnected` now means only "the browser reports no network", and even that recovers on its own from the `online` event. `reconnecting` is the state for everything else, and it is amber, not red -- matching what DESIGN.md already said those two colors mean. Returning to a backgrounded tab also triggers an immediate attempt rather than waiting out a throttled timer.

Rejected: a larger fixed attempt count. Any finite budget is a guess about how long the server may be gone, and the honest answer for a sleeping free instance is "longer than you think". A player who has closed the tab costs nothing; a player staring at a dead end costs the session.

## 2026-08-14: Keepalive in both directions, app-level one way and control frames the other

Client to server is an app-level `{t:'ping'}` / `{t:'pong'}` pair every 25s, because browser JavaScript cannot send WebSocket control frames. The server answers it *before* the hello gate: the client defers `hello` until the player's first action, so a socket sitting on the menu pings while still anonymous, and it must not be told "first message must be hello". A ping never assigns a playerId.

Server to client is a real `ws.ping()` sweep every 30s; browsers auto-answer it with no client code involved. A socket that misses one sweep is terminated, which is what makes `lobby.disconnect` run for a player whose network vanished without a TCP FIN instead of holding their match slot until the OS gives up.

The client also treats total silence for 60s as a dead socket and replaces it, rather than sitting on a black-holed connection: pongs land every 25s and a live match sends snapshots 20x a second, so silence that long is never normal.
