import { describe, it, expect } from 'vitest'
import { findPath, nearestWaypoint, Navigator } from '../src/bots/nav'
import type { GameMap, PlayerInput, PlayerState } from '@riftlane/shared'
import { MAPS, stepMovement, TICK_DT, MAX_HEALTH, MAX_SHIELD } from '@riftlane/shared'

// Local test player builder (per task-9 controller ruling): shared/test/helpers.ts's
// makeTestPlayer is exported only for shared's own tests, not via the package index,
// so server/test builds its own small fixture rather than reaching into shared/test.
function makeBotTestPlayer(overrides?: Partial<PlayerState>): PlayerState {
  return {
    id: 'bot-1',
    name: 'Bot',
    team: 0,
    bot: true,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    grounded: true,
    shield: MAX_SHIELD,
    health: MAX_HEALTH,
    alive: true,
    respawnAt: 0,
    lastDamageAt: 0,
    weapons: ['sidearm', 'pulse_smg'],
    activeWeapon: 0,
    ammo: [0, 0],
    cooldownUntil: 0,
    grenadeCooldownUntil: 0,
    grenades: { frag: 0, mag: 0 },
    equipment: null,
    equipmentCharges: 0,
    equipmentCooldownUntil: 0,
    swapCooldownUntil: 0,
    meleeCooldownUntil: 0,
    camoUntil: 0,
    carryingFlag: null,
    stuckDarts: 0,
    kills: 0,
    deaths: 0,
    captures: 0,
    teleportCooldownUntil: 0,
    sprinting: false,
    sliding: false,
    slideTimeRemaining: 0,
    slideCooldownRemaining: 0,
    coyoteTimeRemaining: 0,
    jumpBufferRemaining: 0,
    scoped: false,
    ...overrides,
  }
}

function makeInput(overrides?: Partial<PlayerInput>): PlayerInput {
  return {
    seq: 0,
    dt: TICK_DT,
    yaw: 0,
    pitch: 0,
    forward: 0,
    strafe: 0,
    jump: false,
    fire: false,
    melee: false,
    grenade: false,
    equipment: false,
    swap: false,
    ...overrides,
  }
}

describe('findPath: A* on gutter', () => {
  it('finds the shortest lane path from base to mid, through every intermediate lane node', () => {
    // gutter waypoints: 0 base cobalt, 1-3 lane, 4 mid, 5-7 lane, 8 base ember,
    // 9/10 teleporter alcoves. Base(0)->mid(4) stays entirely on the lane
    // (cost ~26) because the teleporter detour via node 9 would require
    // backtracking past node 4 to reach the alcove exit near node 7/10
    // (cost ~38) -- more expensive despite the teleporter's flat cost-2 edge.
    // This isolates plain multi-hop A* from the teleporter-preference case,
    // which test 2 below covers on hairpin's shortcut instead.
    const path = findPath(MAPS.gutter, 0, 4)
    expect(path).toEqual([0, 1, 2, 3, 4])
  })
})

describe('findPath: teleporter preferred when shorter', () => {
  it('routes cobalt base to ember base across hairpin via the teleporter shortcut', () => {
    // hairpin base(0) -> base(14): walking the legs + joint costs ~90 (down
    // one leg, across the joint, back down the other leg to node 9, then to
    // 14). Cutting across via the teleporter (edge 2->12, flat cost 2) costs
    // ~62 instead, so A* must select it despite the real teleporter gap
    // (x=-10 to x=10) being far longer than any single walk edge.
    const path = findPath(MAPS.hairpin, 0, 14)
    expect(path).toEqual([0, 1, 2, 12, 11, 10, 9, 14])
  })
})

describe('Navigator.steer: straight two-node path', () => {
  it('walks a bot from one lane waypoint to the next within 120 ticks', () => {
    const map: GameMap = MAPS.gutter
    const start = map.waypoints[1].pos // (0, 0, -18)
    const goal = map.waypoints[2].pos // (0, 0, -12), 6m straight down the lane

    const p = makeBotTestPlayer({ pos: { ...start } })
    const nav = new Navigator()
    nav.setGoal(goal)

    let now = 0
    for (let i = 0; i < 120; i++) {
      const { input } = nav.steer(p, map, now)
      stepMovement(p, makeInput({ seq: i, ...input }), map, TICK_DT)
      now += TICK_DT
    }

    const dx = p.pos.x - goal.x
    const dz = p.pos.z - goal.z
    expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(1.5)
  })
})

