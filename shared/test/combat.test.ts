import { describe, it, expect } from 'vitest'
import type { AABB } from '../src/types'
import { normalize } from '../src/math'
import { viewDir } from '../src/physics'
import type { WeaponId } from '../src/types'
import {
  TICK_DT,
  TICK_RATE,
  PLAYER_HEIGHT,
  MAX_SHIELD,
  MAX_HEALTH,
  FRAG_DAMAGE,
  FRAG_RADIUS,
  FRAG_FUSE,
  FRAG_BOUNCE_DAMPING,
  MAG_FUSE,
  GRAVITY,
  PLAYER_BODY_CENTER_Y,
  PLAYER_BODY_RADIUS,
  PLAYER_HEAD_RADIUS,
  MOVE_SPEED,
  EYE_HEIGHT,
  ADS_SPREAD_MULT,
  ADS_MOVE_MULT,
  MELEE_DAMAGE,
} from '../src/constants'
import { WEAPONS, WEAPON_POOL, rollLoadout } from '../src/weapons'
import {
  applyDamage,
  tickShield,
  raycast,
  stepProjectile,
  explode,
  checkSwarmPop,
  FRAG_BOUNCE_FRICTION,
  type Projectile,
} from '../src/combat'
import { MatchSim } from '../src/sim'
import { makeTestPlayer, makeInput } from './helpers'

function seqRand(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]
}

describe('applyDamage', () => {
  it('absorbs into shield first, then overflows to health, killing at exactly 70+30', () => {
    const p = makeTestPlayer()
    expect(p.shield).toBe(MAX_SHIELD)
    expect(p.health).toBe(MAX_HEALTH)

    const r1 = applyDamage(p, 50, 0)
    expect(r1).toBe('hit')
    expect(p.shield).toBe(20)
    expect(p.health).toBe(MAX_HEALTH)

    const r2 = applyDamage(p, 50, 1)
    expect(r2).toBe('killed')
    expect(p.shield).toBe(0)
    expect(p.health).toBe(0)
    expect(p.alive).toBe(false)
  })

  it('reports shield_break when shield hits exactly 0 without killing', () => {
    const p = makeTestPlayer({ shield: 20 })
    const r = applyDamage(p, 20, 0)
    expect(r).toBe('shield_break')
    expect(p.shield).toBe(0)
    expect(p.health).toBe(MAX_HEALTH)
    expect(p.alive).toBe(true)
  })

  it('sets lastDamageAt and breaks camo on hit', () => {
    const p = makeTestPlayer({ camoUntil: 99 })
    applyDamage(p, 5, 3.2)
    expect(p.lastDamageAt).toBe(3.2)
    expect(p.camoUntil).toBe(0)
  })
})

describe('tickShield', () => {
  it('recharges only after the delay, at the configured rate', () => {
    const p = makeTestPlayer()
    applyDamage(p, 50, 0) // shield -> 20, lastDamageAt = 0

    tickShield(p, 3.9, 3.9)
    expect(p.shield).toBe(20)

    tickShield(p, 4.5, 0.5)
    expect(p.shield).toBe(37.5)
  })
})

