import { describe, it, expect } from 'vitest'
import { stepMovement } from '../src/physics'
import { MAPS } from '../src/maps'
import { TICK_DT, MOVE_SPEED, PLAYER_RADIUS } from '../src/constants'
import { makeTestPlayer, makeInput } from './helpers'

// Forward convention: yaw=0 -> +z. Matches gutter's team-0 spawn, which
// faces +z toward the enemy base at z=+26 (spawnYaw[0] === 0).

describe('stepMovement', () => {
  it('walks forward on flat ground', () => {
    // Away from the base platform's step edge (z=-22) and the gutter
    // bridges (z=+-18) — pure flat center-lane ground for this check.
    const p = makeTestPlayer({ pos: { x: 0, y: 0, z: -15 }, vel: { x: 0, y: 0, z: 0 } })
    const startZ = p.pos.z
    for (let i = 0; i < 30; i++) {
      stepMovement(p, makeInput({ yaw: 0, forward: 1 }), MAPS.gutter, TICK_DT)
    }
    const distance = p.pos.z - startZ
    const expected = MOVE_SPEED * 1
    expect(Math.abs(distance)).toBeGreaterThan(0)
    expect(Math.abs(Math.abs(distance) - expected)).toBeLessThan(expected * 0.15)
    expect(p.grounded).toBe(true)
  })

  it('cannot walk through a wall', () => {
    const wallBox = MAPS.gutter.boxes[9] // cover box, x [-2.7,-1.3], z [-6.7,-5.3]
    const p = makeTestPlayer({
      pos: { x: -2, y: 0, z: wallBox.min.z - 1 },
      vel: { x: 0, y: 0, z: 0 },
    })
    for (let i = 0; i < 60; i++) {
      stepMovement(p, makeInput({ yaw: 0, forward: 1 }), MAPS.gutter, TICK_DT)
    }
    const faceZ = wallBox.min.z - PLAYER_RADIUS
    expect(p.pos.z).toBeLessThanOrEqual(faceZ + 0.01)
    expect(p.pos.z).toBeGreaterThan(faceZ - 0.5)
  })

  it('jump arc returns to ground', () => {
    const p = makeTestPlayer()
    const startY = p.pos.y
    stepMovement(p, makeInput({ yaw: 0, jump: true }), MAPS.gutter, TICK_DT)
    expect(p.grounded).toBe(false)

    let apex = p.pos.y
    let landedAtTick = -1
    const maxTicks = Math.ceil(1.5 / TICK_DT)
    for (let i = 1; i < maxTicks; i++) {
      stepMovement(p, makeInput({ yaw: 0 }), MAPS.gutter, TICK_DT)
      if (p.pos.y > apex) apex = p.pos.y
      if (p.grounded) {
        landedAtTick = i
        break
      }
    }
    expect(landedAtTick).toBeGreaterThan(0)
    const apexHeight = apex - startY
    expect(apexHeight).toBeGreaterThan(1.2)
    expect(apexHeight).toBeLessThan(2.0)
  })

  it('determinism', () => {
    const p1 = makeTestPlayer()
    const p2 = makeTestPlayer()
    for (let i = 0; i < 100; i++) {
      const input = makeInput({ yaw: 0.3, forward: 1, strafe: 0.5, jump: i % 20 === 0 })
      stepMovement(p1, input, MAPS.gutter, TICK_DT)
      stepMovement(p2, input, MAPS.gutter, TICK_DT)
    }
    expect(p1.pos).toEqual(p2.pos)
    expect(p1.vel).toEqual(p2.vel)
    expect(p1.grounded).toEqual(p2.grounded)
  })

  it('launch pad throws the player', () => {
    const pad = MAPS.gutter.launchPads[0]
    const p = makeTestPlayer({
      pos: { x: pad.pos.x, y: 0, z: pad.pos.z },
      vel: { x: 0, y: 0, z: 0 },
    })
    stepMovement(p, makeInput({ yaw: 0 }), MAPS.gutter, TICK_DT)
    expect(p.vel.y).toBeGreaterThan(5)
  })

  it('death pit', () => {
    const p = makeTestPlayer({
      pos: { x: -3.5, y: 5, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      grounded: false,
    })
    let result: 'ok' | 'fell' = 'ok'
    for (let i = 0; i < 200; i++) {
      result = stepMovement(p, makeInput(), MAPS.gutter, TICK_DT)
      if (result === 'fell') break
    }
    expect(result).toBe('fell')
  })

  it('carrier is slower', () => {
    const free = makeTestPlayer()
    const carrier = makeTestPlayer({ carryingFlag: 1 })
    const freeStartZ = free.pos.z
    const carrierStartZ = carrier.pos.z
    for (let i = 0; i < 30; i++) {
      stepMovement(free, makeInput({ yaw: 0, forward: 1 }), MAPS.gutter, TICK_DT)
      stepMovement(carrier, makeInput({ yaw: 0, forward: 1 }), MAPS.gutter, TICK_DT)
    }
    const freeDist = Math.abs(free.pos.z - freeStartZ)
    const carrierDist = Math.abs(carrier.pos.z - carrierStartZ)
    expect(carrierDist).toBeLessThan(freeDist)
    const ratio = carrierDist / freeDist
    expect(ratio).toBeGreaterThan(0.85)
    expect(ratio).toBeLessThan(0.95)
  })
})
