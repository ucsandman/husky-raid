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
 *
 * EVERY rof IS 30/n FOR AN INTEGER n. stepFire sets cooldownUntil to
 * now + 1/rof and the sim advances on a fixed 30 Hz tick, so the real shot
 * interval is ceil(30/rof) ticks. An off-grid rof silently rounds up: rof 9
 * is not 9 shots a second, it is 7.5. Keep new weapons on the grid or the
 * time-to-kill numbers in the comments below stop being true.
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
  /** Opts this weapon out of the shield gate on headshots, so the
   * multiplier pays out even into a full shield. railspike only -- it is
   * what makes a sniper a sniper. The gate stays intact for every other
   * weapon, which is what keeps the two-stage kill the sandbox baseline. */
  headshotIgnoresShield?: boolean
  /** A swing damages EVERY target in the melee cone, not just the nearest.
   * grav_maul only: the area hit is the whole difference between a hammer
   * and a shorter, slower sword. */
  aoeMelee?: boolean
}

/**
 * Roster is named after Halo Infinite's. There are no map pads any more --
 * every gun below is drawn by the random spawn roll (see rollLoadout), so the
 * "Spawn primary" / "Niche pad" / "Power pad" tier labels on each entry are
 * balance INTENT (how strong the gun is meant to feel), not where it comes
 * from. Time-to-kill is quoted against the full 70 shield + 30 health pool,
 * body-only and with head cleanup under the shield gate.
 */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pulse_smg: {
    // Spawn primary. The baseline every other gun is measured against.
    // rof 10 = 3 ticks. Body: 13 shots, 1.200s. Head cleanup: 12 shots,
    // 1.100s -- deliberately the smallest headshot reward in the roster,
    // because an AR is not a precision weapon.
    name: 'MA40 Assault Rifle',
    kind: 'hitscan',
    damage: 8,
    headshotMult: 1.5,
    rof: 10,
    magSize: 32,
    pellets: 1,
    spread: 0.055,
    maxRange: 45,
  },
  sidearm: {
    // Spawn secondary. Body: 9 shots, 1.067s. Head: 8 shots, 0.933s --
    // the fastest kill in the utility tier, but only for someone who can
    // hold the head line on a 0.012 cone with 12 rounds and no spray room.
    name: 'MK50 Sidekick',
    kind: 'hitscan',
    damage: 12,
    headshotMult: 2,
    rof: 7.5,
    magSize: 12,
    pellets: 1,
    spread: 0.012,
    maxRange: 60,
  },
  triad_rifle: {
    // Niche pad. pellets 3 fires three jittered rays in ONE tick, but the
    // shield gate is read PER RAY, so a burst can strip the shield with
    // ray 2 and land a multiplied finisher with ray 3. Body: 5 bursts,
    // 1.333s. Head: inside burst 4, 1.000s -- the widest headshot reward
    // here, which is why it is a pad weapon and not a spawn weapon.
    name: 'BR75 Battle Rifle',
    kind: 'burst',
    damage: 8,
    headshotMult: 2,
    rof: 3,
    magSize: 36,
    pellets: 3,
    spread: 0.015,
    maxRange: 120,
  },
  commando: {
    // Niche pad. Body: 10 shots, 1.500s, the slowest gun in the roster on
    // purpose. Head: 9 shots, 1.333s -- strictly worse than the BR and the
    // AR, and that is the trade: this is what you take when you cannot hold
    // a burst rhythm and you need range plus a deep magazine.
    name: 'VK78 Commando',
    kind: 'hitscan',
    damage: 10,
    headshotMult: 2,
    rof: 6,
    magSize: 30,
    pellets: 1,
    spread: 0.03,
    maxRange: 90,
  },
  scattergun: {
    // Niche pad. 8 x 12 = 96 < 100, so a body blast PROVABLY cannot one-tap
    // through a full shield -- the most important number here, since bots
    // auto-swap to this under 4m. Point blank: 2 shots, 0.667s. maxRange 15
    // stands in for damage falloff, which the engine does not have, and is
    // what stops it contesting a lane it has no business in.
    name: 'CQS48 Bulldog',
    kind: 'hitscan',
    damage: 12,
    headshotMult: 1.5,
    rof: 1.5,
    magSize: 7,
    pellets: 8,
    spread: 0.16,
    maxRange: 15,
  },
  swarm_pod: {
    // Niche pad. The supercombine IS the weapon: 6 sticks land 42 damage,
    // then SWARM_POP_DAMAGE 80 spills through the remaining shield and
    // kills outright at ~1.08s from 10m. Without the pop it is nearly
    // harmless (15 needles), so breaking line of sight before the sixth
    // needle costs the shooter everything.
    name: 'Needler',
    kind: 'projectile',
    damage: 7,
    headshotMult: 1,
    rof: 7.5,
    magSize: 24,
    pellets: 1,
    spread: 0.05,
    projectileSpeed: 24,
    homing: true,
  },
  cinderlob: {
    // Niche pad. The anti-cover tool: 70 max damage can never one-shot a
    // 100 pool, so it is a setup weapon, not a second rocket. Two direct
    // hits kill (~116 after falloff). Its real payload is suppression --
    // any chip damage restarts the full SHIELD_RECHARGE_DELAY, so one
    // player can deny a whole flag room its shields from behind a wall.
    // explode() has no owner exemption, so lobbing into your own room hurts.
    name: 'Cindershot',
    kind: 'projectile',
    damage: 70,
    headshotMult: 1,
    rof: 1.25,
    magSize: 5,
    pellets: 1,
    spread: 0,
    projectileSpeed: 22,
    splashRadius: 3.5,
    homing: true,
  },
  railspike: {
    // Power pad. headshotIgnoresShield makes 55 x 2 = 110 a one-shot kill
    // through a full shield at any range, which is the Halo sniper the
    // shield gate had removed. Body: 2 shots, 1.000s (shot 1 leaves shield
    // 15 / health 30; shot 2 spills 40 into 30). Deliberately human-favoured
    // -- bots aim at the chest and have no head-aim path at all, so a bot
    // holding this is only ever a 1.000s two-tap threat. That asymmetry is
    // intentional; do not "fix" it.
    name: 'S7 Sniper Rifle',
    kind: 'hitscan',
    damage: 55,
    headshotMult: 2,
    rof: 1,
    magSize: 4,
    pellets: 1,
    spread: 0.002,
    headshotIgnoresShield: true,
  },
  boomtube: {
    // Power pad. The set-defense breaker. A direct hit detonates within
    // PLAYER_BODY_RADIUS of the body centre, so worst case is 150 x
    // (1 - 0.58/4.5) = 130.7 -- a guaranteed one-shot with 30 points of
    // margin, but ONLY because explode() now measures falloff to the body
    // column instead of the feet. Guaranteed splash kill inside 1.5m, full
    // shield strip inside 2.4m, nothing at 4.5m. No owner exemption, so
    // rocket-jump risk stays.
    name: 'M41 SPNKR',
    kind: 'projectile',
    damage: 150,
    headshotMult: 1,
    rof: 0.6,
    magSize: 2,
    pellets: 1,
    spread: 0,
    projectileSpeed: 25,
    splashRadius: 4.5,
  },
  arc_blade: {
    // Power pad, one power melee per map. 5m lunge, 1.000s whiff-to-whiff
    // -- a missed swing is a full second of free defense.
    name: 'Energy Sword',
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
    // Power pad, never on the same map as the sword. Deliberately 2m
    // shorter and 0.333s slower, and it kills EVERY enemy in the cone
    // instead of the nearest -- the zone tool, not the duelist. A two-man
    // flag hold clumped inside 3m dies to one swing.
    name: 'Gravity Hammer',
    kind: 'power_melee',
    damage: ONE_HIT_KILL_DAMAGE,
    headshotMult: 1,
    rof: 0.75,
    magSize: 1,
    pellets: 1,
    spread: 0,
    lungeRange: 3,
    aoeMelee: true,
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
  'cinderlob',
  'arc_blade',
  'grav_maul',
  'commando',
]

