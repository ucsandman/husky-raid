import type { WeaponId, EquipmentId } from './types'
import { MAX_SHIELD, MAX_HEALTH } from './constants'

/** Guaranteed one-hit kill regardless of shield/health split: any value > the full pool (shield + health) always finishes the target. */
export const ONE_HIT_KILL_DAMAGE = MAX_SHIELD + MAX_HEALTH + 1

/**
 * pellets doubles as "shots fired per trigger pull": 1 for normal hitscan/
 * projectile weapons, 8 for scattergun's pellet spread, 3 for triad_rifle's
 * burst count. This reuses one field instead of adding a burst-only one.
 *
 * headshotMult only matters to raycast-driven hitscan/burst weapons (the
 * only kinds where combat.ts distinguishes body vs head hit); projectile/
 * charge/power_melee weapons deal flat damage on contact, so their
 * headshotMult is set to 1 (unused, kept for interface completeness).
 */
export interface WeaponDef {
  name: string
  kind: 'hitscan' | 'burst' | 'projectile' | 'charge' | 'power_melee'
  damage: number
  headshotMult: number
  rof: number
  magSize: number
  pellets: number
  spread: number
  projectileSpeed?: number
  splashRadius?: number
  homing?: boolean
  lungeRange?: number
  /** Max hitscan/burst raycast distance. Falls back to HITSCAN_MAX_RANGE
   * when unset. */
  maxRange?: number
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pulse_smg: {
    name: 'Pulse SMG',
    kind: 'hitscan',
    damage: 8,
    headshotMult: 2,
    rof: 10,
    magSize: 30,
    pellets: 1,
    spread: 0.06,
  },
  triad_rifle: {
    name: 'Triad Rifle',
    kind: 'burst',
    damage: 12,
    headshotMult: 2,
    rof: 1.5,
    magSize: 24,
    pellets: 3,
    spread: 0.02,
  },
  railspike: {
    name: 'Railspike',
    kind: 'hitscan',
    // Set to exactly MAX_SHIELD (70): a body hit cleanly zeroes the shield
    // (visible/audible shield-pop) without ever touching health. Was 100,
    // which exceeded shield+health (100) and OHK'd on any body hit.
    // NOTE: headshots became shield-gated (see stepFire in sim.ts), so a
    // headshot into a FULL shield now also does 70, not 140, and no longer
    // one-taps. The 140 only lands once the shield is already down -- which
    // is the whole point of the two-stage kill.
    damage: 70,
    headshotMult: 2,
    rof: 0.75,
    magSize: 5,
    pellets: 1,
    spread: 0.004,
  },
  boomtube: {
    name: 'Boomtube',
    kind: 'projectile',
    damage: 120,
    headshotMult: 1,
    rof: 0.6,
    magSize: 2,
    pellets: 1,
    spread: 0,
    projectileSpeed: 25,
    splashRadius: 3,
  },
  scattergun: {
    name: 'Scattergun',
    kind: 'hitscan',
    damage: 12,
    headshotMult: 2,
    rof: 1.2,
    magSize: 6,
    pellets: 8,
    spread: 0.18,
    maxRange: 25,
  },
  sidearm: {
    name: 'Sidearm',
    kind: 'hitscan',
    damage: 15,
    headshotMult: 2,
    rof: 4,
    magSize: 12,
    pellets: 1,
    spread: 0.01,
  },
  swarm_pod: {
    name: 'Swarm Pod',
    kind: 'projectile',
    damage: 7,
    headshotMult: 1,
    rof: 8,
    magSize: 12,
    pellets: 1,
    spread: 0.05,
    projectileSpeed: 20,
    homing: true,
  },
  ion_charger: {
    name: 'Ion Charger',
    kind: 'charge',
    damage: 10,
    headshotMult: 1,
    rof: 2,
    magSize: 5,
    pellets: 1,
    spread: 0,
    projectileSpeed: 18,
    homing: true,
  },
  arc_blade: {
    name: 'Arc Blade',
    kind: 'power_melee',
    damage: ONE_HIT_KILL_DAMAGE,
    headshotMult: 1,
    rof: 1,
    magSize: 1,
    pellets: 1,
    spread: 0,
    lungeRange: 5,
  },
  grav_maul: {
    name: 'Grav Maul',
    kind: 'power_melee',
    damage: ONE_HIT_KILL_DAMAGE,
    headshotMult: 1,
    rof: 0.7,
    magSize: 1,
    pellets: 1,
    spread: 0,
  },
}

export const WEAPON_POOL: WeaponId[] = [
  'pulse_smg',
  'triad_rifle',
  'railspike',
  'boomtube',
  'scattergun',
  'sidearm',
  'swarm_pod',
  'ion_charger',
  'arc_blade',
  'grav_maul',
]

/** Slot 0 rolls from ranged weapons only: a fully unconstrained double roll
 * could hand out two power melees, leaving the player with no gun at all
 * (docs/DECISIONS.md -- the old guaranteed-starter rule existed for this).
 * Slot 1 still rolls from the whole remaining pool. */
const RANGED_POOL: WeaponId[] = WEAPON_POOL.filter((w) => WEAPONS[w].kind !== 'power_melee')

const GRENADE_SPLITS: { frag: number; mag: number }[] = [
  { frag: 2, mag: 0 },
  { frag: 1, mag: 1 },
  { frag: 0, mag: 2 },
]

// No trailing null: sandbox loadouts always roll a piece of equipment.
const EQUIPMENT_OPTIONS: EquipmentId[] = ['grapple', 'repulsor', 'camo']

export function rollLoadout(rand: () => number): {
  weapons: [WeaponId, WeaponId]
  grenades: { frag: number; mag: number }
  equipment: EquipmentId | null
} {
  // Slot 0 from RANGED_POOL (always at least one gun), slot 1 from the
  // remainder so a loadout never carries the same weapon twice.
  const first = RANGED_POOL[Math.floor(rand() * RANGED_POOL.length)]
  const rest = WEAPON_POOL.filter((w) => w !== first)
  const second = rest[Math.floor(rand() * rest.length)]
  const weapons: [WeaponId, WeaponId] = [first, second]

  const grenades = GRENADE_SPLITS[Math.floor(rand() * GRENADE_SPLITS.length)]
  const equipment = EQUIPMENT_OPTIONS[Math.floor(rand() * EQUIPMENT_OPTIONS.length)]

  return { weapons, grenades: { ...grenades }, equipment }
}