describe('Navigator.steer: unstick re-paths after displacement', () => {
  it('recovers and still reaches the goal after being knocked 10m off the current edge', () => {
    const map: GameMap = MAPS.gutter
    const start = map.waypoints[3].pos // (0, 0, -6)
    // (0, 0, 12), 18m down the lane. Deliberately not node 1 -> node 7 (or
    // base -> base): with the fix to a true-optimal Dijkstra search (h=0,
    // see nav.ts), those endpoints are each close enough to a teleporter
    // alcove that the truly shortest path detours through the teleporter
    // instead of walking the lane -- the same reason test 1 above uses
    // 0 -> 4 rather than 0 -> 8. Nodes 3 -> 6 stay solidly lane-optimal
    // (lane cost 18 vs. ~30 through the teleporter and back), so the bot's
    // undisturbed route is a predictable straight walk down the lane.
    const goal = map.waypoints[6].pos

    const p = makeBotTestPlayer({ pos: { ...start } })
    const nav = new Navigator()
    nav.setGoal(goal)

    let now = 0
    for (let i = 0; i < 30; i++) {
      const { input } = nav.steer(p, map, now)
      stepMovement(p, makeInput({ seq: i, ...input }), map, TICK_DT)
      now += TICK_DT
    }

    // Knock the bot 10m further down the lane (still on solid center-lane
    // floor, so it doesn't fall into a gutter pit), well past the edge
    // segment the Navigator thinks it's still walking.
    p.pos = { ...p.pos, z: p.pos.z + 10 }
    p.vel = { x: 0, y: 0, z: 0 }

    for (let i = 30; i < 260; i++) {
      const { input } = nav.steer(p, map, now)
      stepMovement(p, makeInput({ seq: i, ...input }), map, TICK_DT)
      now += TICK_DT
    }

    const dx = p.pos.x - goal.x
    const dz = p.pos.z - goal.z
    expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(1.5)
  })
})

describe('Navigator.steer: jump trigger onto a raised platform', () => {
  it('fires jump and actually reaches a 0.5m-raised platform via a walk edge', () => {
    // Minimal fixture reproducing gutter's runner-stranding bug class: a
    // flat lower floor (y=0 top) butts directly against a platform raised
    // 0.5m (y=0.5 top), with no ramp, connected by a single 'walk' edge.
    // Without Navigator's jump trigger, collideCapsule resolves the
    // platform's footprint as a wall against a still-ground-level walker
    // (X/Y/Z each resolved per tick using that tick's pre-jump Y), which
    // permanently stranded every runner a few meters short of gutter's
    // flag stand -- this fixture reproduces the same geometry in isolation.
    const platformMap: GameMap = {
      name: 'platform-test',
      boxes: [
        { min: { x: -3, y: -1, z: -10 }, max: { x: 3, y: 0, z: 0 } }, // lower floor
        { min: { x: -3, y: 0, z: 0 }, max: { x: 3, y: 0.5, z: 10 } }, // raised platform
      ],
      boxColors: [0x888888, 0x2244aa],
      launchPads: [],
      teleporters: [],
      spawns: [
        [{ x: 0, y: 0, z: -9 }],
        [{ x: 0, y: 0.5, z: 9 }],
      ],
      spawnYaw: [0, Math.PI],
      flagStands: [
        { x: 0, y: 0, z: -9 },
        { x: 0, y: 0.5, z: 9 },
      ],
      deathY: -10,
      waypoints: [
        { pos: { x: 0, y: 0, z: -5 } }, // 0 lower-floor approach
        { pos: { x: 0, y: 0.5, z: 3 } }, // 1 on the platform, 3m past the z=0 wall
      ],
      edges: [{ from: 0, to: 1, kind: 'walk' }],
    }

    const p = makeBotTestPlayer({ pos: { x: 0, y: 0, z: -8 } })
    const nav = new Navigator()
    nav.setGoal(platformMap.waypoints[1].pos)

    let now = 0
    let sawJump = false
    for (let i = 0; i < 400; i++) {
      const { input } = nav.steer(p, platformMap, now)
      if (input.jump) sawJump = true
      stepMovement(p, makeInput({ seq: i, ...input }), platformMap, TICK_DT)
      now += TICK_DT
    }

    expect(sawJump).toBe(true)
    // Actually made it onto the platform, not just attempted a jump: y
    // close to the platform's top, and close enough to the target in XZ
    // (the bug class was "permanently stranded a few meters short," not
    // "never jumps at all").
    expect(p.pos.y).toBeGreaterThan(0.4)
    const dx2 = p.pos.x - platformMap.waypoints[1].pos.x
    const dz2 = p.pos.z - platformMap.waypoints[1].pos.z
    expect(Math.hypot(dx2, dz2)).toBeLessThanOrEqual(1.5)
  })
})
