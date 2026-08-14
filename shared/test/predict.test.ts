import { describe, it, expect } from 'vitest'
import { Predictor, Interpolator, type PredictSnapshot } from '../src/predict'
import { stepMovement } from '../src/physics'
import { toSnapPlayer } from '../src/protocol'
import { MAPS } from '../src/maps'
import { TICK_DT } from '../src/constants'
import { makeTestPlayer, makeInput } from './helpers'
import type { PlayerInput } from '../src/types'
import type { SnapPlayer } from '../src/protocol'

// Forward convention: yaw=0 -> +z (see physics.test.ts).

function makeSnapshot(time: number, players: SnapPlayer[]): PredictSnapshot {
  return {
    t: 'snapshot',
    tick: 0,
    ackSeq: 0,
    time,
    players,
    projectiles: [],
    flags: [],
    scores: [0, 0],
    timeLeft: 0,
    events: [],
  }
}

describe('Predictor', () => {
  it('prediction matches server exactly with same inputs', () => {
    const predicted = makeTestPlayer()
    const raw = makeTestPlayer()
    const predictor = new Predictor(MAPS.gutter)

    for (let i = 0; i < 60; i++) {
      const input = makeInput({ seq: i, yaw: 0.2, forward: 1, strafe: 0.3, jump: i % 15 === 0 })
      predictor.applyInput(predicted, input)
      stepMovement(raw, input, MAPS.gutter, input.dt)
    }

    expect(predicted.pos).toEqual(raw.pos)
    expect(predicted.vel).toEqual(raw.vel)
    expect(predicted.grounded).toEqual(raw.grounded)
  })

  it('reconcile replays unacked inputs', () => {
    const predicted = makeTestPlayer()
    const predictor = new Predictor(MAPS.gutter)
    const inputs: PlayerInput[] = []

    for (let i = 0; i < 60; i++) {
      const input = makeInput({ seq: i, yaw: 0.1, forward: 1, strafe: -0.2, jump: i % 20 === 0 })
      inputs.push(input)
      predictor.applyInput(predicted, input)
    }

    // Server has only consumed inputs seq 0..40 -- its authoritative snap
    // reflects just those, replayed on a fresh state.
    const server = makeTestPlayer()
    for (let i = 0; i <= 40; i++) stepMovement(server, inputs[i], MAPS.gutter, inputs[i].dt)
    const serverSnap = toSnapPlayer(server, 0)

    const delta = predictor.reconcile(predicted, serverSnap, 40)

    // Pure-sim reference: all 60 inputs run through raw stepMovement.
    const reference = makeTestPlayer()
    for (const input of inputs) stepMovement(reference, input, MAPS.gutter, input.dt)

    expect(predicted.pos.x).toBeCloseTo(reference.pos.x, 6)
    expect(predicted.pos.y).toBeCloseTo(reference.pos.y, 6)
    expect(predicted.pos.z).toBeCloseTo(reference.pos.z, 6)
    expect(Math.hypot(delta.x, delta.y, delta.z)).toBeLessThan(1e-6)
  })

  it('reconcile corrects divergence', () => {
    const predicted = makeTestPlayer()
    const predictor = new Predictor(MAPS.gutter)
    const inputs: PlayerInput[] = []

    for (let i = 0; i < 60; i++) {
      const input = makeInput({ seq: i, yaw: 0, forward: 1, strafe: 0 })
      inputs.push(input)
      predictor.applyInput(predicted, input)
    }

    // Simulate a misprediction: nudge the predicted position off by 1m.
    predicted.pos = { ...predicted.pos, x: predicted.pos.x + 1 }

    const server = makeTestPlayer()
    for (const input of inputs) stepMovement(server, input, MAPS.gutter, input.dt)
    const serverSnap = toSnapPlayer(server, 0)

    // ackSeq covers every buffered input -- nothing left to replay, state
    // snaps straight to the server's authoritative position.
    const delta = predictor.reconcile(predicted, serverSnap, 59)

    expect(predicted.pos.x).toBeCloseTo(server.pos.x, 6)
    expect(predicted.pos.z).toBeCloseTo(server.pos.z, 6)
    expect(delta.x).toBeCloseTo(1, 2)
  })
})

describe('Interpolator', () => {
  it('samples midpoint between two bracketing snapshots', () => {
    const base = toSnapPlayer(makeTestPlayer(), 0)
    const interpolator = new Interpolator()

    interpolator.push(makeSnapshot(0, [{ ...base, pos: { x: 0, y: 0, z: 0 } }]))
    interpolator.push(makeSnapshot(0.05, [{ ...base, pos: { x: 1, y: 0, z: 0 } }]))

    const [sampled] = interpolator.sample(0.025)

    expect(sampled.pos.x).toBeCloseTo(0.5, 5)
  })
})