describe('rollLoadout', () => {
  it('draws both weapons then equipment, in that rand() order', () => {
    // Three draws per life: slot 0 out of the whole pool, slot 1 out of the
    // pool minus that pick, then equipment.
    const loadout = rollLoadout(seqRand([0, 0, 0]))
    expect(loadout.weapons).toEqual([WEAPON_POOL[0], WEAPON_POOL[1]])
    expect(loadout.grenades).toEqual({ frag: 2, mag: 0 })
    expect(loadout.equipment).toBe('grapple')

    const loadout2 = rollLoadout(seqRand([0.999, 0.999, 0.95]))
    expect(loadout2.weapons).toEqual([WEAPON_POOL[WEAPON_POOL.length - 1], WEAPON_POOL[WEAPON_POOL.length - 2]])
    expect(loadout2.equipment).toBe('camo')
  })

  it('200 seeded rolls: two real, distinct weapons and never null equipment', () => {
    const seen = new Set<string>()
    for (let trial = 0; trial < 200; trial++) {
      let seed = trial * 7 + 1
      const prand = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return (seed % 10000) / 10000
      }
      const lo = rollLoadout(prand)
      expect(WEAPONS[lo.weapons[0]], `slot 0 ${lo.weapons[0]}`).toBeDefined()
      expect(WEAPONS[lo.weapons[1]], `slot 1 ${lo.weapons[1]}`).toBeDefined()
      expect(lo.weapons[0]).not.toBe(lo.weapons[1])
      expect(lo.equipment).not.toBe(null)
      lo.weapons.forEach((w) => seen.add(w))
    }
    // The roll really is random over the whole roster, not a fixed pair.
    expect(seen.size).toBe(WEAPON_POOL.length)
  })

  it('every weapon fires on a whole number of ticks', () => {
    // stepFire sets cooldownUntil to now + 1/rof against a fixed 30Hz tick,
    // so an off-grid rof silently rounds the real interval up and every
    // time-to-kill comment in weapons.ts stops being true.
    for (const id of WEAPON_POOL) {
      const ticks = TICK_RATE / WEAPONS[id].rof
      expect(Math.abs(ticks - Math.round(ticks)), `${id} rof ${WEAPONS[id].rof} is off-grid`).toBeLessThan(1e-9)
    }
  })
})

describe('raycast', () => {
  it('hits a wall before a player behind it; headshot true through the head sphere', () => {
    const wallBox: AABB = { min: { x: -1, y: 0, z: 5 }, max: { x: 1, y: 3, z: 6 } }
    const behindPlayer = makeTestPlayer({ id: 'target', pos: { x: 0, y: 0, z: 10 } })
    const origin = { x: 0, y: 1, z: 0 }
    const dir = normalize({ x: 0, y: 0, z: 1 })

    const wallHit = raycast(origin, dir, 50, [wallBox], [behindPlayer], 'shooter')
    expect(wallHit.kind).toBe('wall')

    const target2 = makeTestPlayer({ id: 'target2', pos: { x: 0, y: 0, z: 10 } })
    const headOrigin = { x: 0, y: 1.55, z: 0 }
    const headHit = raycast(headOrigin, dir, 50, [], [target2], 'shooter')
    expect(headHit.kind).toBe('player')
    expect(headHit.playerId).toBe('target2')
    expect(headHit.head).toBe(true)
  })
})

describe('hit-sphere geometry: Halo-feel widening', () => {
  it('locks in the widened body/head hit-sphere radii (was 0.5/0.25)', () => {
    expect(PLAYER_BODY_RADIUS).toBe(0.58)
    expect(PLAYER_HEAD_RADIUS).toBe(0.3)
  })

  it('a lateral offset the old 0.5 body radius would have missed still hits at 0.58', () => {
    // Ray travels straight down +z at exactly the body sphere's own height
    // (PLAYER_BODY_CENTER_Y), offset laterally by 0.55m from the target's
    // centerline. dir has no x/y component, so the perpendicular distance
    // from the ray to the body-sphere center is exactly the lateral offset:
    // 0.55 -- between the pre-widening radius (0.5, would MISS) and the
    // current one (0.58, HITS). Confirms the widened constant actually
    // changes a real hit outcome, not just its own value.
    const LATERAL_OFFSET = 0.55
    expect(LATERAL_OFFSET).toBeGreaterThan(0.5) // old radius: this shot would have missed
    expect(LATERAL_OFFSET).toBeLessThan(PLAYER_BODY_RADIUS) // current radius: this shot hits

    const target = makeTestPlayer({ id: 'target', pos: { x: 0, y: 0, z: 10 } })
    const origin = { x: LATERAL_OFFSET, y: PLAYER_BODY_CENTER_Y, z: 0 }
    const dir = normalize({ x: 0, y: 0, z: 1 })

    const hit = raycast(origin, dir, 50, [], [target], 'shooter')
    expect(hit.kind).toBe('player')
    expect(hit.playerId).toBe('target')
    expect(hit.head).toBe(false)
  })
})

