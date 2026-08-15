import type { GameMap, PlayerInput, PlayerState, SnapPlayer, Vec3 } from '@riftlane/shared'
import {
  Predictor,
  Interpolator,
  type PredictSnapshot,
  TICK_DT,
  INTERP_DELAY,
  MAX_HEALTH,
  MAX_SHIELD,
  lerp,
} from '@riftlane/shared'

// Camera eases a reconcile correction out over this long instead of
// snapping straight to the server's authoritative position.
const CORRECTION_SMOOTH_TIME = 0.1
/** A correction bigger than this is a real misprediction (a respawn
 * teleport, a launchpad the client never saw, a dropped input burst), not
 * the sub-metre drift CORRECTION_SMOOTH_TIME exists to hide. Easing one out
 * over 100ms drags the camera through the world at tens of m/s and reads as
 * a lurch; snapping is the honest, less nauseating answer. */
const CORRECTION_SNAP_DIST = 2.5

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

  /** How far into the NEXT tick the accumulator already is, 0..1. The
   * render frame that consumed the last whole tick is almost never sitting
   * exactly on a tick boundary; this leftover is what lets the caller draw
   * the in-between position instead of holding the last tick's pose until
   * the next one lands (see ClientPrediction.localPose). */
  alpha(): number {
    return this.acc / TICK_DT
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
    meleeCooldownUntil: 0,
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
    scoped: false,
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
  /** Position the local player held BEFORE the most recently applied tick.
   * Mutated in place, never reassigned -- localPose() runs every render
   * frame and must not allocate. */
  private readonly prevPos: Vec3 = { x: 0, y: 0, z: 0 }
  private readonly correctionOffset: Vec3 = { x: 0, y: 0, z: 0 }
  /** Single reused return value for localPose(). Callers read it and are
   * done with it inside the same frame (game.ts does); nothing may hold on
   * to it across frames. */
  private readonly poseScratch = { pos: { x: 0, y: 0, z: 0 } as Vec3, yaw: 0, pitch: 0 }
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
    this.prevPos.x = this.prevPos.y = this.prevPos.z = 0
    this.correctionOffset.x = this.correctionOffset.y = this.correctionOffset.z = 0
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
      for (const input of inputs) {
        // Remember where this tick started before stepping it, so the
        // render frames that fall between this tick and the next one can be
        // drawn along the segment instead of parked on its end point.
        const pos = this.localState.pos
        this.prevPos.x = pos.x
        this.prevPos.y = pos.y
        this.prevPos.z = pos.z
        this.predictor.applyInput(this.localState, input)
      }
    }
    return inputs
  }

  /** Call once per render frame (any order relative to stepAndCollectInputs)
   * to advance the free-running server-clock estimate and decay the
   * reconcile correction offset toward zero. */
  tick(dt: number): void {
    if (this.haveClock) this.serverClock += dt
    const keep = 1 - Math.min(1, dt / CORRECTION_SMOOTH_TIME)
    this.correctionOffset.x *= keep
    this.correctionOffset.y *= keep
    this.correctionOffset.z *= keep
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
      this.prevPos.x = this.localState.pos.x
      this.prevPos.y = this.localState.pos.y
      this.prevPos.z = this.localState.pos.z
      return
    }

    const delta = this.predictor.reconcile(this.localState, serverLocal, snap.ackSeq)
    // reconcile() moved pos by -delta; move the interpolation's start point
    // by the same amount so the prev->curr segment still describes one
    // tick of travel rather than a jump from a pre-correction position.
    this.prevPos.x -= delta.x
    this.prevPos.y -= delta.y
    this.prevPos.z -= delta.z

    if (Math.hypot(delta.x, delta.y, delta.z) > CORRECTION_SNAP_DIST) {
      // Too big to ease out (see CORRECTION_SNAP_DIST) -- drop the offset
      // entirely, which puts the camera on the server's answer this frame.
      this.correctionOffset.x = this.correctionOffset.y = this.correctionOffset.z = 0
      return
    }
    // Fold the new correction in on top of whatever hadn't finished
    // decaying yet, so back-to-back corrections don't visually pop.
    this.correctionOffset.x += delta.x
    this.correctionOffset.y += delta.y
    this.correctionOffset.z += delta.z
  }

  /**
   * Predicted local camera pose, or null before the first snapshot arrives.
   *
   * Position is interpolated across the fixed TICK_DT prediction step: the
   * sim only moves the player 30 times a second, but the display runs at 60+
   * and would otherwise show the same position for two or three frames in a
   * row -- a visible per-frame stutter that no amount of smooth mouselook
   * hides. Rendering `alpha` of the way from the previous tick to the
   * current one costs one fixed tick (33ms) of position latency, which is
   * the standard fixed-timestep trade and far less noticeable than the
   * stepping it removes.
   *
   * Returns a REUSED object (see poseScratch) -- read it this frame, don't
   * store it.
   */
  localPose(): { pos: Vec3; yaw: number; pitch: number } | null {
    if (!this.localState) return null
    const t = Math.min(1, this.accumulator.alpha())
    const cur = this.localState.pos
    const out = this.poseScratch
    out.pos.x = lerp(this.prevPos.x, cur.x, t) + this.correctionOffset.x
    out.pos.y = lerp(this.prevPos.y, cur.y, t) + this.correctionOffset.y
    out.pos.z = lerp(this.prevPos.z, cur.z, t) + this.correctionOffset.z
    out.yaw = this.localState.yaw
    out.pitch = this.localState.pitch
    return out
  }

  /** Whether the local player is currently aiming down sights, straight off
   * the predicted PlayerState -- stepMovement recomputes `scoped` fresh
   * every tick from input.ads (shared/src/physics.ts), so this is the same
   * value the server itself uses for spread/speed, not a re-derivation
   * from raw input. False before the first snapshot arrives. */
  isLocalScoped(): boolean {
    return this.localState?.scoped ?? false
  }

  /** Interpolated poses for every remote player (local player excluded). */
  remotePoses(): SnapPlayer[] {
    if (!this.haveClock) return []
    return this.interpolator.sample(this.serverClock - INTERP_DELAY).filter((p) => p.id !== this.localId)
  }
}
