import * as THREE from 'three'
import type { GameMap, PlayerState, ServerMsg, SnapPlayer, Vec3, WeaponId } from '@riftlane/shared'
import { EYE_HEIGHT, HITSCAN_MAX_RANGE, MAPS, MOVE_SPEED, WEAPONS, clamp, raycast, viewDir } from '@riftlane/shared'
import { createScene, type SceneCtx } from './render/scene'
import { buildMap } from './render/mapMesh'
import { makeSoldier, updateSoldier } from './render/soldier'
import { EffectsSystem } from './render/effects'
import { buildViewmodel, setViewmodelFlare } from './render/viewmodel'
import { disposeObject3D } from './render/dispose'
import { ShakeRig, bearing, decayTo } from './render/feel'
import type { InputManager } from './input'
import type { Net } from './net'
import { ClientPrediction } from './predict'
import { Hud } from './ui/hud'
import { audioEngine, type SoundName } from './audio'

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
const FOOTSTEP_MIN_SPEED_FRAC = 0.15 // below this the player reads as standing still, not walking
const LANDING_RECOVER_RATE = 5 // 1/s, same convention as KICK_RECOVER_RATE above
const LANDING_DIP_DEPTH = 0.16 // meters, camera Y dip on landing
const LANDING_DIP_VIEWMODEL_SCALE = 0.6
const LANDING_FALL_VEL = -4.5 // m/s downward velocity that counts as "falling"
const LANDING_SETTLE_VEL = 0.6 // |vel.y| this small right after a fast fall means the fall was arrested
const LANDING_TRAUMA = 0.25
const DAMAGE_TRAUMA = 0.45
const EXPLOSION_TRAUMA_MAX = 0.75
const EXPLOSION_TRAUMA_RADIUS = 9 // meters -- cosmetic shake falloff only, not the sim's real splash radius
const DAMAGE_ATTRIBUTION_RADIUS = 10 // meters -- "plausible source" radius for the damage-direction indicator
const RECOIL_DECAY_TAU = 0.09 // seconds
const RECOIL_MAX = 0.09 // radians, hard cap so rapid-fire weapons can't stack recoil into a wild swing
const SWAY_SMOOTH_TAU = 0.12
const SWAY_SCALE = 0.045
const SWAY_MAX = 0.02 // meters

/** Relative fire-kick severity per weapon (0..1ish), scales both the
 * screenshake trauma and the recoil pitch kick -- one table instead of two
 * so a weapon can't have loud shake but no recoil or vice versa. */
const FIRE_KICK_SEVERITY: Record<WeaponId, number> = {
  pulse_smg: 0.4,
  sidearm: 0.35,
  triad_rifle: 0.55,
  scattergun: 0.85,
  railspike: 0.75,
  ion_charger: 0.6,
  boomtube: 1,
  swarm_pod: 0.6,
  arc_blade: 0.5,
  grav_maul: 0.85,
}
const FIRE_TRAUMA_BASE = 0.22
const FIRE_RECOIL_BASE = 0.03 // radians

// Audio-only heuristics: teleport/launchpad have no SimEvent on the wire, so
// both are detected by diffing raw player state between consecutive
// snapshots in playSnapshotAudio() below.
const TELEPORT_JUMP_DIST = 5 // meters/snapshot; teleporter endpoints in maps/*.ts are 20-36m apart, normal per-snapshot travel is well under 2m
const LAUNCH_VEL_Y_THRESHOLD = 8.5 // just above JUMP_SPEED (8); launchpad velocities in maps/*.ts start at 9

const WEAPON_SOUND: Record<WeaponId, SoundName> = {
  pulse_smg: 'shot_smg',
  sidearm: 'shot_smg',
  triad_rifle: 'shot_rifle',
  scattergun: 'shot_rifle',
  railspike: 'shot_rail',
  ion_charger: 'shot_rail',
  boomtube: 'shot_boom',
  swarm_pod: 'shot_boom',
  arc_blade: 'blade_lunge',
  grav_maul: 'melee_swing',
}