describe('railspike math', () => {
  it('a headshot out-damages the entire pool, so the sniper one-shots', () => {
    // 55 x 2 = 110 > 70 + 30. This is the whole reason railspike carries
    // headshotIgnoresShield: without the exemption the gate pays mult 1 into
    // a full shield and a sniper headshot is just 55.
    const headDamage = WEAPONS.railspike.damage * WEAPONS.railspike.headshotMult
    expect(headDamage).toBeGreaterThanOrEqual(MAX_SHIELD + MAX_HEALTH)
  })

  it('a body hit leaves the shield up, so the two-tap stays a two-tap', () => {
    const target = makeTestPlayer()
    const r1 = applyDamage(target, WEAPONS.railspike.damage, 0)
    // 55 into a 70 shield leaves 15 and never reaches health.
    expect(r1).toBe('hit')
    expect(target.shield).toBe(MAX_SHIELD - WEAPONS.railspike.damage)
    expect(target.health).toBe(MAX_HEALTH)
    expect(target.alive).toBe(true)
  })

  it('two body hits kill a full-shield player', () => {
    const target = makeTestPlayer()
    applyDamage(target, WEAPONS.railspike.damage, 0)
    const r2 = applyDamage(target, WEAPONS.railspike.damage, 1)
    expect(r2).toBe('killed')
  })
})

describe('explode', () => {
  it('applies linear falloff: full damage at center, ~half at half radius, none beyond radius', () => {
    const center = { x: 0, y: 0, z: 0 }
    const atCenter = makeTestPlayer({ id: 'c', pos: { x: 0, y: 0, z: 0 } })
    const atHalf = makeTestPlayer({ id: 'h', pos: { x: FRAG_RADIUS / 2, y: 0, z: 0 } })
    const atEdge = makeTestPlayer({ id: 'e', pos: { x: FRAG_RADIUS + 1, y: 0, z: 0 } })

    const results = explode(center, FRAG_DAMAGE, FRAG_RADIUS, [atCenter, atHalf, atEdge], 0)

    const rc = results.find((r) => r.playerId === 'c')
    const rh = results.find((r) => r.playerId === 'h')
    const re = results.find((r) => r.playerId === 'e')

    expect(rc?.damage).toBeCloseTo(90)
    expect(rh?.damage).toBeCloseTo(45)
    expect(re).toBeUndefined()
  })

  // Regression guard. The falloff above is measured entirely on the XZ
  // plane, which is exactly why it stayed green while a vertical bug ran
  // loose: falloff used to be measured from p.pos (the FEET) while contact
  // projectiles detonate at chest height, so a clean rocket hit silently
  // lost a third of its damage and could not kill a full-shield player.
  it('measures falloff to the body column, so a chest-height blast is a direct hit', () => {
    const atChest = makeTestPlayer({ id: 'chest', pos: { x: 0, y: 0, z: 0 } })
    const center = { x: 0, y: PLAYER_BODY_CENTER_Y, z: 0 }

    const [r] = explode(center, FRAG_DAMAGE, FRAG_RADIUS, [atChest], 0)
    expect(r.damage).toBeCloseTo(FRAG_DAMAGE)
  })

  it('a grenade at the feet still deals full damage (the reason the blast is clamped, not raised)', () => {
    // Raising the measurement to the chest instead of clamping into the
    // column would have quietly cut this from 90 to 69.75.
    const atFeet = makeTestPlayer({ id: 'feet', pos: { x: 0, y: 0, z: 0 } })
    const [r] = explode({ x: 0, y: 0, z: 0 }, FRAG_DAMAGE, FRAG_RADIUS, [atFeet], 0)
    expect(r.damage).toBeCloseTo(FRAG_DAMAGE)
  })

  it('a blast above the head still falls off with height', () => {
    const below = makeTestPlayer({ id: 'below', pos: { x: 0, y: 0, z: 0 } })
    const center = { x: 0, y: PLAYER_HEIGHT + FRAG_RADIUS / 2, z: 0 }
    const [r] = explode(center, FRAG_DAMAGE, FRAG_RADIUS, [below], 0)
    expect(r.damage).toBeCloseTo(FRAG_DAMAGE / 2)
  })

  it('a direct rocket hit kills a full-shield player outright', () => {
    // The number that motivated the fix: worst case is a detonation
    // PLAYER_BODY_RADIUS off the column, and it still has to kill.
    const target = makeTestPlayer({ id: 'rocketed', pos: { x: 0, y: 0, z: 0 } })
    const center = { x: PLAYER_BODY_RADIUS, y: PLAYER_BODY_CENTER_Y, z: 0 }
    const [r] = explode(center, WEAPONS.boomtube.damage, WEAPONS.boomtube.splashRadius ?? 0, [target], 0)

    expect(r.damage).toBeGreaterThanOrEqual(MAX_SHIELD + MAX_HEALTH)
    expect(target.alive).toBe(false)
  })
})

