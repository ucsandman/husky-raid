import { describe, it, expect } from 'vitest'
import { stepMovement, tryClamber } from '../src/physics'
import { MAPS } from '../src/maps'
import {
  TICK_DT,
  MOVE_SPEED,
  PLAYER_RADIUS,
  JUMP_SPEED,
  PLAYER_GRAVITY,
  CLAMBER_CHECK_DISTANCE,
} from '../src/constants'
import { makeTestPlayer, makeInput } from './helpers'
import type { PlayerState } from '../src/types'
import type { GameMap } from '../src/map'

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

  it('turns into a true diagonal when a strafe key is added mid-run', () => {
    // Regression for "you can't move up and left at the same time". Friction
    // used to run only on ticks with NO movement key held, and accelerate()
    // only ever adds speed along wishDir -- so nothing bled off the velocity
    // component orthogonal to it. A player already running forward who then
    // pressed strafe deflected ~10 degrees instead of 45, forever. Run on a
    // bare flat map so map geometry can't mask the movement model.
    const flat: GameMap = {
      name: 'flat',
      boxes: [{ min: { x: -60, y: -1, z: -60 }, max: { x: 60, y: 0, z: 60 } }],
      boxColors: [0x777777],
      launchPads: [],
      teleporters: [],
      spawns: [[], []],
      spawnYaw: [0, Math.PI],
      flagStands: [
        { x: 0, y: 0, z: -10 },
        { x: 0, y: 0, z: 10 },
      ],
      deathY: -30,
      waypoints: [],
      edges: [],
    }
    // Both diagonals, measured in the player's own frame: forward is
    // (sin yaw, cos yaw) and right is (-cos yaw, sin yaw), so a settled
    // W+A run sits at -45 degrees and W+D at +45, both at walk speed.
    for (const [label, strafe, expected] of [
      ['W+A', -1, -45],
      ['W+D', 1, 45],
    ] as const) {
      const p = makeTestPlayer({ pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } })
      for (let i = 0; i < 30; i++) {
        stepMovement(p, makeInput({ yaw: 0, forward: 1 }), flat, TICK_DT)
      }
      for (let i = 0; i < 30; i++) {
        stepMovement(p, makeInput({ yaw: 0, forward: 1, strafe }), flat, TICK_DT)
      }
      const fwd = { x: Math.sin(p.yaw), z: Math.cos(p.yaw) }
      const rgt = { x: -Math.cos(p.yaw), z: Math.sin(p.yaw) }
      const alongForward = p.vel.x * fwd.x + p.vel.z * fwd.z
      const alongRight = p.vel.x * rgt.x + p.vel.z * rgt.z
      const headingDeg = (Math.atan2(alongRight, alongForward) * 180) / Math.PI
      expect(Math.abs(headingDeg - expected), `${label} heading ${headingDeg.toFixed(1)}deg`).toBeLessThan(5)
      const speed = Math.hypot(p.vel.x, p.vel.z)
      expect(Math.abs(speed - MOVE_SPEED), `${label} speed ${speed.toFixed(2)}`).toBeLessThan(MOVE_SPEED * 0.1)
    }
  })

  it('no direction of travel walks a player off either map to their death', () => {
    // The user's complaint, encoded: "get rid of the open floors where you
    // can fall down". Runs a player out of several start points in 16
    // directions, holding forward long enough to cross the whole arena
    // (300 ticks ~ 10s ~ 80m against a 60m map), including over launch pads
    // and teleporters. Nothing may ever return 'fell'.
    for (const mapName of ['gutter', 'hairpin'] as const) {
      const map = MAPS[mapName]
      const starts = [map.spawns[0][0], map.spawns[1][0], map.flagStands[0], map.flagStands[1]]
      for (const start of starts) {
        for (let dir = 0; dir < 16; dir++) {
          const yaw = (dir / 16) * Math.PI * 2
          const p = makeTestPlayer({ pos: { ...start }, vel: { x: 0, y: 0, z: 0 } })
          for (let i = 0; i < 300; i++) {
            const result = stepMovement(p, makeInput({ yaw, forward: 1 }), map, TICK_DT)
            expect(
              result,
              `${mapName}: fell after ${i} ticks heading ${((yaw * 180) / Math.PI).toFixed(0)}deg from ${JSON.stringify(start)} at ${JSON.stringify(p.pos)}`
            ).toBe('ok')
          }
        }
      }
    }
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

  it('gutter launch pads land on the correct side, ~9-11m out (rescaled for PLAYER_GRAVITY)', () => {
    // NOTE: the forcedAirborne loop re-triggers every tick the player's
    // (previous-tick, stale) position is still within the pad's radius --
    // pre-existing behavior, unrelated to this task, that stretches the
    // real landing distance past the map comment's "~9" design label. The
    // same math replayed with the pre-rescale pad velocity (9,-10) and
    // GRAVITY (20) lands at z=-11.33, not -9 -- so this asserts the
    // invariant this task actually guarantees (k-scaling keeps the
    // trajectory close to that pre-existing baseline), not an exact -9.
    for (const pad of MAPS.gutter.launchPads) {
      const p = makeTestPlayer({ pos: { x: pad.pos.x, y: 0, z: pad.pos.z }, vel: { x: 0, y: 0, z: 0 } })
      let landed = false
      for (let i = 0; i < 200 && !landed; i++) {
        stepMovement(p, makeInput({ yaw: 0 }), MAPS.gutter, TICK_DT)
        if (i > 0 && p.grounded) landed = true
      }
      expect(landed).toBe(true)
      expect(Math.sign(p.pos.z)).toBe(Math.sign(pad.velocity.z))
      expect(Math.abs(p.pos.z)).toBeGreaterThan(9)
      expect(Math.abs(p.pos.z)).toBeLessThan(13)
    }
  })

  it('hairpin launch pad reaches the high walkway (y >= 3 while z is in [30, 39])', () => {
    const pad = MAPS.hairpin.launchPads[0]
    const p = makeTestPlayer({ pos: { x: pad.pos.x, y: 0, z: pad.pos.z }, vel: { x: 0, y: 0, z: 0 } })
    let apexY = -Infinity
    let zAtApex = p.pos.z
    for (let i = 0; i < 200; i++) {
      stepMovement(p, makeInput({ yaw: 0 }), MAPS.hairpin, TICK_DT)
      if (p.pos.y > apexY) {
        apexY = p.pos.y
        zAtApex = p.pos.z
      }
      if (i > 0 && p.grounded) break
    }
    expect(apexY).toBeGreaterThanOrEqual(3)
    expect(zAtApex).toBeGreaterThanOrEqual(30)
    expect(zAtApex).toBeLessThanOrEqual(39)
  })

  it('the former gutter gap is now solid floor (a free-falling player lands, not falls through)', () => {
    // x=-3.5 used to be the gutter's open death-pit gap; it's filled now
    // (see gutter.ts), so a player free-falling into it should land on it
    // like any other floor, not drop through to deathY.
    const p = makeTestPlayer({
      pos: { x: -3.5, y: 5, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      grounded: false,
    })
    let result: 'ok' | 'fell' = 'ok'
    for (let i = 0; i < 200; i++) {
      result = stepMovement(p, makeInput(), MAPS.gutter, TICK_DT)
      if (p.grounded) break
    }
    expect(result).toBe('ok')
    expect(p.grounded).toBe(true)
    expect(p.pos.y).toBeCloseTo(0, 5)
  })

  it('deathY is still a safety net for a player who ends up below the map (not reachable by normal play)', () => {
    const p = makeTestPlayer({
      pos: { x: 0, y: MAPS.gutter.deathY - 5, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      grounded: false,
    })
    const result = stepMovement(p, makeInput(), MAPS.gutter, TICK_DT)
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

// stepMovement sets vel.y = JUMP_SPEED then applies gravity for the same
// tick, so the observable post-jump vel.y one tick later is this, not
// JUMP_SPEED itself.
const POST_JUMP_VEL_Y = JUMP_SPEED - PLAYER_GRAVITY * TICK_DT

describe('coyote time + jump buffer', () => {
  // Player "walks off an edge": grounded=true entering the first tick (so
  // coyote refills), then free-falls under gravity with no forward/strafe
  // input. x=-3.5 used to sit over the gutter's open death pit; that gap is
  // solid floor now (see gutter.ts), but starting 5m up still gives plenty
  // of airborne ticks before landing, which is all these tests need -- none
  // of them run long enough to reach the floor either way.
  function walkOffEdge(): PlayerState {
    return makeTestPlayer({ pos: { x: -3.5, y: 5, z: 0 }, vel: { x: 0, y: 0, z: 0 }, grounded: true })
  }

  it('jump pressed 3 ticks after walking off an edge still jumps (coyote time)', () => {
    const p = walkOffEdge()
    stepMovement(p, makeInput(), MAPS.gutter, TICK_DT) // tick 0: leaves ground here
    expect(p.grounded).toBe(false)
    stepMovement(p, makeInput(), MAPS.gutter, TICK_DT) // 1 tick airborne
    stepMovement(p, makeInput(), MAPS.gutter, TICK_DT) // 2 ticks airborne
    stepMovement(p, makeInput({ jump: true }), MAPS.gutter, TICK_DT) // 3 ticks airborne, press jump
    expect(p.vel.y).toBeCloseTo(POST_JUMP_VEL_Y, 5)
  })

  it('jump pressed 6 ticks (>0.15s) after leaving ground does not fire', () => {
    const p = walkOffEdge()
    stepMovement(p, makeInput(), MAPS.gutter, TICK_DT) // tick 0: leaves ground here
    expect(p.grounded).toBe(false)
    for (let i = 0; i < 5; i++) {
      stepMovement(p, makeInput(), MAPS.gutter, TICK_DT)
    }
    stepMovement(p, makeInput({ jump: true }), MAPS.gutter, TICK_DT) // 6 ticks airborne, press jump
    expect(p.vel.y).toBeLessThan(0)
  })

  it('jump pressed 3 ticks before touchdown fires on the landing tick (jump buffer)', () => {
    // Dry run (no jump input) finds the landing tick for this fall.
    const dry = makeTestPlayer({ pos: { x: 0, y: 2, z: -15 }, vel: { x: 0, y: 0, z: 0 }, grounded: false })
    let landingTick = -1
    for (let i = 1; i <= 60 && landingTick < 0; i++) {
      stepMovement(dry, makeInput(), MAPS.gutter, TICK_DT)
      if (dry.grounded) landingTick = i
    }
    expect(landingTick).toBeGreaterThan(3)

    // Identical fall, but press jump once, 3 ticks before that landing tick.
    const p = makeTestPlayer({ pos: { x: 0, y: 2, z: -15 }, vel: { x: 0, y: 0, z: 0 }, grounded: false })
    const jumpTick = landingTick - 3
    let firedAtTick = -1
    for (let i = 1; i <= landingTick + 2 && firedAtTick < 0; i++) {
      stepMovement(p, makeInput({ jump: i === jumpTick }), MAPS.gutter, TICK_DT)
      if (Math.abs(p.vel.y - POST_JUMP_VEL_Y) < 1e-6) firedAtTick = i
    }
    // The buffered jump fires the tick after p.grounded reads true (grounded
    // lags one tick behind the physical landing -- see stepMovement's own
    // "reads p.grounded as set by last tick's collideCapsule" contract).
    expect(firedAtTick).toBe(landingTick + 1)
  })
})

describe('sprint + slide', () => {
  it('sprinting forward reaches ~9.1 m/s, and drops to ~7 when firing', () => {
    // Pure flat center-lane ground (same spot 'walks forward on flat
    // ground' uses), away from platform-edge/curb geometry that could
    // knock grounded false mid-run and confuse the sprinting flag.
    const sprinter = makeTestPlayer({ pos: { x: 0, y: 0, z: -15 }, vel: { x: 0, y: 0, z: 0 } })
    for (let i = 0; i < 30; i++) {
      stepMovement(sprinter, makeInput({ yaw: 0, forward: 1, sprint: true }), MAPS.gutter, TICK_DT)
    }
    expect(Math.hypot(sprinter.vel.x, sprinter.vel.z)).toBeCloseTo(9.1, 1)
    expect(sprinter.sprinting).toBe(true)

    const firingSprinter = makeTestPlayer({ pos: { x: 0, y: 0, z: -15 }, vel: { x: 0, y: 0, z: 0 } })
    for (let i = 0; i < 30; i++) {
      stepMovement(
        firingSprinter,
        makeInput({ yaw: 0, forward: 1, sprint: true, fire: true }),
        MAPS.gutter,
        TICK_DT
      )
    }
    expect(Math.hypot(firingSprinter.vel.x, firingSprinter.vel.z)).toBeCloseTo(7, 1)
    expect(firingSprinter.sprinting).toBe(false)
  })

  it('slideRequest below SLIDE_MIN_SPEED does nothing', () => {
    const p = makeTestPlayer({ vel: { x: 0, y: 0, z: 3 } }) // 3 m/s < SLIDE_MIN_SPEED (5.5)
    stepMovement(p, makeInput({ yaw: 0, slideRequest: true }), MAPS.gutter, TICK_DT)
    expect(p.sliding).toBe(false)
  })

  it('slide ended by jump preserves >90% horizontal speed (no zeroing on cancel)', () => {
    const p = makeTestPlayer({
      vel: { x: 0, y: 0, z: 10 },
      sliding: true,
      slideTimeRemaining: 0.5,
      slideCooldownRemaining: 0,
    })
    const speedBefore = Math.hypot(p.vel.x, p.vel.z)
    stepMovement(p, makeInput({ yaw: 0, jump: true }), MAPS.gutter, TICK_DT)
    expect(p.sliding).toBe(false)
    expect(p.slideCooldownRemaining).toBeGreaterThan(0)
    const speedAfter = Math.hypot(p.vel.x, p.vel.z)
    expect(speedAfter).toBeGreaterThan(speedBefore * 0.9)
  })
})

describe('gutter perimeter wall (interior gutters are filled, no more interior curbs)', () => {
  it('a grounded player on the west rail strafing toward -x stops at ~x=-5.6 (perimeter wall holds)', () => {
    const p = makeTestPlayer({ pos: { x: -5, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, grounded: true })
    for (let i = 0; i < 60; i++) {
      // strafe=1 at yaw=0 moves -x, toward the west perimeter wall (box 13,
      // near face at x=-6; player radius 0.4 -> stop at x=-5.6).
      stepMovement(p, makeInput({ yaw: 0, strafe: 1 }), MAPS.gutter, TICK_DT)
    }
    expect(p.pos.x).toBeCloseTo(-5.6, 1)
    expect(p.pos.y).toBe(0)
    expect(p.grounded).toBe(true)
  })

  it('a grounded player on the west rail strafing toward +x now crosses the former gutter on solid floor', () => {
    const p = makeTestPlayer({ pos: { x: -5, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, grounded: true })
    let result: 'ok' | 'fell' = 'ok'
    // strafe=-1 at yaw=0 moves +x, across the former gutter gap at x in
    // (-4,-3) -- the exact gap the 'former gutter gap is now solid floor'
    // test above free-falls straight down through, filled here by crossing
    // it horizontally instead. Strafe only long enough to clear the rail,
    // then release and let it settle.
    for (let i = 0; i < 10; i++) {
      result = stepMovement(p, makeInput({ yaw: 0, strafe: -1 }), MAPS.gutter, TICK_DT)
    }
    for (let i = 0; i < 200; i++) {
      result = stepMovement(p, makeInput({ yaw: 0 }), MAPS.gutter, TICK_DT)
    }
    expect(result).toBe('ok')
    expect(p.grounded).toBe(true)
  })
})

describe('airborne clamber', () => {
  it('an airborne player moving into gutter cover box 9 (top y=1) clambers up', () => {
    const box9 = MAPS.gutter.boxes[9]
    expect(box9.max.y).toBe(1)

    // Well inside box 9's x/z footprint, approaching along +z, pos.y=0 so
    // the ledge height (1) sits inside [CLAMBER_MIN_HEIGHT, CLAMBER_MAX_HEIGHT].
    const pos = { x: -2, y: 0, z: box9.min.z - CLAMBER_CHECK_DISTANCE }
    const wishDir = { x: 0, y: 0, z: 1 }
    expect(tryClamber(pos, wishDir, MAPS.gutter.boxes)).toBe(box9.max.y)

    const p = makeTestPlayer({ pos, vel: { x: 0, y: -1, z: 0 }, grounded: false })
    stepMovement(p, makeInput({ yaw: 0, forward: 1 }), MAPS.gutter, TICK_DT)
    expect(p.pos.y).toBeGreaterThan(0.9)
  })

  it('the west perimeter wall (top y=6) is too tall to clamber, unlike a low cover box', () => {
    // The old interior lane-edge curbs (0.5m, deliberately jumpable) are
    // gone now that the gutters are filled -- see gutter.ts. What replaced
    // them is the perimeter wall (box 13), which is deliberately the
    // opposite: tall enough that tryClamber's own height gate
    // (CLAMBER_MAX_HEIGHT above the player) rejects it outright, unlike
    // the box-9 cover box clambered above.
    const wall = MAPS.gutter.boxes[13]
    expect(wall.max.y).toBe(6)

    const pos = { x: wall.max.x + CLAMBER_CHECK_DISTANCE, y: 0, z: -10 }
    const wishDir = { x: -1, y: 0, z: 0 }
    expect(tryClamber(pos, wishDir, MAPS.gutter.boxes)).toBeNull()
  })
})
