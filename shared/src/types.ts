export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface AABB {
  min: Vec3
  max: Vec3
}

export interface PlayerInput {
  seq: number
  dt: number
  yaw: number
  pitch: number
  forward: number
  strafe: number
  jump: boolean
  fire: boolean
  melee: boolean
  grenade: boolean
  equipment: boolean
  swap: boolean
  sprint?: boolean
  slideRequest?: boolean
  /** Optional so bots, defaultInput, and every existing test helper keep
   * compiling untouched -- same convention as sprint/slideRequest above. */
  ads?: boolean
}

export type Team = 0 | 1

export type WeaponId =
  | 'pulse_smg'
  | 'triad_rifle'
  | 'railspike'
  | 'boomtube'
  | 'scattergun'
  | 'sidearm'
  | 'swarm_pod'
  | 'ion_charger'
  | 'arc_blade'
  | 'grav_maul'

export type EquipmentId = 'grapple' | 'repulsor' | 'camo'

export interface PlayerState {
  id: string
  name: string
  team: Team
  bot: boolean
  pos: Vec3
  vel: Vec3
  yaw: number
  pitch: number
  grounded: boolean
  shield: number
  health: number
  alive: boolean
  respawnAt: number
  lastDamageAt: number
  weapons: [WeaponId, WeaponId]
  activeWeapon: 0 | 1
  ammo: [number, number]
  cooldownUntil: number
  /** Absolute sim timestamp, same convention as cooldownUntil above (not a
   * countdown like teleportCooldownUntil) -- gates grenade throws. */
  grenadeCooldownUntil: number
  grenades: { frag: number; mag: number }
  equipment: EquipmentId | null
  equipmentCharges: number
  equipmentCooldownUntil: number
  /** Absolute sim timestamp, same convention as cooldownUntil above (not a
   * countdown like teleportCooldownUntil) -- gates weapon-slot swaps. */
  swapCooldownUntil: number
  /** Melee's own absolute-timestamp cooldown, deliberately separate from
   * cooldownUntil: melee stays available while the weapon is on its rate-of-
   * fire cooldown or locked out reloading, so an empty magazine never leaves
   * the player with no action at all. */
  meleeCooldownUntil: number
  camoUntil: number
  carryingFlag: Team | null
  stuckDarts: number
  kills: number
  deaths: number
  captures: number
  /**
   * NOT an absolute timestamp, unlike its *Until/*At siblings above
   * (cooldownUntil, equipmentCooldownUntil, camoUntil, respawnAt,
   * lastDamageAt). stepMovement has no global clock — only a per-tick
   * dt — so this is a countdown of seconds remaining: it decrements by
   * dt every tick, floors at 0, and resets to TELEPORT_COOLDOWN on
   * teleport. Compare with `<= 0`, not against a "now".
   */
  teleportCooldownUntil: number
  /** True while the player is currently sprinting (recomputed every tick
   * from input + grounded/sliding/fire state, not a countdown). */
  sprinting: boolean
  /** True while the player is currently sliding. */
  sliding: boolean
  /**
   * NOT an absolute timestamp -- same countdown convention as
   * teleportCooldownUntil above: seconds remaining, decremented by dt every
   * tick, floors at 0. Slide ends when this reaches 0 (or on an early-exit
   * condition -- see stepMovement).
   */
  slideTimeRemaining: number
  /** Countdown (seconds remaining), same convention as teleportCooldownUntil. */
  slideCooldownRemaining: number
  /** Countdown (seconds remaining), same convention as teleportCooldownUntil. */
  coyoteTimeRemaining: number
  /** Countdown (seconds remaining), same convention as teleportCooldownUntil. */
  jumpBufferRemaining: number
  /** True while the player is currently aiming down sights (scoped) --
   * recomputed every tick directly from input.ads, mirroring how
   * sprinting is recomputed from input.sprint. Tightens hitscan/burst
   * spread (ADS_SPREAD_MULT) and slows ground movement (ADS_MOVE_MULT);
   * sprint is disabled outright while scoped. */
  scoped: boolean
}
