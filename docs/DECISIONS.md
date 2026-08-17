# Decisions

Durable architecture and design decisions for RIFTLANE. One dated entry each; alternatives rejected noted where relevant.

## 2026-08-17: The flag is a real flag, and the stand is only its plinth

The objective is now an actual flag -- mast, spear finial, and a cloth banner that ripples on a vertex-shader wave with a team crest woven into it (`client/src/render/flag.ts`). It is built per team by `mapMesh.ts` as a direct child of the map group, NOT as a child of the flag-stand beacon, because it has to leave the stand: `syncFlags()` reads `snapshot.flags[i]` every frame and puts it on its stand, lays it over where it was dropped, or hides it because a carrier is wearing it.

The client previously drew no flag at all. The stand was an abstract beacon that never moved, and **a dropped flag was completely invisible** -- `snapshot.flags` was on the wire and never read, so the only way to find a loose flag was to run over it. That was a gameplay hole, not just a cosmetic one.

Two parts of the old beacon were deleted rather than kept: the floating octahedron core and the 26m additive light pillar. They existed because the stand had to BE the landmark; with a flag planted in it they actively fought it (a spinning crystal hovered in front of the cloth, and the pillar plus the flag's own locator shaft washed the base area pale). The flag carries a much narrower 8m shaft instead, which travels with it and is what makes a dropped flag findable. Lesson worth keeping: an additive column wide enough to notice up close is wide enough to be an artifact -- buy visibility with opacity, not width.

Cloth wave: `onBeforeCompile` on a `MeshPhysicalMaterial` so the banner keeps stock PBR lighting, fog and shadows, with the displacement AND the normal derived from one shared GLSL wave function (a normal derived from a different wave than the displacement is what makes cloth read as a painted card). Rejected: simulated cloth -- a per-frame solve for 140 vertices nobody can interact with. The field and crest textures are painted colourless and tinted at the material, so one pair on the `MaterialLibrary` serves both teams and the banner on a carrier's back can be re-tinted the instant they steal either flag.

## 2026-08-17: Environment map instead of exposure, for the PBR mid-tones

`createScene()` bakes a neutral `RoomEnvironment` PMREM into `scene.environment` at `environmentIntensity` 0.45, and `EXPOSURE` comes back down from 1.55 to 1.3.

Nearly every material here is a metal (`MaterialLibrary.hull` is metalness 0.55, `trim` is 0.85) and none of them had anything to reflect, which is the documented reason metals read as flat grey. The earlier measurement -- median scene luminance 10/255, 77% of pixels under 20/255 -- was a symptom of that, and raising exposure to 1.55 traded crushed blacks for clipped whites: base platforms and rim trim blew to near-white against near-black walls. A bimodal histogram reads as cheap no matter how good the geometry is. The env map fills the dark end so the exposure crank is not needed.

This does not break the 2026-08-14 "procedural-only, zero external assets" rule: `RoomEnvironment` is authored from Three.js primitives in the addons, so there is still no download step and no credentials. Cost is one PMREM bake per match and one cube texture; nothing per frame. Kept at 0.45 because above ~0.6 the neutral bake starts flattening the authored dusk key/rim lighting into an evenly-lit studio look. The render target is disposed with the scene.

Same pass: `makePanelTexture`/`makeDeckTexture` dropped from 2600/3000 random specks to 260/320 at lower contrast. At one tile per 3 world metres a 40m wall seen from 3m put every speck on several screen pixels, so the surface read as dirt and drowned out the authored panel seams and bolts -- the detail that actually says "built object". The env map now carries most of the "no large surface reads flat" job those specks were doing.

## 2026-08-17: Random spawn loadouts, and no weapons on the map at all

Reverses the "fixed spawn pair" half of the 2026-08-15 sandbox entry below, on
Wes's call. Every life rolls two DIFFERENT weapons out of the full
`WEAPON_POOL` (`rollLoadout`), and all three maps dropped their `powerPickups`
tables, so the spawn roll is the only way a weapon enters a fight.

The roll deliberately includes the power tier. Excluding it would be the safer
balance choice, but with no pads left it would also make the sniper, rocket,
sword and hammer unreachable -- five of eleven guns would be dead code.
Accepted consequence: a life can start with two power melees and no answer at
20m, which is exactly what the 08-15 entry called out as the old roll's flaw.

The pickup machinery (`stepPickups`, the `pickups` snapshot field,
`EffectsSystem.syncPickups`, the pad holograms) is kept, not deleted. It is
data-driven off `map.powerPickups`, costs one early return per tick with no
pads, and `shared/test/sim.test.ts` still exercises it against an injected pad
-- so pads can come back as map data alone. `server/test/match.test.ts` now
pins the other side of that: no map ships pads, and the snapshot omits
`pickups` entirely.

Measured cost, gutter seed 42: kills per match 153 -> 309, and the seeded
8-bot match stopped reaching a decisive 3 captures inside the clock. Lethality
roughly doubles when everyone carries power weapons, so flag carriers die more
and captures slow down. The two bot-match canaries in
`server/test/brain.test.ts` now run seeds 1..3 and assert per-seed that a
runner reaches the enemy flag (the nav property one match shows reliably) and
only in aggregate that offense scores -- pinning one seed was measuring the
seed, not the bots.

## 2026-08-17: Weapons play generated samples; synthesis is the fallback

Every gun and the explosion now play an ElevenLabs-generated sample; the
hand-written oscillator recipes in `audio.ts` stay as the fallback for the
frames before a file loads, and for a 404 or decode failure. Wes's report was
that the game sounded like a child's toy, and the code agreed: `shot_rifle`
was a 700Hz square wave and `shot_rail` a falling sine chirp, i.e. a beep and
a cartoon laser, with eleven named Halo guns sharing four recipes.

Per-weapon files, not per-category: the Bulldog, the BR and the Commando were
literally the same sound before. Routing is `audioEngine.playWeapon(weaponId)`
keyed off `WEAPON_SFX` in `audio.ts`, so weapon-to-sound knowledge left
`game.ts` entirely; `SAMPLE_URLS` does the same for a `SoundName` (explosion)
with no call-site change.

Mastering lives in `scripts/gen-weapon-sfx.sh`, not in the engine: length and
level are baked into the files because this engine has no per-sound gain, and
the table there is the actual weapon mix. Two things that had to be measured
rather than guessed -- the MA40 sample is trimmed to 300ms because it fires
every 100ms and a 0.8s sample stacks eight deep into mud, and generations open
with up to 100ms of dead air (the first shotgun's bang landed at 0.10s), so
every file gets `silenceremove` before the transient.

Also fixed in passing: an unarmed beatdown was silent. Power melee emits a
paired `shot` event, a bare melee only emits `melee_swing`, and nothing played
that recipe.

Supersedes the "announcer is Web Speech API because the key is missing" note
below: `ELEVENLABS_API_KEY` is present in `.env` now and generation works.

## 2026-08-15: Halo Infinite weapon sandbox -- fixed spawn pair, two pad tiers

The 11-weapon roster mimics Halo Infinite directly (MA40, MK50, BR75, VK78
Commando, Bulldog, Needler, Cindershot, S7 Sniper, SPNKR, Energy Sword,
Gravity Hammer). Full stat table, time-to-kill proofs and the tournament that
produced it: `docs/superpowers/specs/2026-08-15-halo-gun-roster-design.md`.

Three structural choices, each rejecting a plausible alternative:

**Random loadouts are gone.** Every player and bot spawns with the same
MA40 + MK50 + 2 frags. Halo has no loadouts, every fight now starts from a
known baseline, and map pads are the only variable. The old 2-of-10 roll
could hand one player an Energy Sword against someone else's Needler, and it
regularly respawned bots holding two weapons that could not answer at 20m.
Rejected: keeping the roll but weighting it -- that preserves the actual
problem (an unknowable opening matchup) for no gain.

**One weapon opts out of the shield gate, not zero and not several.**
`headshotIgnoresShield` is set on railspike alone, which is what makes a
sniper headshot a one-shot kill through a full shield. The two-stage
strip-then-headshot kill stays the baseline for every other weapon, and a
test pins that only railspike carries the flag. Rejected: removing the gate
(deletes the sandbox's whole combat identity) and leaving it (the sniper
simply does not exist -- the old code comment said as much).

**The Gravity Hammer is an area weapon, or it is just a worse sword.**
`aoeMelee` makes one swing kill every enemy in the melee cone. Without it the
hammer was a shorter, slower Energy Sword with no reason to exist. It costs
~5 lines in `doMeleeAttack`.

Equipment stays a spawn roll rather than a map pickup: `map.powerPickups` is
typed to `WeaponId`, so putting equipment on pads is a schema change, not a
tune. Deferred deliberately.

## 2026-08-15: Weapon pads are a human-facing layer for now

SUPERSEDED 2026-08-17: no map carries pads any more (see the top entry). The
placement doctrine below is kept because the pad code and the map-symmetry test
still work off it, so it is what any future pad layout has to satisfy.

All three maps carry the two-tier pad layout, and pad positions stay
symmetric under each map's own transform (bastion/gutter rotate180, hairpin
mirrorX) -- `shared/test/map.test.ts` enforces this on the set as a whole.
Power pads sit on the route BETWEEN bases and never inside a flag room,
because the same one-hit melee that reads as a push tool at mid reads as an
unbreakable flag camp where a defender already stands.

Bots do NOT path to pads. They collect what they walk over, nothing more, so
a seeded bot match is still fought mostly with the spawn pair. Teaching them
to fetch pads measurably broke bot navigation on bastion; the full autopsy
and the reason it is a Navigator problem rather than a weapons one is in
`docs/ERRORS.md` (2026-08-15).

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

## 2026-08-14: Session resumption holds a dropped player's seat for 60s behind a bearer token

A dropped socket used to end the match outright for a solo player: `disconnect` called `leaveRoom`, the room emptied, and `HostedMatch.stop()` ran. Now `Lobby.disconnect` distinguishes "went away" from "blinked". A player who drops out of a live match is *suspended* rather than forgotten: `removeHuman` still swaps in a stand-in bot (which already inherits their kills/deaths/captures, so the scoreboard doesn't lose a name), but the PlayerConn stays in the room with its `send` replaced by a discard, and `resume()` can reclaim the seat for `RESUME_GRACE_MS`.

The token is a separate `randomUUID`, deliberately NOT the playerId: playerIds are broadcast to every client in rosters and snapshots, so using one as the credential would let any player steal any other player's seat. It is echoed back rather than rotated on resume, so repeated drops keep working. The client keeps it in `sessionStorage`, not `localStorage` -- it is a bearer token for one seat, and a second tab must not be able to take the match from the first. sessionStorage still survives a reload of the same tab, which is the case worth surviving.

Two consequences worth knowing. A room now outlives its last human by up to 60s, so `Lobby.stop()` had to start stopping running matches explicitly (nothing else would), and an expiry sweep runs on the existing queue timer rather than a new one. And resumption is in-memory only: a server restart loses every match, so the free plan waking from sleep still gives everyone a fresh session. Persisting match state was rejected as far more machinery than a browser game with 8-minute rounds is worth.

Rejected: preserving the exact body (position, health, carried flag) by flipping the existing sim player between human and bot control. It is better gameplay, but it reaches into the sim's player model, the `bot-N` id convention, `humanIds`, brain keying and the determinism contract. Rejoining from a spawn point is normal for shooters and costs one function parameter (`addHuman(id, name, team?)`).

## 2026-08-14: Halo feel pass -- tuning decisions that must not silently regress

From the design-tournament synthesis (5 designers / 3 judges), locked by regression tests in `shared/test/combat.test.ts`:

- **FOV is 90 vertical, on purpose.** three.js `PerspectiveCamera.fov` is VERTICAL; the earlier 105 was ~133 horizontal at 16:9, shrinking every target. 90 vertical is ~121 horizontal, top of Halo Infinite's band. Rejected: 100-120 "because Halo's slider says so" -- those are horizontal numbers.
- **`PLAYER_GRAVITY` (24) is separate from `GRAVITY` (20).** Movement got a snappier arc; grenade/projectile arcs kept the old constant. Launch-pad velocities were rescaled by k = sqrt(24/20) so every pad trajectory lands where it did before (velocity x k, gravity x k^2 preserves the path). Change one, retune the other.
- **Hit spheres 0.58/0.3 are aim forgiveness, not collision.** The movement AABB stays PLAYER_RADIUS 0.4; only shot contact tests use the wider spheres. Rejected: cursor-side bullet magnetism -- server-side generous volumes are prediction-safe and identical for everyone.
- **Everyone spawns with the Triad Rifle; only the second slot is random.** Pure random loadouts could roll two melee weapons (no gun at all). Rejected: removing power weapons from the pool -- without map pickups shipped, that deletes them from the game. SUPERSEDED 2026-08-14: player asked for fully random spawn guns. Slot 0 now rolls from the ranged-only pool (`RANGED_POOL` in `shared/src/weapons.ts`), slot 1 from everything else -- keeps the "always at least one gun" invariant this rule existed for, without the fixed starter. Same date, later pass: all trauma screenshake removed (`ShakeRig` deleted; recoil pitch kick and landing dip kept), and the ADS reticle is a 4px precision dot instead of the 36px cross so scoped headshots have a clear aim point.

- **No camera recoil. The view never moves when you shoot.** SUPERSEDES the "recoil pitch kick kept" clause above (2026-08-17, player asked for it -- same call as the screenshake removal, and it stays removed for the same reason). The kick was client-only cosmetic pitch: bullets always used `look.pitch`, so it moved the picture and never the shot -- a lie the player has to fight. `game.ts` now has exactly ONE writer of `camera.rotation.x` (`= look.pitch`), which is the check: if a second one appears, recoil is back. Shot feedback still exists and is intentionally kept -- the viewmodel kick (`kickT`, which also drives the muzzle flare) and the 6px crosshair kick. Per-weapon bullet `spread` in `shared/src/weapons.ts` is a different thing (accuracy, not recoil) and is untouched.
- **Bot `aimErrorDeg` is 16/8/3.6, doubled from the original 8/4/1.8 (2026-08-17).** The first ladder was calibrated while bots could not physically hold a yaw -- a flag-stand guard wobbled 57 deg/tick, and that wobble WAS the difficulty. `fdcafc3` fixed the vibration (correctly, and it stays), dropping jitter to 11.6 deg/tick and raising non-carrier bot speed 4.15 -> 5.73 m/s, which silently made every tier far more lethal than its numbers claimed and collapsed bot offense to a 5% flag conversion. Doubling restores the intended challenge and keeps the ~2x tier spacing. Rejected first, each measured: more runners (conversion fell 5% -> 3%), a wider defender patrol ring (bastion went to zero captures), and a shields-broken regroup behaviour (raised EHP-at-pickup 29 -> 40, conversion unmoved). Full autopsy in `docs/ERRORS.md`. **A bug can be load-bearing: fixing one invalidates every constant tuned around it.**
- **`sprint`/`slideRequest` are OPTIONAL `PlayerInput` fields.** Bots and old tests omit them and behave bit-identically (pinned by test). Required fields would have broken 6 files mechanically for two booleans.
- **Clamber is airborne-only with a 0.6m minimum ledge** so the 0.5m guard-rail curbs (the "too easy to fall off" fix) can never be auto-mantled -- the two features are load-bearing against each other.

## 2026-08-14: MVP-to-real-game pass -- decisions that shape future work

Shipped from an adversarially-verified audit (25 confirmed findings) plus three requested features. The load-bearing choices:

- **Camera rotation is client-authoritative per render frame** (`game.ts` reads `input.getLookAngles()` every rAF); camera POSITION interpolates between the previous and current predicted 30Hz tick by the accumulator fraction. This costs one fixed tick (~33ms) of position latency and is what killed the 30Hz camera stepping. Do not move rotation back behind the tick accumulator.
- **Corrections over 2.5m snap instead of easing** (`CORRECTION_SNAP_DIST`, client/src/predict.ts) -- a big misprediction glides forever if eased proportionally.
- **Gamepad is polled, not evented, and pad-active is a mode**: any pad activity claims input, any real (non-zero-delta) mouse move hands it back -- checked BEFORE the pointer-lock gate in onMouseMove, because a pad player never holds lock. While pad-active, missing pointer lock does not show the pause panel.
- **Analog movement scales wishSpeed by min(1, |stick|)** in stepMovement; keyboard diagonals (magnitude sqrt2) clamp to 1, bit-identical to before. Inputs are clamped [-1,1] server-side as a trust boundary.
- **Warmup is a sim phase, not a lobby timer** (`beginWarmup(WARMUP_SEC)`): movement live, fire/grenades/flags inert, timeLeft carries the countdown, `match_go` event flips it. A sim that never calls beginWarmup behaves exactly as before (all older tests unchanged).
- **Power pickups replace the ACTIVE slot** on walk-over (skip if already carried in either slot), respawn on a per-pad timer, and are snapshot as a boolean array aligned with `map.powerPickups`. Bots ignore pads for now.
- **Swap now clears the outgoing weapon's fire/reload cooldown** (only swapCooldownUntil gates the incoming gun) -- Halo-style swap-cancel is intentional, including reload-canceling.
- **Spawn protection (2s) is enforced in applyDamage as a single choke point** and broken by the protected player's own fire; carried on the wire as `prot` so the soldier shimmers.
- **bastion map rules**: rotate180-symmetric everything (geometry, pads, waypoints, edges); walk edges need >=1.5m of straight-line clearance because bots have no avoidance; clamber-mountable ledges stay <=1.2m. The bastion bot-capture test in server/test/brain.test.ts is the canary -- if a map edit breaks it, fix the map, not the bots.
- **Warmup countdown banner renders at top 15%**, above the centered pause panel -- at match start both are on screen at once (no pointer lock yet), and at 40% the digit printed across the Resume button.

## 2026-08-14: Controls-fix pass -- three invariants that must not be "simplified" back

Shipped after a playtest found the previous pass unplayable. Full incident in `docs/ERRORS.md`.

- **Ground friction runs on EVERY grounded tick, before accelerate** (`physics.ts`), the Quake/Source order. It previously ran only on ticks with no movement key held; since `accelerate()` only adds speed along wishDir, nothing bled off the orthogonal component and no diagonal ever converged (~10 degrees instead of 45). Rejected: special-casing diagonal input, which treats the symptom.
- **`ACCEL_GROUND` is 120, not 60.** This is a direct consequence of the above: with friction running continuously, holding a direction settles at wishSpeed only while `ACCEL_GROUND*dt >= wishSpeed*FRICTION_GROUND*dt`. At the sprint wishSpeed of 9.1 that needs >= 72.8, so 60 silently capped every sprint at 7.5 m/s. Change one of these two and you must recheck the other.
- **Keyboard and mouse-button state are never gated on pointer lock** (`input.ts`); only mouselook is. Lock resolves ~160ms after the click that requests it, so gating fire on it swallowed every match's first trigger pull, and gating keys on it turned any Alt-Tab into a silently unresponsive game. Held state clears on lock loss and window blur, and the HUD shows CLICK TO RESUME (kept `pointer-events:none` so it cannot eat the recovering click). Rejected: "just make pointer lock more reliable" -- the game must stay playable when lock is refused outright.
- **Ammo stays at 0 for the whole reload lockout** and refills when it expires, so the HUD can show RELOADING. Refilling on the emptying shot displayed a full magazine on a weapon that would not fire for two seconds.
- **Both maps are one continuous floor.** Death pits are gone and the guard curbs that existed only to fence them are removed; `deathY` remains as an unreachable safety net. Rejected: keeping pits as a "skill check" -- the player asked for them gone, and they were the single most common death.

## 2026-08-14: Flag carriers move at full speed, and melee has its own cooldown

Both changes came out of measuring 5 seeded 8-bot matches rather than guessing at feel.

- **`FLAG_CARRIER_SPEED_MULT` 0.9 -> 1.0.** With the penalty, first capture landed as late as 257s and 2 of 5 seeded matches never reached a decisive score inside the full 480s clock. At 1.0, first capture lands within 10-14s and matches resolve in 28-224s, with the kill rate unchanged at ~29/min -- so the fighting was never the problem, the scoring was. Carriers already pay for the flag by being unable to shoot at all, which is also how Halo handles it. Rejected: shortening `MATCH_TIME` instead, which would have hidden the stall rather than fixed it.
- **Melee runs on its own `meleeCooldownUntil`, checked before the weapon cooldown.** It used to share `cooldownUntil` with weapon fire, so an empty magazine left the player with no action whatsoever for the whole `RELOAD_TIME` lockout. Melee is now always available on its own 0.8s cadence, including while reloading and while carrying the flag. This makes flag carriers meaningfully better duelists, which is intended.

## 2026-08-14: Halo pass 2 -- the shield fight made legible, plus a voice

Ten changes from the second design tournament (7 designers / adversarial
verifier / 3 judges). The tournament's own verdict was that RIFTLANE already
*simulates* a Halo fight but does not *report* one, so most of this pass is
readout, not systems.

- **Headshots are shield-gated.** `stepFire` applies `headshotMult` only when
  `target.shield <= 0`, read before `applyDamage` so a multi-pellet burst can
  strip with pellet 1 and land the multiplied finisher with pellet 2 in one
  trigger pull. This is the two-stage strip-then-finish kill that separates
  Halo from a flat TTK race. **Consequence: railspike no longer one-taps a
  full-shield player** (70, not 140) -- the comment in `weapons.ts` that said
  it "still always does" was updated, and `sim.test.ts`'s head-flag test now
  strips the shield first, because a full-shield headshot emits no kill event
  at all to assert against.
- **The per-hit spark is the other half of that rule, not a separate feature.**
  Ship them together. The gate alone reads as "my headshots broke"; the spark
  (icy blue into shield, `--danger` red into health) is what teaches the
  boundary without a number. Throttled to 60ms per target because the spark
  pool is 12 slots shared with explosions and death bursts.
- **The shield recharge chime lives in `playSnapshotAudio`, NOT the `tick()`
  prevShields loop the design brief pointed at.** `tick()` runs ~3x per
  snapshot, so a sound fired there triple-fires; the file's own comment says
  exactly that. It is gated to the local player and to reaching FULL shield,
  or eight regenerating bots turn it into ambient chiming.
- **Backsmack is measured against the TARGET's facing, not the attacker's.**
  A 100-degree rear cone (`BACKSMACK_VIEW_CONE`, full-angle convention like
  `MELEE_VIEW_CONE`) substitutes `ONE_HIT_KILL_DAMAGE`, and the kill is
  reported as weapon `'backsmack'` so the feed, the sound and the announcer
  can all distinguish it with no new SimEvent field. Measuring off the target
  means a player who turns in time has defended themselves, which makes the
  flank a read rather than a damage bonus.
- **`spree` is an OPTIONAL PlayerState field and `streak` an OPTIONAL kill-event
  field**, following the `sprint`/`slideRequest` precedent so hand-built states
  and older tests stay valid. The victim's spree is zeroed inside `killPlayer`
  itself -- otherwise a spree only ends at respawn and a player who stays dead
  keeps a live counter.
- **The HUD's multikill counter is the single source of truth.** `hud.ts`
  already ran a 4.5s window for its on-screen banner; the announcer reads that
  instead of keeping its own, because two independent windows eventually
  disagree about the same kill. `match.ts` reuses the same 4.5s constant for
  medals for the same reason.
- **The announcer is Web Speech API, and that is a fallback, not a preference.**
  Real VO was the better answer; the ElevenLabs probe returned
  `ELEVENLABS_API_KEY=MISSING` in both the environment and `.secrets.env`, so
  it is blocked, not skipped. Every line lives in the `BARKS` table with an
  unused `src` field: fill those in and teach `speak()` to prefer `src`, and no
  call site changes. It is volume-linked to `settings.volume` because TTS
  cannot be routed through the WebAudio graph and would otherwise ignore mute.
- **Medals are server-side and end-of-match only.** The tally rides the
  SimEvent stream `tickOnce` already drains and is read once in
  `broadcastMatchEnd`, so it never touches the 20Hz snapshot path or the 60fps
  budget. `BoardRow` gained `id` and `team` (the client could not tell which
  row was yours, which also blocked the victory/defeat bark).
- **The motion tracker is speed-gated only.** There is no crouch state in the
  sim, so a slow walk is the only way to drop off it. It is a pure client read
  of data `match.ts` already broadcasts to everyone with no LOS filter -- no
  protocol change. Blips use cobalt/ember (team identity), never the state
  colours, per DESIGN.md.
- **Rejected: the MARK ping and a grenade danger indicator.** MARK is the most
  protocol-expensive idea available for a signal bots cannot read, in a lobby
  that is usually one human and seven bots. The screen-edge grenade warning is
  a Call of Duty convention; Halo deliberately makes grenade danger something
  you read from the clink and the arc.
