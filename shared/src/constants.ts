export const TICK_RATE = 30
export const TICK_DT = 1 / 30
export const SNAPSHOT_RATE = 20
export const MOVE_SPEED = 7
export const FLAG_CARRIER_SPEED_MULT = 0.9
export const ACCEL_GROUND = 60
export const ACCEL_AIR = 15
export const FRICTION_GROUND = 8
export const GRAVITY = 20
export const JUMP_SPEED = 8
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

// Combat: hit-sphere geometry (raycast + projectile contact tests share these)
export const PLAYER_BODY_CENTER_Y = 0.9
export const PLAYER_BODY_RADIUS = 0.5
export const PLAYER_HEAD_CENTER_Y = 1.55
export const PLAYER_HEAD_RADIUS = 0.25

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
