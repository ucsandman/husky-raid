import { describe, it, expect } from 'vitest'
import type { AABB } from '../src/types'
import { normalize } from '../src/math'
import {
  TICK_DT,
  MAX_SHIELD,
  MAX_HEALTH,
  FRAG_DAMAGE,
  FRAG_RADIUS,
  FRAG_FUSE,
  MAG_FUSE,
  PLAYER_BODY_CENTER_Y,
  PLAYER_BODY_RADIUS,
  PLAYER_HEAD_RADIUS,
  MOVE_SPEED,
  EYE_HEIGHT,
  ADS_SPREAD_MULT,
  ADS_MOVE_MULT,
} from '../src/constants'
import { WEAPONS, WEAPON_POOL, STARTER_WEAPON, rollLoadout } from '../src/weapons'
import {
  applyDamage,
  tickShield,
  raycast,
  stepProjectile,
  explode,
  checkSwarmPop,
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
  it('never duplicates weapons and honors the injected rand sequence', () => {
    // rollLoadout now consumes one rand() call for weapons (not two) --
    // slot 0 is always STARTER_WEAPON, so only the remaining 3 values in
    // this sequence (grenades, equipment) matter beyond the first.
    const rand = seqRand([0, 0, 0])
    const loadout = rollLoadout(rand)
    expect(loadout.weapons[0]).toBe(STARTER_WEAPON)
    expect(loadout.weapons[1]).toBe(WEAPON_POOL[0])
    expect(loadout.grenades).toEqual({ frag: 2, mag: 0 })
    expect(loadout.equipment).toBe('grapple')

    const rand2 = seqRand([0.95, 0.5, 0.5])
    const loadout2 = rollLoadout(rand2)
    expect(loadout2.weapons[0]).not.toBe(loadout2.weapons[1])
    // EQUIPMENT_OPTIONS dropped its trailing null -- sandbox loadouts
    // always roll a piece of equipment now.
    expect(loadout2.equipment).not.toBe(null)
  })

  it('200 seeded rolls: guaranteed precision starter, no null equipment, no duplicate weapons', () => {
    for (let trial = 0; trial < 200; trial++) {
      let seed = trial * 7 + 1
      const prand = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return (seed % 10000) / 10000
      }
      const lo = rollLoadout(prand)
      expect(lo.weapons[0]).toBe(STARTER_WEAPON)
      expect(lo.weapons[0]).not.toBe(lo.weapons[1])
      expect(WEAPON_POOL).toContain(lo.weapons[1])
      expect(lo.equipment).not.toBe(null)
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
  it('deals exactly MAX_SHIELD damage per body hit (the invariant the shield-zero test below depends on)', () => {
    expect(WEAPONS.railspike.damage).toBe(MAX_SHIELD)
  })

  it('body hit (70) exactly zeroes shield without touching health; head hit (140) kills a full-shield player outright', () => {
    const bodyTarget = makeTestPlayer()
    const r1 = applyDamage(bodyTarget, WEAPONS.railspike.damage, 0)
    expect(r1).toBe('shield_break')
    expect(bodyTarget.shield).toBe(0)
    expect(bodyTarget.health).toBe(MAX_HEALTH)
    expect(bodyTarget.alive).toBe(true)

    const headTarget = makeTestPlayer()
    const headDamage = WEAPONS.railspike.damage * WEAPONS.railspike.headshotMult
    const r2 = applyDamage(headTarget, headDamage, 0)
    expect(r2).toBe('killed')
    expect(headTarget.health).toBe(0)
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
