import { describe, it, expect } from 'vitest'
import type { AABB } from '../src/types'
import { normalize } from '../src/math'
import { TICK_DT, MAX_SHIELD, MAX_HEALTH, FRAG_DAMAGE, FRAG_RADIUS, FRAG_FUSE, MAG_FUSE } from '../src/constants'
import { WEAPONS, WEAPON_POOL, rollLoadout } from '../src/weapons'
import {
  applyDamage,
  tickShield,
  raycast,
  stepProjectile,
  explode,
  checkSwarmPop,
  type Projectile,
} from '../src/combat'
import { makeTestPlayer } from './helpers'

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
    const rand = seqRand([0, 0, 0, 0])
    const loadout = rollLoadout(rand)
    expect(loadout.weapons[0]).toBe(WEAPON_POOL[0])
    expect(loadout.weapons[1]).toBe(WEAPON_POOL[1])
    expect(loadout.grenades).toEqual({ frag: 2, mag: 0 })
    expect(loadout.equipment).toBe('grapple')

    const rand2 = seqRand([0.95, 0.5, 0.5, 0.99])
    const loadout2 = rollLoadout(rand2)
    expect(loadout2.weapons[0]).not.toBe(loadout2.weapons[1])
    expect(loadout2.equipment).toBe(null)

    for (let trial = 0; trial < 50; trial++) {
      let seed = trial * 7 + 1
      const prand = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return (seed % 10000) / 10000
      }
      const lo = rollLoadout(prand)
      expect(lo.weapons[0]).not.toBe(lo.weapons[1])
      expect(WEAPON_POOL).toContain(lo.weapons[0])
      expect(WEAPON_POOL).toContain(lo.weapons[1])
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

describe('railspike math', () => {
  it('body hit (100) and head hit (200) both kill a full-shield player exactly', () => {
    const bodyTarget = makeTestPlayer()
    const r1 = applyDamage(bodyTarget, WEAPONS.railspike.damage, 0)
    expect(r1).toBe('killed')
    expect(bodyTarget.health).toBe(0)

    const headTarget = makeTestPlayer()
    const headDamage = WEAPONS.railspike.damage * WEAPONS.railspike.headshotMult
    const r2 = applyDamage(headTarget, headDamage, 0)
    expect(r2).toBe('killed')
    expect(headTarget.health).toBe(0)
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