// No trailing null: sandbox loadouts always roll a piece of equipment.
const EQUIPMENT_OPTIONS: EquipmentId[] = ['grapple', 'repulsor', 'camo']

/** Every life rolls two DIFFERENT weapons out of the full roster, players and
 * bots alike. No fixed utility pair and no map pads: the spawn roll is the
 * only way a weapon enters a fight, which is why the roll draws from all of
 * WEAPON_POOL -- excluding the power tier here would make the sniper, rocket,
 * sword and hammer unreachable. Consequence, accepted deliberately: a life can
 * start with two power melees and no answer at 20m.
 *
 * Grenades are fixed at 2 frag: FRAG_DAMAGE 90 over FRAG_RADIUS 4 strips a
 * full shield without ever killing from full, so every spawn carries a
 * shield-stripper that still needs a gun to finish.
 */
export function rollLoadout(rand: () => number): {
  weapons: [WeaponId, WeaponId]
  grenades: { frag: number; mag: number }
  equipment: EquipmentId | null
} {
  const pool = [...WEAPON_POOL]
  const first = pool.splice(Math.floor(rand() * pool.length), 1)[0]
  const second = pool[Math.floor(rand() * pool.length)]
  return {
    weapons: [first, second],
    grenades: { frag: 2, mag: 0 },
    equipment: EQUIPMENT_OPTIONS[Math.floor(rand() * EQUIPMENT_OPTIONS.length)],
  }
}
