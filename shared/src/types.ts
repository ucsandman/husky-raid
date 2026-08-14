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
  grenades: { frag: number; mag: number }
  equipment: EquipmentId | null
  equipmentCharges: number
  equipmentCooldownUntil: number
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
}
