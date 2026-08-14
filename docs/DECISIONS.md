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