describe('swarm pop', () => {
  it('stepProjectile increments stuckDarts on hit; checkSwarmPop pops at 6 and resets', () => {
    const target = makeTestPlayer({ id: 'swarm-target', pos: { x: 0, y: 0, z: 0 } })

    for (let i = 0; i < 5; i++) {
      const dart: Projectile = {
        id: i,
        kind: 'swarm_dart',
        pos: { x: 0, y: 0.9, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        ownerId: 'shooter',
        team: 1,
        fuseAt: 999,
      }
      const result = stepProjectile(dart, [target], [], TICK_DT, 0)
      expect(result.exploded).toBe(true)
      expect(result.hitPlayerId).toBe('swarm-target')
    }
    expect(target.stuckDarts).toBe(5)
    expect(checkSwarmPop(target, 0)).toBe(false)
    expect(target.stuckDarts).toBe(5)

    const sixthDart: Projectile = {
      id: 5,
      kind: 'swarm_dart',
      pos: { x: 0, y: 0.9, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      ownerId: 'shooter',
      team: 1,
      fuseAt: 999,
    }
    stepProjectile(sixthDart, [target], [], TICK_DT, 0)
    expect(target.stuckDarts).toBe(6)
    expect(checkSwarmPop(target, 0)).toBe(true)
    expect(target.stuckDarts).toBe(0)
  })
})

describe('mag grenade', () => {
  it('sticks to a player on contact and follows their position until fuse', () => {
    const target = makeTestPlayer({ id: 'mag-target', pos: { x: 0, y: 0, z: 0 } })
    const mag: Projectile = {
      id: 1,
      kind: 'mag',
      pos: { x: 0, y: 0.9, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      ownerId: 'shooter',
      team: 0,
      fuseAt: MAG_FUSE,
    }

    const r1 = stepProjectile(mag, [target], [], TICK_DT, 0)
    expect(r1.exploded).toBe(false)
    expect(mag.stuckToId).toBe('mag-target')

    target.pos = { x: 5, y: 0, z: 5 }
    const r2 = stepProjectile(mag, [target], [], TICK_DT, 1.0)
    expect(r2.exploded).toBe(false)
    expect(mag.pos).toEqual(target.pos)

    const r3 = stepProjectile(mag, [target], [], TICK_DT, MAG_FUSE)
    expect(r3.exploded).toBe(true)
  })
})

describe('frag grenade', () => {
  it('falls under gravity and explodes when its fuse expires', () => {
    const frag: Projectile = {
      id: 1,
      kind: 'frag',
      pos: { x: 0, y: 1, z: 0 },
      vel: { x: 0, y: 0, z: 5 },
      ownerId: 'thrower',
      team: 0,
      fuseAt: FRAG_FUSE,
    }

    const early = stepProjectile(frag, [], [], TICK_DT, 0)
    expect(early.exploded).toBe(false)
    expect(frag.vel.y).toBeLessThan(0) // gravity applied

    const late = stepProjectile(frag, [], [], TICK_DT, FRAG_FUSE)
    expect(late.exploded).toBe(true)
  })

  it('bounces off the face it actually crossed, keeping its forward momentum', () => {
    // Regression: the bounce used to negate the WHOLE velocity vector, so a
    // frag thrown forward-and-down came off the floor flying back at the
    // thrower. A floor bounce must only flip the vertical (normal) component.
    const floor: AABB = { min: { x: -5, y: -1, z: -5 }, max: { x: 5, y: 0, z: 5 } }
    const frag: Projectile = {
      id: 1,
      kind: 'frag',
      pos: { x: 0, y: 0.2, z: 0 },
      vel: { x: 0, y: -6, z: 8 }, // thrown forward (+z) and down
      ownerId: 'thrower',
      team: 0,
      fuseAt: FRAG_FUSE,
    }

    stepProjectile(frag, [], [floor], TICK_DT, 0)

    expect(frag.vel.y).toBeGreaterThan(0) // came off the floor
    expect(frag.vel.z).toBeGreaterThan(0) // still travelling forward, not back
    expect(frag.vel.z).toBeCloseTo(8 * FRAG_BOUNCE_FRICTION, 5)
    expect(frag.vel.y).toBeCloseTo((6 + GRAVITY * TICK_DT) * FRAG_BOUNCE_DAMPING, 5)
    // and it sits on the floor rather than sunk inside it
    expect(frag.pos.y).toBe(floor.max.y)
  })

  it('bounces off a wall face without flipping its vertical velocity', () => {
    const wall: AABB = { min: { x: 2, y: -5, z: -5 }, max: { x: 6, y: 5, z: 5 } }
    const frag: Projectile = {
      id: 2,
      kind: 'frag',
      pos: { x: 1.8, y: 2, z: 0 },
      vel: { x: 12, y: 0, z: 0 }, // straight into the wall's -x face
      ownerId: 'thrower',
      team: 0,
      fuseAt: FRAG_FUSE,
    }

    stepProjectile(frag, [], [wall], TICK_DT, 0)

    expect(frag.vel.x).toBeCloseTo(-12 * FRAG_BOUNCE_DAMPING, 5)
    // Gravity still pulls it down -- a wall bounce must not send it upward.
    expect(frag.vel.y).toBeLessThan(0)
    expect(frag.pos.x).toBe(wall.min.x)
  })
})

describe('ADS (aim-down-sights): shot spread', () => {
  it('narrows hitscan/burst spread to exactly ADS_SPREAD_MULT while scoped, via a calibrated hit gate', () => {
    // Geometry: the target's body-sphere center is placed EXACTLY on the
    // shooter's unjittered boresight at range R (eye height cancels
    // PLAYER_BODY_CENTER_Y exactly -- see y below), so a pellet's deviation
    // angle theta off boresight determines hit/miss via the exact
    // closest-approach test raySphere itself runs: R*sin(theta) <=
    // PLAYER_BODY_RADIUS. R is chosen so the resulting gate angle sits
    // strictly between scattergun's scoped-max deviation
    // (spread*ADS_SPREAD_MULT) and its unscoped-max (spread): every scoped
    // pellet is then GUARANTEED to land, for ANY seed, because jitterDir's
    // angle = rand()*spread is always < spread. Unscoped pellets are not
    // bounded by the gate, so misses appear. Empirically confirmed against
    // the real sim before writing this assertion (5 seeds, 32 pellets each:
    // scoped 32/32 every time, unscoped 16-25/32).
    const weapon = WEAPONS.scattergun // pellets: 8, spread: 0.18
    const R = 5.8
    const gate = Math.asin(PLAYER_BODY_RADIUS / R)
    expect(weapon.spread * ADS_SPREAD_MULT).toBeLessThan(gate)
    expect(gate).toBeLessThan(weapon.spread)

    function fire(scoped: boolean, seed: number, shots: number): { hits: number; total: number } {
      const sim = new MatchSim('gutter', seed)
      const a = sim.addPlayer('a', 'A', 0, false)
      const b = sim.addPlayer('b', 'B', 1, false)
      a.pos = { x: 0, y: 0, z: -20 }
      a.yaw = 0
      a.pitch = 0
      a.weapons = ['scattergun', 'scattergun']
      a.activeWeapon = 0
      // bodyCenter(b.pos).y === eye.y exactly -- see geometry note above.
      b.pos = { x: 0, y: EYE_HEIGHT - PLAYER_BODY_CENTER_Y, z: -20 + R }

      let hits = 0
      let now = 0
      for (let shot = 0; shot < shots; shot++) {
        now += TICK_DT
        a.cooldownUntil = 0
        a.ammo = [weapon.magSize, weapon.magSize]
        b.shield = MAX_SHIELD
        b.health = MAX_HEALTH
        b.alive = true
        const before = b.shield + b.health
        sim.setInput('a', makeInput({ yaw: 0, pitch: 0, fire: true, ads: scoped }))
        sim.tick(now)
        const dealt = before - (b.shield + b.health)
        hits += Math.round(dealt / weapon.damage)
      }
      return { hits, total: shots * weapon.pellets }
    }

    const scopedResult = fire(true, 4242, 4)
    const unscopedResult = fire(false, 4242, 4)

    expect(scopedResult.hits).toBe(scopedResult.total) // every pellet lands, guaranteed
    expect(unscopedResult.hits).toBeLessThan(unscopedResult.total) // spread lets some miss
  })
})

describe('ADS (aim-down-sights): movement', () => {
  it('slows ground movement to exactly ADS_MOVE_MULT while scoped, and makes sprint impossible', () => {
    const sim = new MatchSim('gutter', 501)
    const a = sim.addPlayer('a', 'A', 0, false)
    a.pos = { x: 0, y: 0, z: -20 } // known-clear ground, matches other sim tests on 'gutter'
    a.yaw = 0

    let now = 0
    for (let i = 0; i < 60; i++) {
      now += TICK_DT
      sim.setInput('a', makeInput({ yaw: 0, forward: 1, ads: true }))
      sim.tick(now)
    }
    expect(Math.hypot(a.vel.x, a.vel.z)).toBeCloseTo(MOVE_SPEED * ADS_MOVE_MULT, 1)

    // Sprint must be impossible while scoped: holding sprint on top of ADS
    // neither flips p.sprinting true nor speeds the player past the
    // ADS-slowed pace.
    for (let i = 0; i < 30; i++) {
      now += TICK_DT
      sim.setInput('a', makeInput({ yaw: 0, forward: 1, ads: true, sprint: true }))
      sim.tick(now)
    }
    expect(a.sprinting).toBe(false)
    expect(Math.hypot(a.vel.x, a.vel.z)).toBeCloseTo(MOVE_SPEED * ADS_MOVE_MULT, 1)
  })

  it('sanity baseline: unscoped ground speed is unaffected (regression guard for the test above)', () => {
    const sim = new MatchSim('gutter', 502)
    const a = sim.addPlayer('a', 'A', 0, false)
    a.pos = { x: 0, y: 0, z: -20 }
    a.yaw = 0

    let now = 0
    for (let i = 0; i < 60; i++) {
      now += TICK_DT
      sim.setInput('a', makeInput({ yaw: 0, forward: 1 }))
      sim.tick(now)
    }
    expect(Math.hypot(a.vel.x, a.vel.z)).toBeCloseTo(MOVE_SPEED, 1)
  })
})

describe('ADS task: sim-side fire bug found in diagnosis', () => {
  it('power-melee weapons (arc_blade/grav_maul) now emit a shot event on fire, not just damage', () => {
    // Diagnosis-confirmed bug: stepFire's power_melee branch dealt real
    // damage via doMeleeAttack but returned before the 'shot' SimEvent the
    // client gates ALL fire feedback on (sound/kick/hit-marker) -- looked
    // exactly like "the gun did nothing" for arc_blade/grav_maul specifically.
    const sim = new MatchSim('gutter', 601)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.weapons = ['arc_blade', 'arc_blade']
    a.activeWeapon = 0
    a.pos = { x: 0, y: 0, z: 0 }
    a.yaw = 0
    a.pitch = 0
    b.pos = { x: 0, y: 0, z: 2 } // within arc_blade's lungeRange (5), dead ahead

    sim.setInput('a', makeInput({ yaw: 0, pitch: 0, fire: true }))
    const events = sim.tick(TICK_DT)

    expect(events.some((e) => e.type === 'shot' && e.playerId === 'a' && e.weapon === 'arc_blade')).toBe(
      true
    )
    // The fix must not change the pre-existing damage behavior.
    expect(b.alive).toBe(false)
  })
})

describe('Halo pass 2: shield-gated headshots', () => {
  /** Places `b` two metres directly in front of `a` at `a`'s own spawn.
   * World origin sits inside gutter geometry, so a test that hard-codes
   * (0,0,0) gets its shooter shoved out by collision resolution and the
   * ray leaves from somewhere other than where the test thinks. */
  function faceOff(seed: number, weapon: WeaponId) {
    const sim = new MatchSim('gutter', seed)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.weapons = [weapon, weapon]
    a.activeWeapon = 0
    a.ammo = [30, 30]
    a.cooldownUntil = 0
    const f = viewDir(a.yaw, 0)
    b.pos = { x: a.pos.x + f.x * 2, y: a.pos.y, z: a.pos.z + f.z * 2 }
    return { sim, a, b }
  }

  // The Halo two-stage kill: the headshot multiplier only pays out once the
  // shield is already down. Before this rule a railspike headshot (70 x 2)
  // one-tapped a full-shield player, which is why fights read as a generic
  // TTK race instead of strip-then-finish.
  it('does NOT apply headshotMult while the target still has shield', () => {
    const { sim, a, b } = faceOff(601, 'sidearm')
    b.shield = MAX_SHIELD
    b.health = MAX_HEALTH

    sim.setInput('a', makeInput({ yaw: a.yaw, pitch: 0, fire: true }))
    sim.tick(TICK_DT)

    // 12 un-multiplied, not 24: the gate is shut while the shield is up.
    expect(b.alive).toBe(true)
    expect(b.shield).toBe(MAX_SHIELD - WEAPONS.sidearm.damage)
    expect(b.health).toBe(MAX_HEALTH)
  })

  // Guard, not a red test: this half already worked. It pins the other side
  // of the rule so a future edit cannot "simplify" the gate into killing
  // headshots outright.
  it('still applies headshotMult once the shield is down', () => {
    const { sim, a, b } = faceOff(601, 'pulse_smg')
    b.shield = 0
    b.health = MAX_HEALTH

    sim.setInput('a', makeInput({ yaw: a.yaw, pitch: 0, fire: true }))
    sim.tick(TICK_DT)

    // pulse_smg 8 x1.5 = 12 off a stripped shield, not 8.
    expect(b.health).toBe(MAX_HEALTH - 12)
  })

  // The exemption, and the reason it is safe: ONE weapon opts out. If this
  // and the sidearm test above are ever both green for the same weapon, the
  // gate has been deleted rather than exempted.
  it('railspike alone ignores the gate and one-shots a full-shield head', () => {
    expect(WEAPONS.railspike.headshotIgnoresShield).toBe(true)
    for (const id of WEAPON_POOL) {
      if (id !== 'railspike') expect(WEAPONS[id].headshotIgnoresShield, id).toBeFalsy()
    }

    const { sim, a, b } = faceOff(601, 'railspike')
    b.shield = MAX_SHIELD
    b.health = MAX_HEALTH

    sim.setInput('a', makeInput({ yaw: a.yaw, pitch: 0, fire: true }))
    sim.tick(TICK_DT)

    expect(b.alive).toBe(false)
  })
})

describe('Halo pass 2: backsmack', () => {
  /** `b` is placed 1.5m in front of `a` (inside MELEE_RANGE 2). `b`'s own
   * yaw decides the case: same yaw as `a` means `b` is facing away and `a`
   * is at its back; yaw + PI means they are face to face. */
  function meleeSetup(seed: number, targetFacesAttacker: boolean) {
    const sim = new MatchSim('gutter', seed)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.meleeCooldownUntil = 0
    const f = viewDir(a.yaw, 0)
    b.pos = { x: a.pos.x + f.x * 1.5, y: a.pos.y, z: a.pos.z + f.z * 1.5 }
    b.yaw = targetFacesAttacker ? a.yaw + Math.PI : a.yaw
    b.shield = MAX_SHIELD
    b.health = MAX_HEALTH
    return { sim, a, b }
  }

  it('kills outright when the attacker is inside the rear cone', () => {
    const { sim, a, b } = meleeSetup(701, false)

    sim.setInput('a', makeInput({ yaw: a.yaw, pitch: 0, melee: true }))
    sim.tick(TICK_DT)

    expect(b.alive).toBe(false)
  })

  it('is a normal beatdown from the front', () => {
    const { sim, a, b } = meleeSetup(702, true)

    sim.setInput('a', makeInput({ yaw: a.yaw, pitch: 0, melee: true }))
    sim.tick(TICK_DT)

    expect(b.alive).toBe(true)
    expect(b.shield).toBe(MAX_SHIELD - MELEE_DAMAGE)
  })
})
