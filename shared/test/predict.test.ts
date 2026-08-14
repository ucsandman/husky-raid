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

  it('prediction matches server exactly with sprint/slide inputs', () => {
    const predicted = makeTestPlayer()
    const raw = makeTestPlayer()
    const predictor = new Predictor(MAPS.gutter)

    for (let i = 0; i < 60; i++) {
      const input = makeInput({
        seq: i,
        yaw: 0,
        forward: 1,
        sprint: i % 2 === 0,
        slideRequest: i % 11 === 0,
        jump: i % 17 === 0,
      })
      predictor.applyInput(predicted, input)
      stepMovement(raw, input, MAPS.gutter, input.dt)
    }

    expect(predicted.pos).toEqual(raw.pos)
    expect(predicted.vel).toEqual(raw.vel)
    expect(predicted.grounded).toEqual(raw.grounded)
    expect(predicted.sprinting).toEqual(raw.sprinting)
    expect(predicted.sliding).toEqual(raw.sliding)
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

  it('reconcile arrives while predicted is mid-slide and the replay matches a fresh server replay bit-identically', () => {
    // Start on flat center-lane ground rather than the default spawn: from
    // the spawn pad a sprinting player crosses the platform's step edge
    // (z~-21) partway through, goes airborne, and correctly ends the slide
    // there -- which would make this test's mid-slide precondition depend on
    // terrain instead of on the reconcile behaviour it actually checks.
    const START = { x: 0, y: 0, z: -15 }
    const predicted = makeTestPlayer({ pos: { ...START } })
    const predictor = new Predictor(MAPS.gutter)
    const inputs: PlayerInput[] = []

    // Sprint to build speed, then trigger one slide partway through. The
    // server has only ever seen inputs up to ACK_SEQ (well before the slide
    // even starts) -- by the time its ack arrives, the client has already
    // run ahead into an active slide (predicted.sliding is still true right
    // up to the reconcile call below). reconcile() unconditionally resets
    // sliding/slideTimeRemaining/slideCooldownRemaining (see predict.ts),
    // which is correct here since the server's own state at ACK_SEQ was
    // never sliding either -- so the full replay from that reset state
    // re-derives the slide from scratch and should land bit-identically on
    // whatever a fresh, uninterrupted server replay of all inputs produces.
    const SLIDE_AT = 15
    const ACK_SEQ = 5
    const TOTAL = 30

    for (let i = 0; i < TOTAL; i++) {
      const input = makeInput({ seq: i, yaw: 0, forward: 1, sprint: i < SLIDE_AT, slideRequest: i === SLIDE_AT })
      inputs.push(input)
      predictor.applyInput(predicted, input)
    }
    expect(predicted.sliding).toBe(true) // confirms the reconcile below really does arrive mid-slide

    const server = makeTestPlayer({ pos: { ...START } })
    for (let i = 0; i <= ACK_SEQ; i++) stepMovement(server, inputs[i], MAPS.gutter, inputs[i].dt)
    const serverSnap = toSnapPlayer(server, 0)

    predictor.reconcile(predicted, serverSnap, ACK_SEQ)

    const reference = makeTestPlayer({ pos: { ...START } })
    for (const input of inputs) stepMovement(reference, input, MAPS.gutter, input.dt)

    expect(predicted.pos).toEqual(reference.pos)
    expect(predicted.vel).toEqual(reference.vel)
    expect(predicted.sliding).toEqual(reference.sliding)
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
