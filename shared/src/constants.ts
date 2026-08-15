export const TICK_RATE = 30
export const TICK_DT = 1 / 30
export const SNAPSHOT_RATE = 20
/** Pre-combat warmup: players can move but not fire/grab flags; HUD counts
 * it down and flips to FIGHT on the match_go event. */
export const WARMUP_SEC = 5
/** Respawn protection window (absolute-timestamp field spawnProtectedUntil);
 * cleared early the moment the protected player fires. */
export const SPAWN_PROTECT_SEC = 2
/** XZ radius within which an alive player collects a power-weapon pad. */
export const PICKUP_RADIUS = 1.4
export const MOVE_SPEED = 7
// Flag carriers move at full speed, as in Halo -- they already pay for the
// flag by being unable to shoot at all. Measured over 5 seeded 8-bot matches,
// the old 0.9 penalty pushed first capture out to as late as 257s and left 2
// of 5 matches unresolved after the full 480s clock; at 1.0 first capture
// lands within 10-14s and matches resolve in 28-224s, with the kill rate
// unchanged at ~29/min. Slowing the carrier did not make defending
// interesting, it just stopped anyone from scoring.
export const FLAG_CARRIER_SPEED_MULT = 1.0
// Ground acceleration must out-pull ground friction, which now runs on every
// grounded tick (see physics.ts): holding a direction settles at wishSpeed
// only while ACCEL_GROUND*dt >= wishSpeed*FRICTION_GROUND*dt. At the sprint
// wishSpeed of 9.1 that needs >= 72.8; 60 capped every sprint at 7.5 m/s.
// 120 sustains sprint with margin and reaches full speed in ~3 ticks (0.1s),
// which is the snappy ground feel this pass is after.
export const ACCEL_GROUND = 120
export const ACCEL_AIR = 20
export const FRICTION_GROUND = 8
export const GRAVITY = 20
export const JUMP_SPEED = 8
// Snappier jump arc: used ONLY by stepMovement's own vel.y integration.
// GRAVITY above stays 20 for grenade/projectile arcs in combat.ts/sim.ts.
export const PLAYER_GRAVITY = 24
export const PLAYER_RADIUS = 0.4
export const PLAYER_HEIGHT = 1.8
export const EYE_HEIGHT = 1.6
export const MAX_SHIELD = 70
export const MAX_HEALTH = 30
export const SHIELD_RECHARGE_DELAY = 4
export const SHIELD_RECHARGE_RATE = 35
export const MELEE_DAMAGE = 35
export const MELEE_RANGE = 2
export const MELEE_COOLDOWN = 0.8
export const RESPAWN_DELAY = 4
export const FLAG_RETURN_TIME = 15
export const CAPTURES_TO_WIN = 3
export const MATCH_TIME = 480
export const TEAM_SIZE = 4
export const INTERP_DELAY = 0.1
export const CAMO_DURATION = 8
export const GRAPPLE_RANGE = 20
export const GRAPPLE_CHARGES = 3
export const GRAPPLE_COOLDOWN = 2
export const REPULSOR_CHARGES = 2
export const REPULSOR_RADIUS = 4
export const REPULSOR_IMPULSE = 14
export const TELEPORT_COOLDOWN = 1
export const TELEPORT_ARRIVAL_OFFSET = 1.5

// Movement: coyote time (jump still fires shortly after walking off an
// edge) and jump buffer (an early jump press fires on landing) -- both
// countdowns, same convention as teleportCooldownUntil.
export const COYOTE_TIME = 0.15
export const JUMP_BUFFER_TIME = 0.15

// Movement: sprint (hold-to-run) and slide (grounded, forward-momentum burst).
export const SPRINT_SPEED_MULT = 1.3
export const SPRINT_MIN_FORWARD = 0.1
export const SLIDE_SPEED_MULT = 1.3
export const SLIDE_DURATION = 0.65
export const SLIDE_FRICTION = 2
export const SLIDE_MIN_SPEED = 5.5
export const SLIDE_COOLDOWN = 0.4

// Movement + Combat: aim-down-sights (ADS/scope, input.ads). Tightens
// hitscan/burst pellet spread and slows ground movement while held; sprint
// is disabled outright while scoped (see stepMovement's sprint gate).
// Power-melee weapons are unaffected (no spread to tighten).
export const ADS_SPREAD_MULT = 0.35
export const ADS_MOVE_MULT = 0.75

