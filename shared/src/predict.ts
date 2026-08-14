import type { PlayerInput, PlayerState, Vec3 } from './types'
import type { GameMap } from './map'
import type { ServerMsg, SnapPlayer } from './protocol'
import { stepMovement } from './physics'
import { sub, lerp, lerpV } from './math'

/** The one variant of ServerMsg the prediction layer cares about. */
export type PredictSnapshot = Extract<ServerMsg, { t: 'snapshot' }>

/**
 * Client-side prediction core. Lives in shared (not client/) so it can be
 * unit-tested against the exact same `stepMovement` the server sim runs.
 *
 * PARITY NOTE: `stepMovement` is a pure function of (state, input, map,
 * dt) -- `applyInput`/`reconcile` replay each buffered input using that
 * input's own `dt` field, whatever it is. The *server* sim always steps
 * movement once per tick at TICK_DT, using the latest coalesced input (see
 * shared/src/sim.ts). For a replay here to match the server bit-for-bit,
 * the inputs fed in must themselves be TICK_DT-sized -- i.e. the CLIENT is
 * responsible for turning variable-length render-frame dt into a stream of
 * fixed TICK_DT chunks (an accumulator) before calling applyInput. See
 * client/src/predict.ts's InputAccumulator for that half of the contract.
 * This module never assumes dt === TICK_DT itself, which is what keeps
 * `prediction matches server exactly with same inputs` a fair test.
 */
export class Predictor {
  private readonly pending: PlayerInput[] = []

  constructor(private readonly map: GameMap) {}

  /** Steps `state` forward by one input (same stepMovement the server
   * runs) and remembers the input in the replay buffer until it's acked.
   * Mirrors MatchSim.tick()'s own per-player gating: a dead player is
   * skipped entirely server-side (frozen until respawn), so predicting
   * movement for one here would just drift a corpse that the server never
   * moved -- a real divergence source, not a cosmetic one, since it keeps
   * compounding for the whole RESPAWN_DELAY window. */
  applyInput(state: PlayerState, input: PlayerInput): void {
    if (state.alive) stepMovement(state, input, this.map, input.dt)
    this.pending.push(input)
  }

  /**
   * Snaps `state`'s movement-relevant fields to the server-authoritative
   * `serverSnap`, drops every buffered input the server has already
   * processed (seq <= ackSeq), then replays whatever's left on top of the
   * corrected state. Returns the resulting position correction
   * (pre-reconcile predicted pos minus the reconciled pos) -- the caller
   * smooths this in visually over ~100ms instead of snapping the camera.
   */
  reconcile(state: PlayerState, serverSnap: SnapPlayer, ackSeq: number): Vec3 {
    const preCorrectionPos = { ...state.pos }

    state.pos = { ...serverSnap.pos }
    state.vel = { ...serverSnap.vel }
    state.yaw = serverSnap.yaw
    state.pitch = serverSnap.pitch
    state.alive = serverSnap.alive
    // SnapPlayer carries no teleportCooldownUntil (it's a per-tick
    // countdown, not a value worth putting on the wire) -- reset it.
    // Misprediction here is cosmetic (an early/late re-teleport window)
    // and self-heals within TELEPORT_COOLDOWN seconds of the next snapshot.
    state.teleportCooldownUntil = 0
    // SnapPlayer carries none of these either -- same self-heals-within-a-
    // snapshot reasoning as teleportCooldownUntil above.
    state.sprinting = false
    state.sliding = false
    state.slideTimeRemaining = 0
    state.slideCooldownRemaining = 0
    state.coyoteTimeRemaining = 0
    state.jumpBufferRemaining = 0

    let keepFrom = this.pending.length
    for (let i = 0; i < this.pending.length; i++) {
      if (this.pending[i].seq > ackSeq) {
        keepFrom = i
        break
      }
    }
    this.pending.splice(0, keepFrom)

    // Same alive-gating as applyInput: a dead player doesn't move
    // server-side, so replaying movement here would drift a corpse.
    if (state.alive) {
      for (const input of this.pending) {
        stepMovement(state, input, this.map, input.dt)
      }
    }

    return sub(preCorrectionPos, state.pos)
  }
}

interface BufferedSnapshot {
  time: number
  players: SnapPlayer[]
}

/**
 * Ring-buffered snapshot interpolator for remote entities. `sample`
 * linear-interps position/velocity/yaw/pitch between the two snapshots
 * bracketing `renderTime`; discrete fields (health, weapon, camo, ...)
 * just take the newer snapshot's value rather than interpolating.
 */
export class Interpolator {
  private readonly buffer: BufferedSnapshot[] = []
  // ~1.6s of history at the 20Hz snapshot rate -- comfortably more than
  // INTERP_DELAY (0.1s) needs, bounds memory against a runaway session.
  private readonly maxBuffered = 32

  push(snapshot: PredictSnapshot): void {
    this.buffer.push({ time: snapshot.time, players: snapshot.players })
    // Defends against an out-of-order delivery; snapshot.time is
    // monotonic on the wire but nothing enforces in-order arrival here.
    this.buffer.sort((a, b) => a.time - b.time)
    while (this.buffer.length > this.maxBuffered) this.buffer.shift()
  }

  /**
   * Returns interpolated poses at `renderTime` (caller passes
   * `now - INTERP_DELAY`). Holds the nearest known snapshot when starved
   * (renderTime outside the buffered range, or buffer has <2 entries).
   * Players present in the older bracketing snapshot but absent from the
   * newer one are dropped (they left the match).
   */
  sample(renderTime: number): SnapPlayer[] {
    const buf = this.buffer
    if (buf.length === 0) return []
    if (buf.length === 1) return buf[0].players
    if (renderTime <= buf[0].time) return buf[0].players
    if (renderTime >= buf[buf.length - 1].time) return buf[buf.length - 1].players

    let a = buf[0]
    let b = buf[buf.length - 1]
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].time <= renderTime && renderTime <= buf[i + 1].time) {
        a = buf[i]
        b = buf[i + 1]
        break
      }
    }

    const span = b.time - a.time
    const t = span > 0 ? (renderTime - a.time) / span : 0

    const bById = new Map(b.players.map((p) => [p.id, p]))
    const result: SnapPlayer[] = []
    for (const pa of a.players) {
      const pb = bById.get(pa.id)
      if (!pb) continue // dropped from the newer snapshot
      result.push({
        ...pb,
        pos: lerpV(pa.pos, pb.pos, t),
        vel: lerpV(pa.vel, pb.vel, t),
        yaw: lerpAngle(pa.yaw, pb.yaw, t),
        pitch: lerp(pa.pitch, pb.pitch, t),
      })
    }
    return result
  }
}

/** Shortest-arc lerp between two angles in radians. */
function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2
  let diff = ((b - a + Math.PI) % twoPi) - Math.PI
  if (diff < -Math.PI) diff += twoPi
  return a + diff * t
}
