import * as THREE from 'three'
import type { GameMap, PlayerState, ServerMsg, SnapPlayer, Vec3, WeaponId } from '@riftlane/shared'
import {
  EYE_HEIGHT,
  HITSCAN_MAX_RANGE,
  MAPS,
  MAX_SHIELD,
  MOVE_SPEED,
  WEAPONS,
  clamp,
  raycast,
  viewDir,
} from '@riftlane/shared'
import { createScene, type SceneCtx } from './render/scene'
import { buildMap } from './render/mapMesh'
import { syncFlags } from './render/flag'
import { makeSoldier, updateSoldier } from './render/soldier'
import { EffectsSystem } from './render/effects'
import { buildViewmodel, setViewmodelFlare, setViewmodelReload } from './render/viewmodel'
import { disposeObject3D } from './render/dispose'
import { bearing, decayTo } from './render/feel'
import type { InputManager } from './input'
import type { Net } from './net'
import { ClientPrediction } from './predict'
import { Hud } from './ui/hud'
import { audioEngine } from './audio'
import { announcer } from './announcer'
import { store } from './state'

type MatchStartMsg = Extract<ServerMsg, { t: 'match_start' }>
type SnapshotMsg = Extract<ServerMsg, { t: 'snapshot' }>

const VIEWMODEL_REST = { x: 0.27, y: -0.25, z: -0.62 }
const KICK_RECOVER_RATE = 8 // 1/s -- ~125ms to fully recover
const KICK_DEPTH = 0.08
const BOB_AMP_Y = 0.015
const BOB_AMP_X = 0.01
const MAX_DT = 0.1

// ---- game-feel tuning (client-only, never touches shared/ sim state) ------

const FOV_MAX_BUMP = 6 // degrees, at full MOVE_SPEED
const FOV_LERP_TAU = 0.15 // seconds
const ADS_FOV = 55 // degrees vertical, target FOV while fully scoped (base is baseFov, scene.ts's FOV_DEGREES=90)
const ADS_FOV_TAU = 0.12 // seconds -- snappier than FOV_LERP_TAU so scoping in/out reads as a deliberate press, not the ambient sprint-widen drift
const FOOTSTEP_MIN_SPEED_FRAC = 0.15 // below this the player reads as standing still, not walking
const LANDING_RECOVER_RATE = 5 // 1/s, same convention as KICK_RECOVER_RATE above
const LANDING_DIP_DEPTH = 0.16 // meters, camera Y dip on landing
const LANDING_DIP_VIEWMODEL_SCALE = 0.6
const LANDING_FALL_VEL = -4.5 // m/s downward velocity that counts as "falling"
const LANDING_SETTLE_VEL = 0.6 // |vel.y| this small right after a fast fall means the fall was arrested
const DAMAGE_ATTRIBUTION_RADIUS = 10 // meters -- "plausible source" radius for the damage-direction indicator
const SWAY_SMOOTH_TAU = 0.12
const SWAY_SCALE = 0.045
const SWAY_MAX = 0.02 // meters

/** Seconds between per-bullet hit sparks on the SAME target. Roughly two
 * pulse_smg shots (rof 10) so a stream still reads as continuous. */
const HIT_SPARK_MIN_INTERVAL = 0.06

// Audio-only heuristics: teleport/launchpad have no SimEvent on the wire, so
// both are detected by diffing raw player state between consecutive
// snapshots in playSnapshotAudio() below.
const TELEPORT_JUMP_DIST = 5 // meters/snapshot; teleporter endpoints in maps/*.ts are 20-36m apart, normal per-snapshot travel is well under 2m
const LAUNCH_VEL_Y_THRESHOLD = 8.5 // just above JUMP_SPEED (8); launchpad velocities in maps/*.ts start at 9

/** Structural shim for the power-pickup pad renderer that render/effects.ts
 * gains in stage 3. Declared here so the single call site below compiles
 * both before and after that method exists. */
interface PickupPadSync {
  syncPickups?(defs: NonNullable<GameMap['powerPickups']>, available: boolean[]): void
}