// Movement: airborne ledge clamber (auto-mantle onto a ledge in front of
// the player while jumping/falling into it -- grounded strafes into the
// same ledge are never affected, see tryClamber's airborne-only gating).
export const CLAMBER_MIN_HEIGHT = 0.6
export const CLAMBER_MAX_HEIGHT = 1.4
export const CLAMBER_CHECK_DISTANCE = 0.6
export const CLAMBER_BOOST_SPEED = 6

// Sandbox: melee lunge speed toward the target, horizontal only, grounded only.
export const MELEE_LUNGE_SPEED = 8

// Sandbox: backsmack (Halo's rear-arc instant-kill beatdown). Full cone
// angle measured around the target's OWN backward direction, same
// full-angle convention as MELEE_VIEW_CONE above (both are halved at the
// comparison site). 100 degrees is wide enough that a flank read lands
// without demanding a pixel-perfect rear approach, and narrow enough that
// a side-on scuffle is still a normal beatdown.
export const BACKSMACK_VIEW_CONE = (Math.PI * 100) / 180

// Combat: hit-sphere geometry (raycast + projectile contact tests share these).
// Widened from 0.5/0.25 (Halo-style generous hit volumes -- the actual
// collision AABB stays PLAYER_RADIUS 0.4, this constant only controls how
// forgiving a shot is, not where the body physically blocks movement).
export const PLAYER_BODY_CENTER_Y = 0.9
export const PLAYER_BODY_RADIUS = 0.58
export const PLAYER_HEAD_CENTER_Y = 1.55
export const PLAYER_HEAD_RADIUS = 0.3

// Combat: grenades (not weapons, so not in WEAPONS table).
export const FRAG_DAMAGE = 90
export const FRAG_RADIUS = 4
export const FRAG_FUSE = 2
export const FRAG_BOUNCE_DAMPING = 0.5
export const MAG_FUSE = 1.5
export const MAG_DAMAGE = 110

// Combat: projectile homing (swarm_pod; also available to ion_charger's
// "slight tracking" once a future task starts populating homingTargetId
// on ion_charge projectiles at spawn time)
export const HOMING_TURN_RATE = 4 // rad/s

// Combat: homing target acquisition cone at spawn time, half-angle from the
// shooter's aim direction (~30 degrees, per spec's "forward cone").
export const HOMING_CONE_ANGLE = Math.PI / 6

// Combat: swarm pod stick-pop bonus
export const SWARM_POP_THRESHOLD = 6
export const SWARM_POP_DAMAGE = 80

// Combat: mag grenade splash radius (sticks to a player, then explodes;
// no radius constant existed for it — added per Task 6).
export const MAG_RADIUS = 3

// Sim: CTF flag interaction distances.
export const FLAG_PICKUP_RADIUS = 1.5
export const CAPTURE_RADIUS = 2

// Sim: basic melee + power-melee weapons (arc_blade/grav_maul) only land
// on targets within this forward-facing cone, in radians (60 degrees).
export const MELEE_VIEW_CONE = Math.PI / 3

// Sim: grenade throw muzzle velocity.
export const GRENADE_THROW_SPEED = 18

// Sim: grapple pulls the player toward the raycast hit point at a speed
// proportional to distance (closes the gap in ~1 tick), capped here.
export const GRAPPLE_MAX_SPEED = 30

// Sim: repulsor's own re-activation cooldown (separate from GRAPPLE_COOLDOWN).
export const REPULSOR_COOLDOWN = 3

// Sim: respawn picks the spawn point with the fewest live players within
// this radius, to avoid spawning on top of teammates.
export const SPAWN_CROWD_RADIUS = 2

// Sim: safety despawn timer for contact-only projectiles (boomtube,
// ion_charge, swarm_dart) that never hit anything — without this they'd
// fly forever and leak. frag/mag already detonate on their own FRAG_FUSE/
// MAG_FUSE regardless of contact, so this is unrelated to those.
export const PROJECTILE_LIFETIME = 10

// Sim: minimum time between grenade throws (frag or mag).
export const GRENADE_COOLDOWN = 1

// Combat: default max raycast distance for hitscan/burst weapons that
// don't set their own WeaponDef.maxRange.
export const HITSCAN_MAX_RANGE = 1000

// Combat: fallback projectile speed for a WeaponDef with no
// projectileSpeed set.
export const DEFAULT_PROJECTILE_SPEED = 20

// Sim: minimum time between weapon-slot swaps.
export const SWAP_COOLDOWN = 0.5

// Sim: time a weapon is locked out after its magazine empties, before
// ammo refills and it can fire again. Power-melee weapons never reach
// this path (they return before the ammo check in stepFire).
export const RELOAD_TIME = 2