function eyePos(pos: Vec3): Vec3 {
  return { x: pos.x, y: pos.y + EYE_HEIGHT, z: pos.z }
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
  private latestSnapshot: SnapshotMsg | null = null
  private bobPhase = 0
  private footstepHalfCycle = 0 // Math.floor(bobPhase / Math.PI) as of the last footstep check
  private kickT = 1 // 1 = fully recovered, 0 = just fired
  private hud: Hud | null = null

  // ---- game-feel state (client-only juice, see feel.ts) -------------------
  private shakeRig = new ShakeRig()
  private recoilPitch = 0 // radians, decays exponentially toward 0
  private baseFov = 90 // matches render/scene.ts's FOV_DEGREES; immediately overwritten in start()
  private fovBump = 0 // additive degrees, lerped from horizontal speed
  private landingDipT = 1 // 1 = recovered, 0 = just landed
  private prevLookYaw = 0
  private prevLookPitch = 0
  private swayX = 0
  private swayY = 0

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

    this.shakeRig = new ShakeRig()
    this.recoilPitch = 0
    this.baseFov = sceneCtx.camera.fov
    this.fovBump = 0
    this.landingDipT = 1
    const look = this.input.getLookAngles()
    this.prevLookYaw = look.yaw
    this.prevLookPitch = look.pitch
    this.swayX = 0
    this.swayY = 0

    this.lastTime = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  onSnapshot(msg: SnapshotMsg): void {
    const prevSnap = this.latestSnapshot
    this.latestSnapshot = msg
    this.prediction.onSnapshot(msg)
    this.playSnapshotAudio(msg, prevSnap)
    this.detectLocalHit(msg, prevSnap)
    this.detectDamageTaken(msg, prevSnap)
    this.detectLanding(msg, prevSnap)
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
    if (!prevLocal || !curLocal || !curLocal.alive) return
    if (curLocal.shield + curLocal.health >= prevLocal.shield + prevLocal.health - 0.01) return

    this.shakeRig.addTrauma(DAMAGE_TRAUMA)
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
      this.shakeRig.addTrauma(LANDING_TRAUMA)
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

    for (const ev of msg.events) {
      if (ev.type === 'shot') {
        const shooter = msg.players.find((p) => p.id === ev.playerId)
        audioEngine.play(WEAPON_SOUND[ev.weapon], shooter ? { pos: eyePos(shooter.pos), listener } : undefined)
      } else if (ev.type === 'explosion') {
        audioEngine.play('explosion', { pos: ev.pos, listener })
      } else if (ev.type === 'kill') {
        const victim = msg.players.find((p) => p.id === ev.victimId)
        audioEngine.play('death', victim ? { pos: eyePos(victim.pos), listener } : undefined)
      } else if (ev.type === 'capture') {
        audioEngine.play('capture')
      } else if (ev.type === 'flag_taken') {
        audioEngine.play('flag_taken')
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

    // sample(0, 0): InputManager.sample's (seq, dt) args are only echoed
    // into its return value, never used for its own logic -- the
    // accumulator overrides both with the fixed-TICK_DT seq/dt it assigns
    // each emitted input, so the dummy args here are inert.
    const inputs = this.prediction.stepAndCollectInputs(dt, () => this.input.sample(0, 0))
    for (const inp of inputs) this.net.send({ t: 'input', input: inp })
    this.prediction.tick(dt)

    // Decay independent of snapshot arrival so recovery stays smooth even
    // if a snapshot is dropped -- both follow the repo's existing kickT
    // convention (0 = just triggered, 1 = fully recovered).
    this.recoilPitch = decayTo(this.recoilPitch, 0, dt, RECOIL_DECAY_TAU)
    this.landingDipT = Math.min(1, this.landingDipT + dt * LANDING_RECOVER_RATE)

    const snap = this.latestSnapshot
    if (snap) {
      const localSnap = snap.players.find((p) => p.id === this.localId)
      const pose = this.localPose()
      if (pose) {
        ctx.camera.position.set(pose.pos.x, pose.pos.y + EYE_HEIGHT, pose.pos.z)
        ctx.camera.rotation.x = pose.pitch - this.recoilPitch
        ctx.camera.rotation.y = pose.yaw + Math.PI
        // Screenshake is the only thing that ever writes rotation.z; reset
        // it before applying so ShakeRig's additive offset never
        // accumulates onto a stale value from a previous frame (position.x
        // /y and rotation.x/y are safe because they're fully overwritten
        // above every frame -- z is the one component nothing else sets).
        ctx.camera.rotation.z = 0
        const landingFrac = 1 - this.landingDipT
        ctx.camera.position.y -= landingFrac * landingFrac * LANDING_DIP_DEPTH
        this.shakeRig.update(dt, ctx.camera)
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
          viewDir(pose.yaw, pose.pitch),
          maxRange,
          this.map.boxes,
          remotes as unknown as PlayerState[],
          this.localId ?? ''
        )
        this.hud?.setTargetTracked(aimHit.kind === 'player')
      } else {
        this.hud?.setTargetTracked(false)
      }

      effects.syncProjectiles(snap.projectiles)
      effects.handleEvents(snap.events, (id) => {
        const p = snap.players.find((pp) => pp.id === id)
        if (!p) return undefined
        return { pos: { x: p.pos.x, y: p.pos.y + EYE_HEIGHT, z: p.pos.z }, yaw: p.yaw, pitch: p.pitch }
      })

      // No shield_break SimEvent on the wire -- detect the break by diffing
      // shield against the previous snapshot instead.
      for (const p of snap.players) {
        const prevShield = this.prevShields.get(p.id)
        if (prevShield !== undefined && prevShield > 0 && p.shield <= 0 && p.alive) {
          effects.spawnShieldSpark({ x: p.pos.x, y: p.pos.y + 1, z: p.pos.z })
          if (p.id === this.localId) this.hud?.notifyShieldBreak()
        }
        this.prevShields.set(p.id, p.shield)
      }

      if (localSnap) {
        for (const ev of snap.events) {
          if (ev.type === 'shot' && ev.playerId === this.localId) {
            this.kickT = 0
            const severity = FIRE_KICK_SEVERITY[ev.weapon]
            this.shakeRig.addTrauma(FIRE_TRAUMA_BASE * severity)
            this.recoilPitch = Math.min(RECOIL_MAX, this.recoilPitch + FIRE_RECOIL_BASE * severity)
          } else if (ev.type === 'explosion') {
            const dist = Math.hypot(
              ev.pos.x - localSnap.pos.x,
              ev.pos.y - localSnap.pos.y,
              ev.pos.z - localSnap.pos.z
            )
            if (dist < EXPLOSION_TRAUMA_RADIUS) {
              const falloff = 1 - dist / EXPLOSION_TRAUMA_RADIUS
              this.shakeRig.addTrauma(EXPLOSION_TRAUMA_MAX * falloff * falloff)
            }
          }
        }
        this.updateViewmodel(localSnap, dt)
      }

      effects.setDeathFade(localSnap ? !localSnap.alive : false, dt)
    }

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

  private updateViewmodel(local: SnapPlayer, dt: number): void {
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
    // FOV_MAX_BUMP so a full sprint never reads as a lens distortion.
    this.fovBump = decayTo(this.fovBump, speedFrac * FOV_MAX_BUMP, dt, FOV_LERP_TAU)
    this.sceneCtx.camera.fov = this.baseFov + this.fovBump
    this.sceneCtx.camera.updateProjectionMatrix()

    // View sway: a small, heavily-damped offset from how fast the player is
    // turning, sourced from InputManager's continuous look angles (not
    // `local.yaw/pitch`, which only update at the 20Hz snapshot rate and
    // would make the sway visibly step).
    const look = this.input.getLookAngles()
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
    audioEngine.dispose()

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
    this.latestSnapshot = null
  }
}