function eyePos(pos: Vec3): Vec3 {
  return { x: pos.x, y: pos.y + EYE_HEIGHT, z: pos.z }
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/**
 * Owns the render loop for one match: builds scene/map/soldiers on
 * match_start, then every frame samples input, drives remote soldiers +
 * effects off the latest snapshot, and draws the first-person viewmodel.
 *
 * localPose()/remotePoses() are the seam Task 13 replaces: today they just
 * read straight off the latest snapshot (own player included), so movement
 * is choppy at 20Hz until prediction/interpolation lands.
 */
export class Game {
  private raf = 0
  private lastTime = 0
  private readonly prediction = new ClientPrediction()
  private sceneCtx: SceneCtx | null = null
  private mapGroup: THREE.Group | null = null
  private map: GameMap | null = null
  private effects: EffectsSystem | null = null
  private readonly soldiers = new Map<string, THREE.Group>()
  private readonly viewmodels = new Map<WeaponId, THREE.Group>()
  private activeViewmodel: THREE.Group | null = null
  private viewmodelRig: THREE.Group | null = null
  private localId: string | null = null
  private readonly prevShields = new Map<string, number>()
  private readonly prevHealth = new Map<string, number>()
  /** Per-target throttle for the per-bullet hit spark, see the tick() loop. */
  private readonly lastHitSparkAt = new Map<string, number>()
  private latestSnapshot: SnapshotMsg | null = null
  private bobPhase = 0
  private footstepHalfCycle = 0 // Math.floor(bobPhase / Math.PI) as of the last footstep check
  private kickT = 1 // 1 = fully recovered, 0 = just fired
  private hud: Hud | null = null

  // ---- game-feel state (client-only juice, see feel.ts) -------------------
  private baseFov = 90 // matches render/scene.ts's FOV_DEGREES; immediately overwritten in start()
  private fovBump = 0 // additive degrees, lerped from horizontal speed
  private adsZoomT = 0 // 0 = unscoped, 1 = fully zoomed -- own (snappier) lerp track so ADS zoom never inherits fovBump's slower time constant
  private landingDipT = 1 // 1 = recovered, 0 = just landed
  private prevLookYaw = 0
  private prevLookPitch = 0
  private swayX = 0
  private swayY = 0
  // ADS sensitivity: input.ts's getSensitivity callback (wired in main.ts,
  // outside this file's ownership) reads store.state.settings.sensitivity
  // directly and applies it the instant a mousemove event fires -- there is
  // no "after the fact" seam to rescale a turn that already happened, so
  // the store value itself has to already be scaled at read time. See the
  // scoped block in updateViewmodel() for why mutating it here (never
  // persisted -- saveSettings() only ever runs from ui/menu.ts's own change
  // handlers) is the only reachable seam without editing input.ts/main.ts.
  private adsSensitivityMult = 1 // tan(halfFovScoped)/tan(halfFovBase); computed in start() once baseFov is known
  private baseSensitivity = store.state.settings.sensitivity // last known un-scoped sensitivity, restored on scope release
  private wasScoped = false

  // ---- pad + phase state ------------------------------------------------
  /** Reticle sat on a player last frame; feeds pad aim assist. One frame
   * stale by construction (the raycast needs this frame's camera), which is
   * ~16ms of an assist that is itself a gentle rate scale -- not felt. */
  private padOnTarget = false
  /** Pause panel opened with the pad's Start button. Kept apart from the
   * pointer-lock check: a pad player never holds lock, so lock alone can't
   * decide whether the panel is up. */
  private padPaused = false
  /** Whole seconds left in warmup as of the last snapshot, for the tick SFX. */
  private lastCountdownSec: number | null = null
  /** The "Fight!" bark fires once per match, on match_go (or on the first
   * snapshot of a server that runs no warmup at all). */
  private matchGoAnnounced = false
  /** Previous snapshot's per-pad availability, for the respawn chime. */
  private prevPickups: boolean[] = []

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly input: InputManager,
    private readonly net: Net
  ) {}

  start(msg: MatchStartMsg): void {
    this.teardown()

    const map = MAPS[msg.mapName]
    if (!map) throw new Error(`unknown map: ${msg.mapName}`)
    this.localId = msg.yourId
    this.map = map
    this.prediction.start(msg.yourId)
    this.prediction.setMap(map)

    const sceneCtx = createScene(this.canvas)
    this.sceneCtx = sceneCtx
    this.mapGroup = buildMap(map, sceneCtx.materials)
    sceneCtx.scene.add(this.mapGroup)
    this.effects = new EffectsSystem(sceneCtx.scene, sceneCtx.camera)

    for (const p of msg.players) {
      if (p.id === msg.yourId) continue // v1: no own body, first-person only
      const soldier = makeSoldier(p.team, sceneCtx.materials)
      sceneCtx.scene.add(soldier)
      this.soldiers.set(p.id, soldier)
    }

    this.viewmodelRig = new THREE.Group()
    this.viewmodelRig.position.set(VIEWMODEL_REST.x, VIEWMODEL_REST.y, VIEWMODEL_REST.z)
    sceneCtx.camera.add(this.viewmodelRig)

    this.bobPhase = 0
    this.kickT = 1
    this.hud = new Hud()
    this.hud.setResumeHandler(() => {
      // Covers both ways the panel opens: pointer lock lost (re-request it)
      // and the pad's Start button (just close the panel).
      this.padPaused = false
      this.canvas.requestPointerLock().catch(() => {
        // Refused mid-Escape-lockout; the overlay simply stays up.
      })
    })
    this.hud.setLeaveHandler(() => {
      this.padPaused = false
      this.net.send({ t: 'leave' })
      // Same patch shape main.ts uses when a dropped socket sends everyone
      // back to the menu -- the phase change is what tears the match down.
      store.set({ phase: 'menu', roomCode: null, hostId: null, players: [] })
    })

    this.setBaseFov(store.state.settings.fov)
    this.fovBump = 0
    this.adsZoomT = 0
    this.baseSensitivity = store.state.settings.sensitivity
    this.wasScoped = false
    this.landingDipT = 1
    const look = this.input.getLookAngles()
    this.prevLookYaw = look.yaw
    this.prevLookPitch = look.pitch
    this.swayX = 0
    this.swayY = 0
    this.padOnTarget = false
    this.padPaused = false
    this.lastCountdownSec = null
    this.matchGoAnnounced = false
    this.prevPickups = []

    this.lastTime = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  /** Applies a vertical-FOV setting (ui/menu.ts's slider, persisted in
   * state.ts) to the camera and to everything derived from it. Called on
   * match start and again whenever the pause-panel slider moves, so a
   * mid-match change is visible on the next frame. */
  private setBaseFov(fov: number): void {
    this.baseFov = fov
    if (this.sceneCtx) {
      this.sceneCtx.camera.fov = fov
      this.sceneCtx.camera.updateProjectionMatrix()
    }
    // ADS zoom is a fixed absolute FOV, so the sensitivity ratio it implies
    // moves with the base -- recompute both halves together or a wide-FOV
    // player gets the narrow-FOV player's scoped sensitivity.
    this.adsSensitivityMult = Math.tan(degToRad(ADS_FOV) / 2) / Math.tan(degToRad(fov) / 2)
    this.input.setAdsSensitivityMult(this.adsSensitivityMult)
  }

  onSnapshot(msg: SnapshotMsg): void {
    const prevSnap = this.latestSnapshot
    this.latestSnapshot = msg
    this.prediction.onSnapshot(msg)
    this.playPhaseAudio(msg)
    this.playPickupAudio(msg, prevSnap)
    this.playSnapshotAudio(msg, prevSnap)
    this.detectLocalHit(msg, prevSnap)
    this.detectDamageTaken(msg, prevSnap)
    this.detectLanding(msg, prevSnap)
  }

  /** Warmup countdown SFX + the one-per-match "Fight!" bark. Driven off
   * snapshots rather than the render loop so a tick fires once per whole
   * second, not once per frame that happens to straddle one. */
  private playPhaseAudio(msg: SnapshotMsg): void {
    const phase = msg.phase ?? 'playing'
    if (phase === 'warmup') {
      const sec = Math.max(0, Math.ceil(msg.timeLeft))
      if (sec !== this.lastCountdownSec) {
        audioEngine.play('countdown_tick')
        this.lastCountdownSec = sec
      }
      return
    }
    this.lastCountdownSec = null
    // match_go is the real trigger. The `!this.matchGoAnnounced` fallback
    // covers a server that runs no warmup at all (phase absent, no event),
    // which would otherwise start a match in silence.
    if (msg.events.some((ev) => ev.type === 'match_go') || !this.matchGoAnnounced) {
      this.matchGoAnnounced = true
      audioEngine.play('match_go')
      announcer.speak('match_start')
    }
  }

  /** Power-weapon pads: the toast + chime when one is taken, and a quieter
   * positional cue when a pad comes back up. Availability has no SimEvent,
   * so the respawn half is a diff of SnapshotMsg.pickups against the
   * previous snapshot -- same shape as the shield/teleport heuristics. */
  private playPickupAudio(msg: SnapshotMsg, prevSnap: SnapshotMsg | null): void {
    const localRaw = msg.players.find((p) => p.id === this.localId)
    const listener = localRaw ? { pos: eyePos(localRaw.pos), yaw: localRaw.yaw } : undefined

    for (const ev of msg.events) {
      if (ev.type !== 'pickup') continue
      const taker = msg.players.find((p) => p.id === ev.playerId)
      audioEngine.play('pickup_taken', taker ? { pos: eyePos(taker.pos), listener } : undefined)
      this.hud?.notifyPickup(WEAPONS[ev.weapon].name, ev.playerId === this.localId)
    }

    const pads = this.map?.powerPickups
    const avail = msg.pickups
    if (!pads || !avail) return
    if (prevSnap) {
      for (let i = 0; i < avail.length && i < pads.length; i++) {
        if (avail[i] && this.prevPickups[i] === false) {
          audioEngine.play('pickup_ready', { pos: pads[i].pos, listener })
        }
      }
    }
    this.prevPickups = avail
  }

  /**
   * Best-effort "did my last shot damage someone" detector. The wire
   * protocol's 'shot' SimEvent carries no target (server hit resolution is
   * silent -- see shared/src/sim.ts's stepFire, which applies damage
   * directly without pushing an event), so this diffs every other player's
   * health+shield against the previous snapshot and only fires when the
   * local player fired this tick AND exactly one other player's total HP
   * dropped. Two shooters landing hits in the same 20Hz tick, or a miss
   * that happens to coincide with someone else's hit, will occasionally
   * misattribute or (for >1 simultaneous victim) suppress the marker --
   * acceptable since this is cosmetic-only feedback with no effect on sim
   * state, same shape as the existing teleport/launchpad heuristics below.
   */
  private detectLocalHit(msg: SnapshotMsg, prevSnap: SnapshotMsg | null): void {
    if (!prevSnap || !this.localId) return
    if (!msg.events.some((ev) => ev.type === 'shot' && ev.playerId === this.localId)) return

    const prevById = new Map(prevSnap.players.map((p) => [p.id, p]))
    let hitId: string | null = null
    let ambiguous = false
    for (const p of msg.players) {
      if (p.id === this.localId) continue
      const prev = prevById.get(p.id)
      if (!prev) continue
      if (p.shield + p.health < prev.shield + prev.health - 0.01) {
        if (hitId !== null) {
          ambiguous = true
          break
        }
        hitId = p.id
      }
    }
    if (!hitId || ambiguous) return

    // A kill on this same victim already gets the stronger marker/sound
    // from Hud.processEvents' kill branch -- don't double-fire.
    const alreadyKilled = msg.events.some((ev) => ev.type === 'kill' && ev.victimId === hitId && ev.killerId === this.localId)
    if (alreadyKilled) return

    this.hud?.showHitMarker(false)
  }

  /**
   * Diffs the local player's own health+shield to detect "I just got hit",
   * then makes a best-effort guess at the direction using whatever's on the
   * wire this tick: an 'explosion' event (has a real position) if there's
   * exactly one within plausible splash range, else a single enemy 'shot'
   * event (no target field, so >1 shooter this tick means the direction is
   * unknowable and is skipped rather than guessed wrong). No SimEvent ties
   * damage to its source at all -- this is the mirror of detectLocalHit's
   * heuristic above.
   */
  private detectDamageTaken(msg: SnapshotMsg, prevSnap: SnapshotMsg | null): void {
    if (!prevSnap || !this.localId) return
    const prevLocal = prevSnap.players.find((p) => p.id === this.localId)
    const curLocal = msg.players.find((p) => p.id === this.localId)
    if (!prevLocal || !curLocal || !prevLocal.alive) return
    if (curLocal.shield + curLocal.health >= prevLocal.shield + prevLocal.health - 0.01) return

    audioEngine.play('damage_taken')

    let explosionPos: Vec3 | null = null
    let explosionCount = 0
    let shotShooterId: string | null = null
    let shotCount = 0
    for (const ev of msg.events) {
      if (ev.type === 'explosion') {
        explosionCount++
        const dist = Math.hypot(ev.pos.x - curLocal.pos.x, ev.pos.y - curLocal.pos.y, ev.pos.z - curLocal.pos.z)
        if (dist <= DAMAGE_ATTRIBUTION_RADIUS) explosionPos = ev.pos
      } else if (ev.type === 'shot' && ev.playerId !== this.localId) {
        shotCount++
        shotShooterId = ev.playerId
      }
    }

    let sourcePos: Vec3 | null = null
    if (explosionCount === 1 && explosionPos) {
      sourcePos = explosionPos
    } else if (shotCount === 1 && shotShooterId) {
      sourcePos = msg.players.find((p) => p.id === shotShooterId)?.pos ?? null
    }

    const bearingRad = sourcePos ? bearing(curLocal.pos, curLocal.yaw, sourcePos) : null
    this.hud?.notifyDamageTaken(bearingRad)
  }

  /** Landing-from-a-fall heuristic: a fast downward velocity last snapshot
   * arrested to near-zero this snapshot. SnapPlayer carries `vel` but not
   * `grounded` (see shared/src/protocol.ts), so this diffs vel.y instead --
   * same diff-based shape as the existing launchpad detection below. */
  private detectLanding(msg: SnapshotMsg, prevSnap: SnapshotMsg | null): void {
    if (!prevSnap || !this.localId) return
    const prevLocal = prevSnap.players.find((p) => p.id === this.localId)
    const curLocal = msg.players.find((p) => p.id === this.localId)
    if (!prevLocal || !curLocal || !curLocal.alive) return
    if (prevLocal.vel.y < LANDING_FALL_VEL && Math.abs(curLocal.vel.y) < LANDING_SETTLE_VEL) {
      this.landingDipT = 0
      audioEngine.play('land')
    }
  }

  /**
   * Fires SFX for one snapshot's worth of server events -- called once per
   * incoming snapshot (not once per render frame like tick() below, which
   * re-reads the same latestSnapshot across ~3 frames per 20Hz snapshot;
   * that repeat-read is fine for pooled visual effects but would
   * triple-fire every sound). kill/capture/flag_taken/explosion/shot come
   * straight off SimEvent. shield_hit/shield_break/teleport/launchpad have
   * no SimEvent on the wire, so they're detected by diffing this
   * snapshot's raw players against the previous one -- same heuristic
   * shape as Task 12's shield_break spark (tick()'s prevShields diff
   * below), reimplemented here against raw snapshot pairs instead of a
   * persistent per-frame map, since positional audio doesn't need the
   * eye-height-adjusted render pos tick() uses for spark placement.
   * LIMITATION: a big misprediction-correction snap or a repulsor/grapple
   * knockback that happens to clear the distance/velocity threshold can
   * mis-fire teleport/launchpad -- acceptable since this is cosmetic-only
   * client audio with no effect on sim state.
   */
  private playSnapshotAudio(msg: SnapshotMsg, prevSnap: SnapshotMsg | null): void {
    const localRaw = msg.players.find((p) => p.id === this.localId)
    const listener = localRaw ? { pos: eyePos(localRaw.pos), yaw: localRaw.yaw } : undefined
    const localTeam = localRaw ? localRaw.team : null

    for (const ev of msg.events) {
      if (ev.type === 'shot') {
        const shooter = msg.players.find((p) => p.id === ev.playerId)
        audioEngine.playWeapon(ev.weapon, shooter ? { pos: eyePos(shooter.pos), listener } : undefined)
      } else if (ev.type === 'explosion') {
        audioEngine.play('explosion', { pos: ev.pos, listener })
      } else if (ev.type === 'melee_swing' && ev.weapon === null) {
        // Unarmed melee was silent: a power-melee swing emits a paired 'shot'
        // event (handled above), but a bare beatdown emits only this one, so
        // nothing ever played the melee_swing recipe.
        const swinger = msg.players.find((p) => p.id === ev.playerId)
        audioEngine.play('melee_swing', swinger ? { pos: eyePos(swinger.pos), listener } : undefined)
      } else if (ev.type === 'kill') {
        const victim = msg.players.find((p) => p.id === ev.victimId)
        const at = victim ? { pos: eyePos(victim.pos), listener } : undefined
        // The sim reports a rear-arc beatdown as its own weapon, so an
        // assassination is audible to both parties without a new event.
        audioEngine.play(ev.weapon === 'backsmack' ? 'backsmack' : 'death', at)

        if (ev.killerId === this.localId && ev.killerId !== ev.victimId) {
          const bark = announcer.onLocalKill(ev.streak)
          if (bark === 'killing_spree' || bark === 'killing_frenzy' || bark === 'running_riot') {
            audioEngine.play('spree')
          }
          if (ev.weapon === 'backsmack') announcer.speak('backsmack')
        }
      } else if (ev.type === 'capture') {
        audioEngine.play('capture')
        if (localTeam !== null) {
          announcer.speak(ev.team === localTeam ? 'we_scored' : 'they_scored')
        }
      } else if (ev.type === 'flag_taken' || ev.type === 'flag_dropped' || ev.type === 'flag_returned') {
        // `ev.team` is the flag's OWN team, so "my team's flag" means the
        // enemy is carrying it -- the alarming case, not the good one.
        const ours = localTeam !== null && ev.team === localTeam
        if (ev.type === 'flag_taken') {
          audioEngine.play('flag_taken')
          announcer.speak(ours ? 'flag_taken_by_them' : 'flag_taken_by_us')
        } else if (ev.type === 'flag_dropped') {
          audioEngine.play('flag_dropped')
          announcer.speak(ours ? 'flag_dropped_ours' : 'flag_dropped_theirs')
        } else {
          audioEngine.play('flag_returned')
          announcer.speak(ours ? 'flag_returned_ours' : 'flag_returned_theirs')
        }
      }
    }

    if (!prevSnap) return
    const prevById = new Map(prevSnap.players.map((p) => [p.id, p]))
    for (const p of msg.players) {
      const prev = prevById.get(p.id)
      if (!prev || !p.alive) continue

      if (p.shield < prev.shield) {
        const opts = { pos: eyePos(p.pos), listener }
        if (p.shield <= 0 && prev.shield > 0) audioEngine.play('shield_break', opts)
        else audioEngine.play('shield_hit', opts)
      } else if (p.id === this.localId && p.shield >= MAX_SHIELD && prev.shield < MAX_SHIELD) {
        // The recovery half of the shield pair. Fires once, on reaching FULL
        // -- not on every recharging snapshot, and never for other players:
        // recharge is continuous and eight bots regenerating would turn this
        // into ambient chiming. Non-positional, like every other local cue.
        audioEngine.play('shield_recharge')
      }

      const dist = Math.hypot(p.pos.x - prev.pos.x, p.pos.y - prev.pos.y, p.pos.z - prev.pos.z)
      if (dist > TELEPORT_JUMP_DIST) {
        audioEngine.play('teleport', { pos: eyePos(p.pos), listener })
      } else if (p.vel.y > LAUNCH_VEL_Y_THRESHOLD && prev.vel.y <= LAUNCH_VEL_Y_THRESHOLD) {
        audioEngine.play('launchpad', { pos: eyePos(p.pos), listener })
      }
    }
  }

  private readonly loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(MAX_DT, (now - this.lastTime) / 1000)
    this.lastTime = now
    this.tick(dt)
  }

  private tick(dt: number): void {
    const ctx = this.sceneCtx
    const effects = this.effects
    if (!ctx || !effects || !this.mapGroup) return

    // The FOV slider lives in the pause panel, which is open while the game
    // keeps rendering -- so this is polled rather than pushed, and the
    // comparison keeps it to one projection-matrix rebuild per actual drag.
    if (store.state.settings.fov !== this.baseFov) this.setBaseFov(store.state.settings.fov)

    // Pad first: it writes into the same yaw/pitch the sample() below reads,
    // so polling after sampling would cost a frame of look latency.
    const scoped = this.prediction.isLocalScoped()
    this.input.pollGamepad(dt, { scoped, onTarget: this.padOnTarget })
    if (this.input.consumePadMenuToggle()) {
      this.padPaused = !this.padPaused
      // Lock swallows clicks, so the panel's own buttons would be unusable
      // if Start were pressed by someone who had also clicked into the game.
      if (this.padPaused && document.pointerLockElement === this.canvas) document.exitPointerLock()
    }

    // sample(0, 0): InputManager.sample's (seq, dt) args are only echoed
    // into its return value, never used for its own logic -- the
    // accumulator overrides both with the fixed-TICK_DT seq/dt it assigns
    // each emitted input, so the dummy args here are inert.
    const inputs = this.prediction.stepAndCollectInputs(dt, () => this.input.sample(0, 0))
    for (const inp of inputs) this.net.send({ t: 'input', input: inp })
    this.prediction.tick(dt)

    // Recovers independent of snapshot arrival so it stays smooth even if a
    // snapshot is dropped -- follows the repo's existing kickT convention
    // (0 = just triggered, 1 = fully recovered).
    this.landingDipT = Math.min(1, this.landingDipT + dt * LANDING_RECOVER_RATE)

    // Camera ROTATION is driven every render frame from the input manager's
    // continuous look angles, never from the predicted pose: rotation has no
    // server-authoritative component at all (the sim just echoes back the
    // yaw/pitch the client sent), so there is nothing to wait for and
    // stepping it at the 30Hz input tick was pure, visible stutter on a
    // 60-144Hz display. Position still comes from the predicted pose below,
    // interpolated between ticks (see ClientPrediction.localPose).
    //
    // This also IS the death cam: a dead player's predicted position is
    // frozen (Predictor skips movement while !alive, and the server freezes
    // the corpse), so the camera keeps looking around from where they fell
    // with no extra branch here.
    const look = this.input.getLookAngles()
    ctx.camera.rotation.x = look.pitch
    ctx.camera.rotation.y = look.yaw + Math.PI

    const snap = this.latestSnapshot
    if (snap) {
      const localSnap = snap.players.find((p) => p.id === this.localId)
      const pose = this.localPose()
      if (pose) {
        ctx.camera.position.set(pose.pos.x, pose.pos.y + EYE_HEIGHT, pose.pos.z)
        const landingFrac = 1 - this.landingDipT
        ctx.camera.position.y -= landingFrac * landingFrac * LANDING_DIP_DEPTH
      }

      const remotes = this.remotePoses()
      for (const remote of remotes) {
        const group = this.soldiers.get(remote.id)
        if (group) updateSoldier(group, remote)
      }

      // Halo-style red reticle: cosmetic-only client raycast against the
      // same interpolated positions the soldiers are drawn at, so the
      // reticle never flags a target the player can't actually see hit.
      // Never touches sim state -- this is purely a HUD color toggle.
      if (pose && this.map && localSnap?.alive) {
        const weapon = WEAPONS[localSnap.weapons[localSnap.activeWeapon]]
        const maxRange = weapon.maxRange ?? HITSCAN_MAX_RANGE
        const aimHit = raycast(
          eyePos(pose.pos),
          // Live look angles, matching the camera above -- the predicted
          // pose's yaw/pitch are the same numbers one tick late, and a
          // reticle that lags the crosshair it's drawn on reads as a bug.
          viewDir(look.yaw, look.pitch),
          maxRange,
          this.map.boxes,
          remotes as unknown as PlayerState[],
          this.localId ?? ''
        )
        this.padOnTarget = aimHit.kind === 'player'
        this.hud?.setTargetTracked(this.padOnTarget)
        this.hud?.setScoped(scoped)
      } else {
        this.padOnTarget = false
        this.hud?.setTargetTracked(false)
        this.hud?.setScoped(false)
      }

      effects.syncProjectiles(snap.projectiles)
      effects.handleEvents(snap.events, (id) => {
        const p = snap.players.find((pp) => pp.id === id)
        if (!p) return undefined
        return { pos: { x: p.pos.x, y: p.pos.y + EYE_HEIGHT, z: p.pos.z }, yaw: p.yaw, pitch: p.pitch }
      })

      // No shield_break / damage SimEvent on the wire -- detect both by
      // diffing against the previous snapshot instead. Safe to run per
      // render frame (unlike audio, see playSnapshotAudio's comment): the
      // prev maps are rewritten every frame, so a value that has not moved
      // since the last frame produces no second spark.
      const sparkNow = performance.now() / 1000
      for (const p of snap.players) {
        const prevShield = this.prevShields.get(p.id)
        const prevHealth = this.prevHealth.get(p.id)
        if (p.alive) {
          const at = { x: p.pos.x, y: p.pos.y + 1, z: p.pos.z }
          const broke = prevShield !== undefined && prevShield > 0 && p.shield <= 0
          if (broke) {
            effects.spawnShieldSpark(at)
            if (p.id === this.localId) this.hud?.notifyShieldBreak()
            this.lastHitSparkAt.set(p.id, sparkNow)
          } else if (
            (prevShield !== undefined && p.shield < prevShield) ||
            (prevHealth !== undefined && p.health < prevHealth)
          ) {
            // Throttled per target: the spark pool is 12 slots shared with
            // explosion and death bursts, and an 8-player scrum of 10-rof
            // SMGs would otherwise starve it and cost frames (60fps is a
            // shipping requirement, not a target).
            const last = this.lastHitSparkAt.get(p.id) ?? -Infinity
            if (sparkNow - last >= HIT_SPARK_MIN_INTERVAL) {
              const intoHealth = prevHealth !== undefined && p.health < prevHealth
              // Prefer the real impact point off this frame's 'shot' events
              // (stage 1 added shot.hit) so a headshot sparks at the helmet
              // instead of always at the torso. Shot events don't name a
              // victim, so the point is matched by proximity to this
              // player's torso; anything further out belongs to someone
              // else's shot. Falls back to the torso when no shot carried a
              // hit at all -- projectiles, melee and out-of-range misses.
              const HIT_MATCH_RADIUS = 1.6
              let sparkAt = at
              let bestSq = HIT_MATCH_RADIUS * HIT_MATCH_RADIUS
              for (const ev of snap.events) {
                if (ev.type !== 'shot' || !ev.hit) continue
                const dx = ev.hit.x - at.x
                const dy = ev.hit.y - at.y
                const dz = ev.hit.z - at.z
                const distSq = dx * dx + dy * dy + dz * dz
                if (distSq < bestSq) {
                  bestSq = distSq
                  sparkAt = ev.hit
                }
              }
              effects.spawnHitSpark(sparkAt, intoHealth)
              this.lastHitSparkAt.set(p.id, sparkNow)
            }
          }
        }
        this.prevShields.set(p.id, p.shield)
        this.prevHealth.set(p.id, p.health)
      }

      if (localSnap) {
        for (const ev of snap.events) {
          if (ev.type === 'shot' && ev.playerId === this.localId) {
            this.kickT = 0
          }
        }
        this.updateViewmodel(localSnap, dt, scoped, look)
      }

      effects.setDeathFade(localSnap ? !localSnap.alive : false, dt)

      this.hud?.setPhase(snap.phase ?? 'playing', snap.timeLeft)

      // --- stage-3 seam: EffectsSystem.syncPickups(defs, available) draws
      // the power-weapon pads. This is its only call site -- keep it. The
      // cast is a shim for the window before that method exists. ---
      ;(effects as unknown as PickupPadSync).syncPickups?.(this.map?.powerPickups ?? [], snap.pickups ?? [])

      // Both flags follow the server every frame: on their stand, lying where
      // they were dropped, or hidden because a carrier is wearing one.
      syncFlags(this.mapGroup, snap.flags)
    }

    // A pad player never clicks, so never holds pointer lock -- gating the
    // overlay on lock alone would leave "click to resume" pinned over a
    // perfectly playable match. Start opens the same panel deliberately.
    this.hud?.setInputPaused(this.padPaused || (!this.input.isLocked() && !this.input.isPadActive()))
    this.hud?.update(dt, snap, this.localId, this.input.scoreboardHeld())

    effects.tickMapPulse(this.mapGroup, dt)
    effects.update(dt)

    ctx.renderer.render(ctx.scene, ctx.camera)
  }

  // ---- render seam: local camera comes from Predictor (+ smoothed
  // reconcile correction), remote soldiers from Interpolator. ----

  private localPose(): { pos: Vec3; yaw: number; pitch: number } | null {
    return this.prediction.localPose()
  }

  private remotePoses(): SnapPlayer[] {
    return this.prediction.remotePoses()
  }

  // ---- viewmodel --------------------------------------------------------------

  private updateViewmodel(local: SnapPlayer, dt: number, scoped: boolean, look: { yaw: number; pitch: number }): void {
    if (!this.sceneCtx || !this.viewmodelRig) return
    const weaponId = local.weapons[local.activeWeapon]
    let mesh = this.viewmodels.get(weaponId)
    if (!mesh) {
      mesh = buildViewmodel(weaponId, this.sceneCtx.materials)
      this.viewmodels.set(weaponId, mesh)
    }
    if (this.activeViewmodel !== mesh) {
      if (this.activeViewmodel) this.viewmodelRig.remove(this.activeViewmodel)
      this.viewmodelRig.add(mesh)
      this.activeViewmodel = mesh
    }

    const speed = Math.hypot(local.vel.x, local.vel.z)
    const speedFrac = Math.min(1, speed / MOVE_SPEED)
    this.bobPhase += dt * (2 + speed * 0.6)
    const bobY = Math.sin(this.bobPhase * 2) * BOB_AMP_Y * speedFrac
    const bobX = Math.sin(this.bobPhase) * BOB_AMP_X * speedFrac

    // Footstep once per half bob-cycle, local player only, non-positional --
    // gated on speedFrac so standing still (bobPhase still drifts at its
    // idle baseline rate above) never ticks a step.
    const footstepHalfCycle = Math.floor(this.bobPhase / Math.PI)
    if (local.alive && speedFrac > FOOTSTEP_MIN_SPEED_FRAC && footstepHalfCycle !== this.footstepHalfCycle) {
      audioEngine.play('footstep')
    }
    this.footstepHalfCycle = footstepHalfCycle

    this.kickT = Math.min(1, this.kickT + dt * KICK_RECOVER_RATE)
    const kick = (1 - this.kickT) * KICK_DEPTH

    // FOV widens with horizontal speed -- lerped, not snapped, and capped at
    // FOV_MAX_BUMP so a full sprint never reads as a lens distortion. ADS
    // zoom overrides this outright rather than stacking with it: the
    // bump's own target is suppressed to 0 while scoped so it relaxes back
    // out, and the visible FOV cross-fades toward ADS_FOV on its own
    // snappier time constant (ADS_FOV_TAU) so scoping in/out reads as a
    // deliberate press, not drift shared with the ambient sprint widen.
    this.fovBump = decayTo(this.fovBump, scoped ? 0 : speedFrac * FOV_MAX_BUMP, dt, FOV_LERP_TAU)
    this.adsZoomT = decayTo(this.adsZoomT, scoped ? 1 : 0, dt, ADS_FOV_TAU)
    this.sceneCtx.camera.fov = this.baseFov + this.fovBump + (ADS_FOV - this.baseFov) * this.adsZoomT
    this.sceneCtx.camera.updateProjectionMatrix()

    // ADS sensitivity: scale the same store value input.ts's getSensitivity
    // callback reads, so mouse-look is actually slower while scoped -- a
    // fixed ratio for the whole time scoped is held (matching the task's
    // "while scoped" wording), not tied to the FOV lerp above, so this is
    // an edge-triggered write (at most twice per ADS press), not a
    // per-frame one. See the class-level comment on adsSensitivityMult for
    // why this is the only reachable seam. teardown() covers the case
    // where the match ends while still scoped, since the release-edge
    // restore below never gets a final frame to run in that case.
    if (scoped !== this.wasScoped) {
      const sensitivity = scoped ? this.baseSensitivity * this.adsSensitivityMult : this.baseSensitivity
      store.set({ settings: { ...store.state.settings, sensitivity } })
      this.wasScoped = scoped
    }
    if (!scoped) this.baseSensitivity = store.state.settings.sensitivity

    // View sway: a small, heavily-damped offset from how fast the player is
    // turning, sourced from InputManager's continuous look angles (not
    // `local.yaw/pitch`, which only update at the 20Hz snapshot rate and
    // would make the sway visibly step). Passed in from tick(), which
    // already read it for the camera -- one read per frame, not two.
    const twoPi = Math.PI * 2
    const yawDelta = ((look.yaw - this.prevLookYaw + Math.PI) % twoPi + twoPi) % twoPi - Math.PI
    const pitchDelta = look.pitch - this.prevLookPitch
    this.prevLookYaw = look.yaw
    this.prevLookPitch = look.pitch
    const rate = dt > 1e-4 ? 1 / dt : 0
    const targetSwayX = clamp(-yawDelta * rate * SWAY_SCALE, -SWAY_MAX, SWAY_MAX)
    const targetSwayY = clamp(pitchDelta * rate * SWAY_SCALE, -SWAY_MAX, SWAY_MAX)
    this.swayX = decayTo(this.swayX, targetSwayX, dt, SWAY_SMOOTH_TAU)
    this.swayY = decayTo(this.swayY, targetSwayY, dt, SWAY_SMOOTH_TAU)

    const landingFrac = 1 - this.landingDipT
    const landingDip = landingFrac * landingFrac * LANDING_DIP_DEPTH * LANDING_DIP_VIEWMODEL_SCALE

    mesh.position.set(bobX + this.swayX, bobY + this.swayY - landingDip, kick)

    // Same reload detection the HUD's RELOADING readout uses (ui/hud.ts's
    // updateWeapons): the sim refills the magazine only when the RELOAD_TIME
    // lockout ends, so an empty mag on the active slot IS the lockout
    // running. Power melee never reloads and never empties. Applied after
    // position.set above -- the dip stacks on this frame's bob/sway/kick.
    const reloading =
      local.ammo[local.activeWeapon] <= 0 && WEAPONS[weaponId].kind !== 'power_melee'
    setViewmodelReload(mesh, reloading, dt)

    setViewmodelFlare(mesh, this.kickT)
  }

  /**
   * Called on every match_start (a "rematch" is a fresh match_start too)
   * and whenever the client leaves the 'playing' phase. Order matters:
   * every geometry/material/texture this match allocated is disposed
   * *before* sceneCtx.dispose() tears down the renderer's internal caches
   * -- disposeObject3D()/EffectsSystem.dispose() rely on the old renderer
   * still being alive to actually free the GPU-side buffers/textures its
   * dispose-event listeners are wired to. renderer.dispose() alone does
   * NOT walk the scene disposing individual objects (see render/dispose.ts),
   * so without this every rematch would leak the previous match's map,
   * soldiers, effects pools, and cached viewmodel meshes.
   */
  teardown(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0

    const ctx = this.sceneCtx
    if (ctx) {
      if (this.mapGroup) {
        ctx.scene.remove(this.mapGroup)
        disposeObject3D(this.mapGroup)
      }
      for (const group of this.soldiers.values()) {
        ctx.scene.remove(group)
        disposeObject3D(group)
      }
      // Viewmodel meshes are parented to viewmodelRig (a child of the old
      // camera, discarded below with sceneCtx) -- still disposed
      // explicitly since removing from the scene graph frees no GPU memory
      // on its own.
      for (const mesh of this.viewmodels.values()) {
        disposeObject3D(mesh)
      }
      this.effects?.dispose()
    }
    ctx?.dispose()
    this.hud?.dispose()
    this.hud = null
    // Stop the match bed before suspending the context, so the ambient
    // crossfade doesn't get frozen mid-ramp and resume into a stuck drone
    // the next time a gesture wakes the engine. main.ts starts the menu bed
    // again on the phase change that follows.
    audioEngine.setAmbient(null)
    audioEngine.dispose()

    // Match can end (or the connection can drop) while still scoped -- the
    // release-edge restore in updateViewmodel() never gets a final frame to
    // run in that case, so without this the store is left holding the
    // ADS-scaled sensitivity for the rest of the session.
    if (this.wasScoped) {
      store.set({ settings: { ...store.state.settings, sensitivity: this.baseSensitivity } })
      this.wasScoped = false
    }

    this.sceneCtx = null
    this.mapGroup = null
    this.map = null
    this.effects = null
    this.soldiers.clear()
    this.viewmodels.clear()
    this.activeViewmodel = null
    this.viewmodelRig = null
    this.localId = null
    this.prevShields.clear()
    this.prevHealth.clear()
    this.lastHitSparkAt.clear()
    this.latestSnapshot = null
    this.padPaused = false
    this.padOnTarget = false
    this.prevPickups = []
  }
}
