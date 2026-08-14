import * as THREE from 'three'
import type { ServerMsg, SnapPlayer, Vec3, WeaponId } from '@riftlane/shared'
import { EYE_HEIGHT, MAPS, MOVE_SPEED, WEAPONS } from '@riftlane/shared'
import { createScene, type SceneCtx } from './render/scene'
import { buildMap } from './render/mapMesh'
import { makeSoldier, updateSoldier } from './render/soldier'
import { EffectsSystem } from './render/effects'
import { disposeObject3D } from './render/dispose'
import type { InputManager } from './input'
import type { Net } from './net'

type MatchStartMsg = Extract<ServerMsg, { t: 'match_start' }>
type SnapshotMsg = Extract<ServerMsg, { t: 'snapshot' }>

const VIEWMODEL_REST = { x: 0.32, y: -0.28, z: -0.55 }
const KICK_RECOVER_RATE = 8 // 1/s -- ~125ms to fully recover
const KICK_DEPTH = 0.08
const BOB_AMP_Y = 0.015
const BOB_AMP_X = 0.01
const MAX_DT = 0.1

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
  private seq = 0
  private sceneCtx: SceneCtx | null = null
  private mapGroup: THREE.Group | null = null
  private effects: EffectsSystem | null = null
  private readonly soldiers = new Map<string, THREE.Group>()
  private readonly viewmodels = new Map<WeaponId, THREE.Group>()
  private activeViewmodel: THREE.Group | null = null
  private viewmodelRig: THREE.Group | null = null
  private localId: string | null = null
  private readonly prevShields = new Map<string, number>()
  private latestSnapshot: SnapshotMsg | null = null
  private bobPhase = 0
  private kickT = 1 // 1 = fully recovered, 0 = just fired

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

    const sceneCtx = createScene(this.canvas)
    this.sceneCtx = sceneCtx
    this.mapGroup = buildMap(map)
    sceneCtx.scene.add(this.mapGroup)
    this.effects = new EffectsSystem(sceneCtx.scene, sceneCtx.camera)

    for (const p of msg.players) {
      if (p.id === msg.yourId) continue // v1: no own body, first-person only
      const soldier = makeSoldier(p.team)
      sceneCtx.scene.add(soldier)
      this.soldiers.set(p.id, soldier)
    }

    this.viewmodelRig = new THREE.Group()
    this.viewmodelRig.position.set(VIEWMODEL_REST.x, VIEWMODEL_REST.y, VIEWMODEL_REST.z)
    sceneCtx.camera.add(this.viewmodelRig)

    this.seq = 0
    this.bobPhase = 0
    this.kickT = 1
    this.lastTime = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  onSnapshot(msg: SnapshotMsg): void {
    this.latestSnapshot = msg
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

    const inp = this.input.sample(this.seq++, dt)
    this.net.send({ t: 'input', input: inp })

    const snap = this.latestSnapshot
    if (snap) {
      const localSnap = snap.players.find((p) => p.id === this.localId)
      const pose = this.localPose(localSnap)
      if (pose) {
        ctx.camera.position.set(pose.pos.x, pose.pos.y + EYE_HEIGHT, pose.pos.z)
        ctx.camera.rotation.x = pose.pitch
        ctx.camera.rotation.y = pose.yaw + Math.PI
      }

      for (const remote of this.remotePoses(snap.players)) {
        const group = this.soldiers.get(remote.id)
        if (group) updateSoldier(group, remote)
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
        }
        this.prevShields.set(p.id, p.shield)
      }

      if (localSnap) {
        for (const ev of snap.events) {
          if (ev.type === 'shot' && ev.playerId === this.localId) this.kickT = 0
        }
        this.updateViewmodel(localSnap, dt)
      }

      effects.setDeathFade(localSnap ? !localSnap.alive : false, dt)
    }

    effects.tickMapPulse(this.mapGroup)
    effects.update(dt)

    ctx.renderer.render(ctx.scene, ctx.camera)
  }

  // ---- render seam (Task 13 replaces both with prediction/interpolation) ----

  private localPose(snap: SnapPlayer | undefined): { pos: Vec3; yaw: number; pitch: number } | null {
    if (!snap) return null
    return { pos: snap.pos, yaw: snap.yaw, pitch: snap.pitch }
  }

  private remotePoses(players: SnapPlayer[]): SnapPlayer[] {
    return players.filter((p) => p.id !== this.localId)
  }

  // ---- viewmodel --------------------------------------------------------------

  private updateViewmodel(local: SnapPlayer, dt: number): void {
    if (!this.viewmodelRig) return
    const weaponId = local.weapons[local.activeWeapon]
    let mesh = this.viewmodels.get(weaponId)
    if (!mesh) {
      mesh = buildViewmodelMesh(weaponId)
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

    this.kickT = Math.min(1, this.kickT + dt * KICK_RECOVER_RATE)
    const kick = (1 - this.kickT) * KICK_DEPTH

    mesh.position.set(bobX, bobY, kick)
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

    this.sceneCtx = null
    this.mapGroup = null
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

/** Simple procedural low-poly weapon mesh, varied by WeaponDef.kind so all
 * ten weapon ids read as visually distinct without ten hand-authored
 * models: power_melee gets a blade, projectile/charge weapons get a fat
 * barrel, everything else a rifle-shaped barrel. */
function buildViewmodelMesh(id: WeaponId): THREE.Group {
  const def = WEAPONS[id]
  const group = new THREE.Group()
  const hue = weaponHue(id)
  const color = new THREE.Color().setHSL(hue, 0.55, 0.45).getHex()
  const mat = new THREE.MeshLambertMaterial({ color })
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x1a1d24 })

  if (def.kind === 'power_melee') {
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.3), darkMat)
    handle.position.z = 0.1
    group.add(handle)
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.5, 6), mat)
    blade.rotation.x = Math.PI / 2
    blade.position.z = -0.25
    group.add(blade)
    return group
  }

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.35), darkMat)
  group.add(body)
  const isFat = def.kind === 'projectile' || def.kind === 'charge'
  const barrelLen = isFat ? 0.4 : 0.28
  const barrelRad = isFat ? 0.05 : 0.025
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(barrelRad, barrelRad, barrelLen, 8), mat)
  barrel.rotation.x = Math.PI / 2
  barrel.position.z = -0.3
  group.add(barrel)
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.06), darkMat)
  grip.position.set(0, -0.1, 0.1)
  group.add(grip)
  return group
}

function weaponHue(id: WeaponId): number {
  const ids: WeaponId[] = [
    'pulse_smg',
    'triad_rifle',
    'railspike',
    'boomtube',
    'scattergun',
    'sidearm',
    'swarm_pod',
    'ion_charger',
    'arc_blade',
    'grav_maul',
  ]
  const idx = ids.indexOf(id)
  return idx / ids.length
}
