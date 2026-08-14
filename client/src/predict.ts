import type { GameMap, PlayerInput, PlayerState, SnapPlayer, Vec3 } from '@riftlane/shared'
import {
  Predictor,
  Interpolator,
  type PredictSnapshot,
  TICK_DT,
  INTERP_DELAY,
  MAX_HEALTH,
  MAX_SHIELD,
  add,
  scale,
} from '@riftlane/shared'

// Camera eases a reconcile correction out over this long instead of
// snapping straight to the server's authoritative position.
const CORRECTION_SMOOTH_TIME = 0.1

/**
 * Turns variable-length render-frame dt into a stream of fixed TICK_DT
 * chunks, tagging each with a monotonic seq. This is the other half of the
 * parity contract documented on shared/src/predict.ts's Predictor: the
 * server sim always steps movement in TICK_DT increments, so replay only
 * matches bit-for-bit if what gets predicted (and sent to the server) is
 * itself TICK_DT-sized -- not a raw requestAnimationFrame dt, which varies
 * frame to frame and would drift the replay off the server's own math.
 * Usually emits 0 or 1 input per frame, occasionally 2 after a slow frame.
 */
export class InputAccumulator {
  private acc = 0
  private seq = 0

  step(dt: number, sampleInput: () => Omit<PlayerInput, 'seq' | 'dt'>): PlayerInput[] {
    this.acc += dt
    const out: PlayerInput[] = []
    while (this.acc >= TICK_DT) {
      this.acc -= TICK_DT
      out.push({ ...sampleInput(), seq: this.seq, dt: TICK_DT })
      this.seq++
    }
    return out
  }
}

/** Minimal PlayerState reconstructed from the wire-thin SnapPlayer the
 * first time we see our own player in a snapshot. Only movement-relevant
 * fields (pos/vel/yaw/pitch/grounded/carryingFlag/alive) matter for
 * replay through stepMovement -- everything else is a placeholder default,
 * since the Predictor never reads or writes combat fields. */
function reconstructPlayerState(snap: SnapPlayer): PlayerState {
  return {
    id: snap.id,
    name: snap.name,
    team: snap.team,
    bot: snap.bot,
    pos: { ...snap.pos },
    vel: { ...snap.vel },
    yaw: snap.yaw,
    pitch: snap.pitch,
    grounded: false,
    shield: MAX_SHIELD,
    health: MAX_HEALTH,
    alive: snap.alive,
    respawnAt: 0,
    lastDamageAt: 0,
    weapons: snap.weapons,
    activeWeapon: snap.activeWeapon,
    ammo: [0, 0],
    cooldownUntil: 0,
    grenadeCooldownUntil: 0,
    grenades: { frag: 0, mag: 0 },
    equipment: null,
    equipmentCharges: 0,
    equipmentCooldownUntil: 0,
    swapCooldownUntil: 0,
    camoUntil: 0,
    carryingFlag: snap.carryingFlag,
    stuckDarts: 0,
    kills: 0,
    deaths: 0,
    captures: 0,
    // Not carried on the wire -- see Predictor.reconcile's comment.
    teleportCooldownUntil: 0,
    sprinting: false,
    sliding: false,
    slideTimeRemaining: 0,
    slideCooldownRemaining: 0,
    coyoteTimeRemaining: 0,
    jumpBufferRemaining: 0,
  }
}

/**
 * Wires Predictor + Interpolator + InputAccumulator into what game.ts
 * needs: a smoothed local camera pose predicted ahead of the last
 * snapshot, and interpolated poses for remote soldiers.
 */
export class ClientPrediction {
  private predictor: Predictor | null = null
  private interpolator = new Interpolator()
  private accumulator = new InputAccumulator()
  private localState: PlayerState | null = null
  private localId: string | null = null
  private correctionOffset: Vec3 = { x: 0, y: 0, z: 0 }
  // Local estimate of the server's sim clock (same units as
  // snapshot.time): anchored to the latest snapshot on arrival, then
  // free-runs forward with each frame's dt in between.
  private serverClock = 0
  private haveClock = false

  /** Called on every match_start (a rematch is a fresh match_start too --
   * see game.ts's teardown()) to fully reset state. Rebuilding the
   * Interpolator/InputAccumulator here (not just clearing localState)
   * matters: the sim clock restarts near 0 for a new match, and the old
   * Interpolator's buffered snapshots would otherwise carry stale, much
   * larger `time` values that could get sampled ahead of real data. */
  start(localId: string): void {
    this.predictor = null
    this.interpolator = new Interpolator()
    this.accumulator = new InputAccumulator()
    this.localState = null
    this.localId = localId
    this.correctionOffset = { x: 0, y: 0, z: 0 }
    this.serverClock = 0
    this.haveClock = false
  }

  setMap(map: GameMap): void {
    this.predictor = new Predictor(map)
  }

  /** Call once per render frame, before sending input to the server.
   * Samples the accumulator (0+ fixed-size inputs), predicts each locally,
   * and returns them for the caller to transmit. */
  stepAndCollectInputs(dt: number, sampleInput: () => Omit<PlayerInput, 'seq' | 'dt'>): PlayerInput[] {
    const inputs = this.accumulator.step(dt, sampleInput)
    if (this.predictor && this.localState) {
      for (const input of inputs) this.predictor.applyInput(this.localState, input)
    }
    return inputs
  }

  /** Call once per render frame (any order relative to stepAndCollectInputs)
   * to advance the free-running server-clock estimate and decay the
   * reconcile correction offset toward zero. */
  tick(dt: number): void {
    if (this.haveClock) this.serverClock += dt
    const decay = Math.min(1, dt / CORRECTION_SMOOTH_TIME)
    this.correctionOffset = scale(this.correctionOffset, 1 - decay)
  }

  onSnapshot(snap: PredictSnapshot): void {
    this.interpolator.push(snap)
    this.serverClock = snap.time
    this.haveClock = true

    if (!this.predictor || !this.localId) return
    const serverLocal = snap.players.find((p) => p.id === this.localId)
    if (!serverLocal) return

    if (!this.localState) {
      this.localState = reconstructPlayerState(serverLocal)
      return
    }

    const delta = this.predictor.reconcile(this.localState, serverLocal, snap.ackSeq)
    // Fold the new correction in on top of whatever hadn't finished
    // decaying yet, so back-to-back corrections don't visually pop.
    this.correctionOffset = add(this.correctionOffset, delta)
  }

  /** Predicted local camera pose (position smoothed by the decaying
   * reconcile offset), or null before the first snapshot arrives. */
  localPose(): { pos: Vec3; yaw: number; pitch: number } | null {
    if (!this.localState) return null
    return {
      pos: add(this.localState.pos, this.correctionOffset),
      yaw: this.localState.yaw,
      pitch: this.localState.pitch,
    }
  }

  /** Interpolated poses for every remote player (local player excluded). */
  remotePoses(): SnapPlayer[] {
    if (!this.haveClock) return []
    return this.interpolator.sample(this.serverClock - INTERP_DELAY).filter((p) => p.id !== this.localId)
  }
}
