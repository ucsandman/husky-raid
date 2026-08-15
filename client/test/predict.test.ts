import { describe, it, expect } from 'vitest'
import { MAPS, TICK_DT, type SnapPlayer, type ServerMsg } from '@riftlane/shared'
import { ClientPrediction, InputAccumulator } from '../src/predict'

/**
 * Cover for the per-frame smoothness contract: the sim predicts movement in
 * fixed TICK_DT (30Hz) steps, but the display runs at 60-144Hz, so the
 * camera position has to be interpolated ACROSS a prediction step or every
 * second render frame draws the exact same position -- a visible stutter
 * that no amount of smooth mouselook hides. Plus the misprediction rule:
 * small corrections ease out, huge ones snap.
 */

const MAP = MAPS.bastion
const LOCAL_ID = 'me'

function snapPlayer(pos: { x: number; y: number; z: number }): SnapPlayer {
  return {
    id: LOCAL_ID,
    team: 0,
    bot: false,
    name: 'Me',
    pos: { ...pos },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    alive: true,
    shield: 70,
    health: 100,
    weapons: ['pulse_smg', 'sidearm'],
    activeWeapon: 0,
    camo: false,
    carryingFlag: null,
    ammo: [32, 12],
    grenades: { frag: 2, mag: 0 },
    equipment: null,
    equipmentCharges: 0,
  }
}

function snapshot(pos: { x: number; y: number; z: number }, ackSeq: number, time: number): Extract<ServerMsg, { t: 'snapshot' }> {
  return {
    t: 'snapshot',
    tick: Math.round(time / TICK_DT),
    ackSeq,
    time,
    players: [snapPlayer(pos)],
    projectiles: [],
    flags: [],
    scores: [0, 0],
    timeLeft: 300,
    events: [],
  }
}

/** Player held in the air above the map floor, so gravity guarantees the
 * predicted position changes on every tick with no input at all. */
const AIR_POS = { x: MAP.spawns[0][0].x, y: MAP.spawns[0][0].y + 6, z: MAP.spawns[0][0].z }

function idleInput(): { yaw: number; pitch: number; forward: number; strafe: number; jump: boolean; fire: boolean; melee: boolean; grenade: boolean; equipment: boolean; swap: boolean } {
  return {
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
  }
}

function started(): ClientPrediction {
  const p = new ClientPrediction()
  p.start(LOCAL_ID)
  p.setMap(MAP)
  p.onSnapshot(snapshot(AIR_POS, -1, 0))
  return p
}

describe('InputAccumulator.alpha', () => {
  it('reports how far into the next tick the leftover time is', () => {
    const acc = new InputAccumulator()
    expect(acc.alpha()).toBe(0)

    acc.step(TICK_DT / 2, idleInput)
    expect(acc.alpha()).toBeCloseTo(0.5, 6)

    // Consuming a whole tick leaves nothing over.
    acc.step(TICK_DT / 2, idleInput)
    expect(acc.alpha()).toBeCloseTo(0, 6)

    // A slow frame worth two ticks still leaves only the remainder.
    acc.step(TICK_DT * 2.25, idleInput)
    expect(acc.alpha()).toBeCloseTo(0.25, 6)
  })
})

describe('ClientPrediction.localPose interpolation', () => {
  it('moves the camera on every render frame, not only on tick frames', () => {
    const p = started()
    const ys: number[] = []
    // Half-tick frames: every other one emits no prediction step at all.
    for (let i = 0; i < 10; i++) {
      p.stepAndCollectInputs(TICK_DT / 2, idleInput)
      p.tick(TICK_DT / 2)
      ys.push(p.localPose()!.pos.y)
    }
    // The first two frames are both still the snapshot position: nothing has
    // been predicted yet to interpolate TOWARD. Every frame after the first
    // tick lands has to move, which is the whole point.
    for (let i = 3; i < ys.length; i++) {
      expect(ys[i]).not.toBe(ys[i - 1])
      expect(ys[i]).toBeLessThan(ys[i - 1]) // falling, so strictly down every frame
    }
  })

  it('never runs ahead of the tick it is interpolating toward', () => {
    const p = started()
    p.stepAndCollectInputs(TICK_DT, idleInput)
    const afterFirstTick = p.localPose()!.pos.y
    // A frame long enough to consume two ticks: alpha clamps, so the drawn
    // position lands on a real predicted tick rather than extrapolating.
    p.stepAndCollectInputs(TICK_DT * 2, idleInput)
    const y = p.localPose()!.pos.y
    expect(y).toBeLessThan(afterFirstTick)
    expect(Number.isFinite(y)).toBe(true)
  })
})

describe('ClientPrediction misprediction handling', () => {
  it('eases out a small correction instead of snapping to it', () => {
    const p = started()
    for (let i = 0; i < 4; i++) {
      p.stepAndCollectInputs(TICK_DT, idleInput)
      p.tick(TICK_DT)
    }
    const before = p.localPose()!.pos
    const beforeY = before.y

    // Server says we are 0.6m off -- inside the smoothing band.
    p.onSnapshot(snapshot({ x: before.x, y: beforeY + 0.6, z: before.z }, 3, TICK_DT * 4))
    const after = p.localPose()!.pos
    // The offset absorbed most of the jump, so the camera is still near
    // where it was rather than on the server's answer.
    expect(Math.abs(after.y - beforeY)).toBeLessThan(0.25)
  })

  it('snaps instantly when the correction is too big to hide', () => {
    const p = started()
    for (let i = 0; i < 4; i++) {
      p.stepAndCollectInputs(TICK_DT, idleInput)
      p.tick(TICK_DT)
    }
    const before = p.localPose()!.pos
    const serverY = before.y + 9 // a respawn-sized correction

    p.onSnapshot(snapshot({ x: before.x, y: serverY, z: before.z }, 3, TICK_DT * 4))
    const after = p.localPose()!.pos
    expect(Math.abs(after.y - serverY)).toBeLessThan(0.5)
  })
})
