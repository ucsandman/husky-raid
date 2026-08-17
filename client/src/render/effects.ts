import * as THREE from 'three'
import type { GameMap, SimEvent, SnapProjectile, Vec3 } from '@riftlane/shared'
import { PICKUP_RADIUS, WEAPONS, viewDir } from '@riftlane/shared'
import { disposeObject3D } from './dispose'
import { makeFlareTexture, makeSoftDotTexture, makeStreakTexture } from './materials'
import { accentColor, buildWeaponHolo } from './viewmodel'

const TRACER_LIFE = 0.09
const MUZZLE_LIFE = 0.07
const EXPLOSION_LIFE = 0.34
const RING_LIFE = 0.42
const SPARK_LIFE = 0.3
const SLASH_LIFE = 0.2
// Halo-style thin readable tracers, not fat glowing orbs: was 30 long x
// 0.045 radius, which read as a persistent fat laser beam, especially
// stacked across a 10rps weapon like pulse_smg.
const TRACER_LENGTH = 20
const TRACER_RADIUS = 0.02
const TRACER_POOL = 24
const MUZZLE_POOL = 12
const EXPLOSION_POOL = 8
const RING_POOL = 10
const SPARK_POOL = 12
const SPARK_POINTS = 22
const SPARK_BURST_RADIUS = 0.5
const SLASH_POOL = 6
/** Metres in front of the swinger's eye. Well inside MELEE_RANGE, and far
 * enough out that the swinger's OWN slash reads as an arc in front of him
 * rather than a wipe across the whole screen -- these events fire for the
 * local player too, and at 90 degrees vertical FOV the half-screen height in
 * metres is the same number as this distance. */
const SLASH_DIST = 1.2

// ---- power-weapon pickup pads -------------------------------------------
const PAD_RING_OPACITY = 0.55
/** Collected pads stay drawn but dim, so a player can still see WHERE the
 * rocket spawns while it is on cooldown. */
const PAD_RING_DIM = 0.12
const PAD_HOLO_OPACITY = 0.5
const PAD_HOLO_HEIGHT = 1.05
const PAD_HOLO_SCALE = 1.35
const PAD_HOLO_SPIN = 0.7 // rad/s
const PAD_HOLO_BOB = 0.09 // metres, half-amplitude
const PAD_HOLO_BOB_RATE = 1.3

// Bright white core (was a warm amber tint) reads crisper at speed and
// against the arena's cool lighting -- muzzle flash below keeps the amber.
const TRACER_COLOR = 0xffffff
const MUZZLE_COLOR = 0xffe08a
const EXPLOSION_COLOR = 0xff8a3c
const SHOCKWAVE_COLOR = 0xffc27a
const SHIELD_SPARK_COLOR = 0x9fe6ff
/** DESIGN.md's --danger. Health damage is a state, and state colours are
 * the ok/warn/danger band -- never cobalt/ember, which mean team identity. */
const HEALTH_SPARK_COLOR = 0xff4d5e
const DEATH_COLOR = 0xff5f7a
/** Power-melee arc: the same hot amber the explosions use, so an arc_blade
 * lunge reads as "that hurt" at a glance. A bare bash is plain white and
 * smaller -- it is the weakest attack in the game and should look it. */
const SLASH_POWER_COLOR = 0xffb066
const SLASH_BASH_COLOR = 0xe8f4ff

// syncProjectiles orients a mesh toward its velocity every frame for every
// live projectile -- a shared, never-mutated axis constant plus one reused
// scratch vector (below, on the class) avoids two `new THREE.Vector3()`
// allocations per projectile per frame.
const UP_AXIS = new THREE.Vector3(0, 1, 0)
/** Arc-slash planes are authored facing +Z, the same convention the tracer
 * cylinder uses for UP_AXIS -- aimed by rotating that axis onto the view
 * direction. */
const FORWARD_AXIS = new THREE.Vector3(0, 0, 1)

interface Slot<T extends THREE.Object3D> {
  obj: T
  active: boolean
  life: number
  maxLife: number
}

type PickupDefs = NonNullable<GameMap['powerPickups']>

/** One power-weapon pad: a floor ring that dims while the weapon is on
 * cooldown, and a hovering hologram of the weapon itself that disappears with
 * it. Built once per match, animated in place -- never per-frame allocated. */
interface PickupPad {
  ring: THREE.Mesh
  ringMat: THREE.MeshBasicMaterial
  holo: THREE.Mesh | null
  baseY: number
  color: number
  up: boolean
}

interface ProjectileKit {
  core: THREE.BufferGeometry
  coreMat: THREE.Material
  glow: THREE.BufferGeometry
  glowMat: THREE.Material
}

/**
 * All transient VFX (tracers, muzzle flashes, explosions, shockwave rings,
 * spark bursts) + pooled per-id projectile meshes + the death-fade overlay.
 * Pools are fixed-size arrays of pre-allocated Object3Ds, reused round-robin
 * -- 60fps on integrated graphics means never allocating/disposing geometry
 * inside the render loop for effects that fire dozens of times a match.
 * Every pooled effect owns its own material so a fade can be animated
 * without touching a neighbour's.
 */
export class EffectsSystem {
  private readonly scene: THREE.Scene
  private readonly camera: THREE.Camera
  private readonly dotTexture = makeSoftDotTexture()
  private readonly flareTexture = makeFlareTexture()
  private readonly streakTexture = makeStreakTexture()
  private readonly tracers: Slot<THREE.Mesh>[] = []
  private readonly muzzles: Slot<THREE.Sprite>[] = []
  private readonly explosions: Slot<THREE.Mesh>[] = []
  private readonly rings: Slot<THREE.Mesh>[] = []
  private readonly sparks: Slot<THREE.Points>[] = []
  private readonly slashes: Slot<THREE.Mesh>[] = []
  private readonly pickupPads: PickupPad[] = []
  private pickupGroup: THREE.Group | null = null
  /** Identity of the defs array the pads were built from, so syncPickups can
   * rebuild on a map change and do nothing on every other frame. */
  private pickupDefs: PickupDefs | null = null
  private readonly projectileMeshes = new Map<number, THREE.Object3D>()
  private readonly projectileKits = new Map<SnapProjectile['kind'], ProjectileKit>()
  private readonly deathFade: THREE.Mesh
  /** Reused across every syncProjectiles() call -- see UP_AXIS above. */
  private readonly scratchDir = new THREE.Vector3()
  private time = 0
  private tracerCursor = 0
  private muzzleCursor = 0
  private explosionCursor = 0
  private ringCursor = 0
  private sparkCursor = 0
  private slashCursor = 0

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene
    this.camera = camera
    for (let i = 0; i < TRACER_POOL; i++) this.tracers.push(this.makeTracerSlot())
    for (let i = 0; i < MUZZLE_POOL; i++) this.muzzles.push(this.makeMuzzleSlot())
    for (let i = 0; i < EXPLOSION_POOL; i++) this.explosions.push(this.makeExplosionSlot())
    for (let i = 0; i < RING_POOL; i++) this.rings.push(this.makeRingSlot())
    for (let i = 0; i < SPARK_POOL; i++) this.sparks.push(this.makeSparkSlot())
    for (let i = 0; i < SLASH_POOL; i++) this.slashes.push(this.makeSlashSlot())

    const fadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    })
    this.deathFade = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fadeMat)
    this.deathFade.position.set(0, 0, -0.15)
    this.deathFade.renderOrder = 999
    camera.add(this.deathFade)
  }

  // ---- pool construction --------------------------------------------------

  private makeTracerSlot(): Slot<THREE.Mesh> {
    const geom = new THREE.CylinderGeometry(TRACER_RADIUS, TRACER_RADIUS * 0.35, 1, 6, 1, true)
    const mat = new THREE.MeshBasicMaterial({
      map: this.streakTexture,
      color: TRACER_COLOR,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
    const mesh = new THREE.Mesh(geom, mat)
    mesh.visible = false
    mesh.frustumCulled = false
    mesh.renderOrder = 6
    this.scene.add(mesh)
    return { obj: mesh, active: false, life: 0, maxLife: TRACER_LIFE }
  }

  private makeMuzzleSlot(): Slot<THREE.Sprite> {
    const mat = new THREE.SpriteMaterial({
      map: this.flareTexture,
      color: MUZZLE_COLOR,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
    const sprite = new THREE.Sprite(mat)
    sprite.scale.set(0.55, 0.55, 1)
    sprite.visible = false
    sprite.renderOrder = 7
    this.scene.add(sprite)
    return { obj: sprite, active: false, life: 0, maxLife: MUZZLE_LIFE }
  }

  private makeExplosionSlot(): Slot<THREE.Mesh> {
    const mat = new THREE.MeshBasicMaterial({
      color: EXPLOSION_COLOR,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), mat)
    mesh.visible = false
    mesh.scale.setScalar(0.01)
    mesh.renderOrder = 7
    this.scene.add(mesh)
    return { obj: mesh, active: false, life: 0, maxLife: EXPLOSION_LIFE }
  }

  private makeRingSlot(): Slot<THREE.Mesh> {
    const mat = new THREE.MeshBasicMaterial({
      color: SHOCKWAVE_COLOR,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.72, 1, 28), mat)
    mesh.rotation.x = -Math.PI / 2
    mesh.visible = false
    mesh.renderOrder = 7
    this.scene.add(mesh)
    return { obj: mesh, active: false, life: 0, maxLife: RING_LIFE }
  }

  private makeSparkSlot(): Slot<THREE.Points> {
    const positions = new Float32Array(SPARK_POINTS * 3)
    for (let i = 0; i < SPARK_POINTS; i++) {
      const dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
        .normalize()
        .multiplyScalar(SPARK_BURST_RADIUS)
      positions[i * 3] = dir.x
      positions[i * 3 + 1] = dir.y
      positions[i * 3 + 2] = dir.z
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      map: this.dotTexture,
      color: SHIELD_SPARK_COLOR,
      size: 0.16,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
    })
    const points = new THREE.Points(geom, mat)
    points.visible = false
    points.scale.setScalar(0.1)
    points.renderOrder = 7
    this.scene.add(points)
    return { obj: points, active: false, life: 0, maxLife: SPARK_LIFE }
  }

  /** A ring segment, not a full ring: the open end is what makes it read as a
   * swipe with a start and a finish rather than a halo. thetaStart tilts it
   * so the arc runs low-left to high-right across the swing. */
  private makeSlashSlot(): Slot<THREE.Mesh> {
    const geom = new THREE.RingGeometry(0.3, 0.52, 20, 1, -Math.PI * 0.16, Math.PI * 0.78)
    const mat = new THREE.MeshBasicMaterial({
      color: SLASH_POWER_COLOR,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
    const mesh = new THREE.Mesh(geom, mat)
    mesh.visible = false
    mesh.frustumCulled = false
    mesh.renderOrder = 7
    this.scene.add(mesh)
    return { obj: mesh, active: false, life: 0, maxLife: SLASH_LIFE }
  }

  // ---- spawn ----------------------------------------------------------------

  spawnTracer(from: Vec3, yaw: number, pitch: number): void {
    const slot = this.tracers[this.tracerCursor]
    this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length
    const dir = viewDir(yaw, pitch)
    this.scratchDir.set(dir.x, dir.y, dir.z)
    const half = TRACER_LENGTH / 2
    slot.obj.position.set(from.x + dir.x * half, from.y + dir.y * half, from.z + dir.z * half)
    slot.obj.quaternion.setFromUnitVectors(UP_AXIS, this.scratchDir)
    slot.obj.scale.set(1, TRACER_LENGTH, 1)
    slot.obj.visible = true
    slot.active = true
    slot.life = 0
    ;(slot.obj.material as THREE.MeshBasicMaterial).opacity = 0.95
  }

  spawnMuzzleFlash(pos: Vec3): void {
    const slot = this.muzzles[this.muzzleCursor]
    this.muzzleCursor = (this.muzzleCursor + 1) % this.muzzles.length
    slot.obj.position.set(pos.x, pos.y, pos.z)
    slot.obj.material.rotation = this.time * 3
    slot.obj.visible = true
    slot.active = true
    slot.life = 0
    slot.obj.material.opacity = 1
  }

  spawnExplosion(pos: Vec3): void {
    const slot = this.explosions[this.explosionCursor]
    this.explosionCursor = (this.explosionCursor + 1) % this.explosions.length
    slot.obj.position.set(pos.x, pos.y, pos.z)
    slot.obj.scale.setScalar(0.01)
    slot.obj.visible = true
    slot.active = true
    slot.life = 0
    ;(slot.obj.material as THREE.MeshBasicMaterial).opacity = 0.95
    this.spawnRing(pos, SHOCKWAVE_COLOR, 5.5)
    this.spawnSparks(pos, EXPLOSION_COLOR, 2.6)
  }

  spawnRing(pos: Vec3, color: number, endScale: number): void {
    const slot = this.rings[this.ringCursor]
    this.ringCursor = (this.ringCursor + 1) % this.rings.length
    slot.obj.position.set(pos.x, pos.y, pos.z)
    slot.obj.scale.setScalar(0.25)
    slot.obj.userData.endScale = endScale
    slot.obj.visible = true
    slot.active = true
    slot.life = 0
    const mat = slot.obj.material as THREE.MeshBasicMaterial
    mat.color.setHex(color)
    mat.opacity = 0.9
  }

  spawnSparks(pos: Vec3, color: number, endScale = 1): void {
    const slot = this.sparks[this.sparkCursor]
    this.sparkCursor = (this.sparkCursor + 1) % this.sparks.length
    slot.obj.position.set(pos.x, pos.y, pos.z)
    slot.obj.scale.setScalar(0.1)
    slot.obj.userData.endScale = endScale
    slot.obj.visible = true
    slot.active = true
    slot.life = 0
    const mat = slot.obj.material as THREE.PointsMaterial
    mat.color.setHex(color)
    mat.opacity = 1
  }

  /**
   * The arc a melee swing carves in front of the swinger: a short-lived
   * additive ribbon at eye height, planted along the facing so it sweeps
   * exactly the volume the sim's melee cone covers. `scale` separates a
   * power-weapon lunge from a bare bash.
   */
  spawnSlash(eye: Vec3, yaw: number, pitch: number, color: number, scale: number): void {
    const slot = this.slashes[this.slashCursor]
    this.slashCursor = (this.slashCursor + 1) % this.slashes.length
    const dir = viewDir(yaw, pitch)
    slot.obj.position.set(
      eye.x + dir.x * SLASH_DIST,
      eye.y + dir.y * SLASH_DIST,
      eye.z + dir.z * SLASH_DIST
    )
    this.scratchDir.set(dir.x, dir.y, dir.z)
    slot.obj.quaternion.setFromUnitVectors(FORWARD_AXIS, this.scratchDir)
    slot.obj.scale.setScalar(scale * 0.6)
    slot.obj.userData.endScale = scale
    slot.obj.visible = true
    slot.active = true
    slot.life = 0
    const mat = slot.obj.material as THREE.MeshBasicMaterial
    mat.color.setHex(color)
    mat.opacity = 0.95
  }

  spawnShieldSpark(pos: Vec3): void {
    this.spawnSparks(pos, SHIELD_SPARK_COLOR, 1)
  }

  /**
   * Small per-bullet flare, distinct from spawnShieldSpark's full break
   * burst: smaller (0.6 endScale) so a sustained stream reads as texture
   * rather than a strobe, and red once the shield is gone. That colour flip
   * is the whole point -- it is how a player learns the shield/health
   * boundary without a number, which is what makes shield-gated headshots
   * legible instead of feeling like a broken multiplier.
   */
  spawnHitSpark(pos: Vec3, intoHealth: boolean): void {
    this.spawnSparks(pos, intoHealth ? HEALTH_SPARK_COLOR : SHIELD_SPARK_COLOR, 0.6)
  }

  /** Drives tracers + muzzle flashes off 'shot' events, arc slashes off
   * melee, explosions off 'explosion' events, and a spark/ring burst off
   * 'kill'. Shield-break sparks aren't driven from here -- the protocol has
   * no shield_break SimEvent, so game.ts diffs shield values frame-to-frame
   * and calls spawnShieldSpark() directly. */
  handleEvents(events: SimEvent[], eyeOf: (id: string) => { pos: Vec3; yaw: number; pitch: number } | undefined): void {
    for (const ev of events) {
      if (ev.type === 'shot') {
        const shooter = eyeOf(ev.playerId)
        if (!shooter) continue
        if (WEAPONS[ev.weapon].kind === 'power_melee') {
          // A power-melee swing emits BOTH a 'melee_swing' and this 'shot'
          // (sim.ts pushes the shot so the client still gets its fire
          // feedback). A 20m tracer and a muzzle flash off a sword read as a
          // bug, so it draws an arc instead -- and it draws it from HERE, not
          // from the paired melee_swing, so one swing is one slash.
          this.spawnSlash(shooter.pos, shooter.yaw, shooter.pitch, SLASH_POWER_COLOR, 1)
        } else {
          this.spawnTracer(shooter.pos, shooter.yaw, shooter.pitch)
          this.spawnMuzzleFlash(shooter.pos)
        }
      } else if (ev.type === 'melee_swing') {
        // weapon !== null is the power-melee case already slashed above.
        // Only the unarmed bash needs one from here: smaller and white,
        // because it is the weakest attack in the game.
        if (ev.weapon !== null) continue
        const swinger = eyeOf(ev.playerId)
        if (swinger) this.spawnSlash(swinger.pos, swinger.yaw, swinger.pitch, SLASH_BASH_COLOR, 0.62)
      } else if (ev.type === 'explosion') {
        this.spawnExplosion(ev.pos)
      } else if (ev.type === 'kill') {
        const victim = eyeOf(ev.victimId)
        if (victim) {
          this.spawnSparks(victim.pos, DEATH_COLOR, 2.2)
          this.spawnRing({ x: victim.pos.x, y: victim.pos.y - 1.4, z: victim.pos.z }, DEATH_COLOR, 3.2)
        }
      }
    }
  }

  // ---- projectiles ------------------------------------------------------------

  syncProjectiles(list: SnapProjectile[]): void {
    const seen = new Set<number>()
    for (const pr of list) {
      seen.add(pr.id)
      let mesh = this.projectileMeshes.get(pr.id)
      if (!mesh) {
        mesh = this.makeProjectileMesh(pr.kind)
        this.projectileMeshes.set(pr.id, mesh)
        this.scene.add(mesh)
      }
      mesh.position.set(pr.pos.x, pr.pos.y, pr.pos.z)
      const speed = Math.hypot(pr.vel.x, pr.vel.y, pr.vel.z)
      if (speed > 0.01) {
        this.scratchDir.set(pr.vel.x, pr.vel.y, pr.vel.z).normalize()
        mesh.quaternion.setFromUnitVectors(UP_AXIS, this.scratchDir)
      }
    }
    for (const [id, mesh] of this.projectileMeshes) {
      if (seen.has(id)) continue
      this.scene.remove(mesh)
      this.projectileMeshes.delete(id)
    }
  }

  /** Meshes reference one cached geometry/material pair per projectile kind
   * -- despawning a projectile only detaches it from the scene, so a
   * long-range firefight never disposes GPU resources mid-match nor
   * reallocates them for the next shot. */
  private makeProjectileMesh(kind: SnapProjectile['kind']): THREE.Object3D {
    let kit = this.projectileKits.get(kind)
    if (!kit) {
      kit = this.makeProjectileKit(kind)
      this.projectileKits.set(kind, kit)
    }
    const group = new THREE.Group()
    group.add(new THREE.Mesh(kit.core, kit.coreMat))
    group.add(new THREE.Mesh(kit.glow, kit.glowMat))
    return group
  }

  private makeProjectileKit(kind: SnapProjectile['kind']): ProjectileKit {
    const spec = PROJECTILE_SPEC[kind]
    const core =
      spec.shape === 'dart'
        ? new THREE.ConeGeometry(spec.size * 0.5, spec.size * 3, 8)
        : spec.shape === 'rod'
          ? new THREE.CylinderGeometry(spec.size * 0.55, spec.size * 0.4, spec.size * 4, 8)
          : new THREE.IcosahedronGeometry(spec.size, 0)
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x0d1119,
      emissive: spec.color,
      emissiveIntensity: 1.8,
      roughness: 0.4,
    })
    // Halo-style thin readable projectiles: the glow halo used to be 2.4x
    // the core size at 0.3 opacity, which additively bloomed into a fat
    // blob that swallowed the actual bullet shape. Trimmed to a tight rim.
    const glow = new THREE.SphereGeometry(spec.size * 1.4, 10, 8)
    const glowMat = new THREE.MeshBasicMaterial({
      color: spec.color,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
    return { core, coreMat, glow, glowMat }
  }

  // ---- power-weapon pickup pads -----------------------------------------------

  /**
   * Draws one pad per map power-pickup: a glowing floor ring at the real
   * PICKUP_RADIUS, and a hovering hologram of the weapon waiting on it. `up`
   * is the snapshot's per-pad availability -- a collected pad loses its
   * hologram and dims to a marker until it respawns, which is the only cue a
   * player gets that the rocket is already taken.
   *
   * Called every frame. The pads themselves are built once, keyed on the
   * identity of the map's own defs array, so a steady map is two comparisons
   * per frame and the visibility work only runs on an actual flip.
   */
  syncPickups(defs: PickupDefs, up?: boolean[]): void {
    // The caller passes `map.powerPickups ?? []`, so a padless map hands us a
    // FRESH empty array every frame -- rebuilding on identity alone would
    // thrash. Nothing to build and nothing built means nothing to do.
    if (defs !== this.pickupDefs && (defs.length > 0 || this.pickupPads.length > 0)) {
      this.buildPickups(defs)
    }
    for (let i = 0; i < this.pickupPads.length; i++) {
      const pad = this.pickupPads[i]
      const isUp = up?.[i] ?? true
      if (isUp === pad.up) continue
      pad.up = isUp
      if (pad.holo) pad.holo.visible = isUp
      pad.ringMat.opacity = isUp ? PAD_RING_OPACITY : PAD_RING_DIM
      // A respawn is worth looking up for: one pooled shockwave in the
      // weapon's own colour, off the ring pool that already exists.
      if (isUp) this.spawnRing(pad.ring.position, pad.color, 2.4)
    }
  }

  private buildPickups(defs: PickupDefs): void {
    this.disposePickups()
    this.pickupDefs = defs
    if (defs.length === 0) return

    const group = new THREE.Group()
    group.name = 'pickupPads'
    for (const def of defs) {
      const color = accentColor(def.weapon)
      const ringMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: PAD_RING_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      })
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(PICKUP_RADIUS * 0.62, PICKUP_RADIUS * 0.92, 26),
        ringMat
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(def.pos.x, def.pos.y + 0.05, def.pos.z)
      ring.renderOrder = 5
      group.add(ring)

      const holoMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: PAD_HOLO_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
      const holo = buildWeaponHolo(def.weapon, holoMat)
      if (holo) {
        holo.scale.setScalar(PAD_HOLO_SCALE)
        holo.position.set(def.pos.x, def.pos.y + PAD_HOLO_HEIGHT, def.pos.z)
        holo.renderOrder = 6
        group.add(holo)
      } else {
        holoMat.dispose()
      }

      this.pickupPads.push({
        ring,
        ringMat,
        holo,
        baseY: def.pos.y + PAD_HOLO_HEIGHT,
        color,
        up: true,
      })
    }
    this.scene.add(group)
    this.pickupGroup = group
  }

  /** Spin + bob, phase-offset by world X the same way tickMapPulse offsets
   * its bobbing props, so two pads on one map never breathe in lockstep. */
  private advancePickups(): void {
    for (const pad of this.pickupPads) {
      if (!pad.holo) continue
      pad.holo.rotation.y = this.time * PAD_HOLO_SPIN
      pad.holo.position.y =
        pad.baseY + Math.sin(this.time * PAD_HOLO_BOB_RATE + pad.ring.position.x) * PAD_HOLO_BOB
    }
  }

  private disposePickups(): void {
    if (this.pickupGroup) {
      this.scene.remove(this.pickupGroup)
      disposeObject3D(this.pickupGroup)
    }
    this.pickupGroup = null
    this.pickupDefs = null
    this.pickupPads.length = 0
  }

  // ---- map animation + death fade ---------------------------------------------

  /**
   * Animates every part mapMesh.ts tagged: `pulse` breathes an emissive
   * strip, `shimmer` breathes a light pillar/halo, `padPulse` runs the
   * jump-pad shockwave, `spin`/`bob` drift the rift crystals and beacon
   * cores. mapMesh.ts decides which parts move, this decides how.
   */
  tickMapPulse(mapGroup: THREE.Group, dt: number): void {
    const t = this.time
    mapGroup.traverse((obj) => {
      const data = obj.userData
      if (data.pulse && (obj as THREE.Mesh).material) {
        const mat = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial
        const base = (data.baseEmissive as number) ?? 1
        mat.emissiveIntensity = base * (0.72 + 0.28 * Math.sin(t * 3.2))
      }
      if (data.shimmer) {
        const phase = t * 1.6 + (data.shimmer as number)
        const s = 0.92 + 0.12 * Math.sin(phase)
        obj.scale.set(s, 1, s)
        obj.rotation.y += dt * 0.35
      }
      if (data.padPulse) {
        const cycle = (t * 0.75) % 1
        const s = (data.padPulse as number) * (0.4 + cycle * 1.6)
        obj.scale.set(s, s, 1)
        const mat = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial
        mat.opacity = 0.55 * (1 - cycle)
      }
      // `cloth` is a flag banner: the ripple lives in its vertex shader, so
      // all this has to do is advance that shader's clock (see flag.ts).
      // onBeforeCompile runs once, hence the stashed shader rather than a
      // material property.
      if (data.cloth) {
        const mat = (obj as THREE.Mesh).material as THREE.Material
        const shader = mat.userData.shader as { uniforms: { uTime: { value: number } } } | undefined
        if (shader) shader.uniforms.uTime.value = t
      }
      if (data.spin) obj.rotation.y += dt * (data.spin as number)
      if (data.bob !== undefined) {
        obj.position.y = (data.bobBase as number) + Math.sin(t * 0.9 + obj.position.x) * (data.bob as number)
      }
    })
  }

  setDeathFade(active: boolean, dt: number): void {
    const mat = this.deathFade.material as THREE.MeshBasicMaterial
    const target = active ? 0.85 : 0
    mat.opacity += (target - mat.opacity) * Math.min(1, dt * 6)
  }

  // ---- per-frame update -------------------------------------------------------

  update(dt: number): void {
    this.time += dt
    for (const slot of this.tracers) this.advanceTracer(slot, dt)
    for (const slot of this.muzzles) this.advanceMuzzle(slot, dt)
    for (const slot of this.sparks) this.advanceSpark(slot, dt)
    for (const slot of this.rings) this.advanceRing(slot, dt)
    for (const slot of this.explosions) this.advanceExplosion(slot, dt)
    for (const slot of this.slashes) this.advanceSlash(slot, dt)
    if (this.pickupPads.length > 0) this.advancePickups()
  }

  private advanceSlash(slot: Slot<THREE.Mesh>, dt: number): void {
    if (!slot.active) return
    slot.life += dt
    const t = Math.min(1, slot.life / slot.maxLife)
    const end = (slot.obj.userData.endScale as number) ?? 1
    // Opens outward as it fades -- a swipe that grows reads as a swing
    // following through, where a shrinking one reads as a hit landing.
    slot.obj.scale.setScalar(end * (0.6 + t * 0.75))
    ;(slot.obj.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t) * (1 - t)
    if (slot.life >= slot.maxLife) {
      slot.active = false
      slot.obj.visible = false
    }
  }

  private advanceTracer(slot: Slot<THREE.Mesh>, dt: number): void {
    if (!slot.active) return
    slot.life += dt
    const frac = Math.max(0, 1 - slot.life / slot.maxLife)
    const mat = slot.obj.material as THREE.MeshBasicMaterial
    mat.opacity = frac * 0.95
    slot.obj.scale.x = 0.35 + frac * 0.65
    slot.obj.scale.z = slot.obj.scale.x
    if (slot.life >= slot.maxLife) {
      slot.active = false
      slot.obj.visible = false
    }
  }

  private advanceMuzzle(slot: Slot<THREE.Sprite>, dt: number): void {
    if (!slot.active) return
    slot.life += dt
    const frac = Math.max(0, 1 - slot.life / slot.maxLife)
    slot.obj.material.opacity = frac
    const s = 0.3 + frac * 0.45
    slot.obj.scale.set(s, s, 1)
    if (slot.life >= slot.maxLife) {
      slot.active = false
      slot.obj.visible = false
    }
  }

  private advanceSpark(slot: Slot<THREE.Points>, dt: number): void {
    if (!slot.active) return
    slot.life += dt
    const t = Math.min(1, slot.life / slot.maxLife)
    const end = (slot.obj.userData.endScale as number) ?? 1
    slot.obj.scale.setScalar(0.1 + t * end)
    ;(slot.obj.material as THREE.PointsMaterial).opacity = (1 - t) * (1 - t)
    if (slot.life >= slot.maxLife) {
      slot.active = false
      slot.obj.visible = false
    }
  }

  private advanceRing(slot: Slot<THREE.Mesh>, dt: number): void {
    if (!slot.active) return
    slot.life += dt
    const t = Math.min(1, slot.life / slot.maxLife)
    const end = (slot.obj.userData.endScale as number) ?? 3
    const s = 0.25 + t * end
    slot.obj.scale.set(s, s, 1)
    ;(slot.obj.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t) * (1 - t)
    if (slot.life >= slot.maxLife) {
      slot.active = false
      slot.obj.visible = false
    }
  }

  private advanceExplosion(slot: Slot<THREE.Mesh>, dt: number): void {
    if (!slot.active) return
    slot.life += dt
    const t = Math.min(1, slot.life / slot.maxLife)
    slot.obj.scale.setScalar(0.1 + t * 2.6)
    slot.obj.rotation.y += dt * 2
    ;(slot.obj.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t)
    if (slot.life >= slot.maxLife) {
      slot.active = false
      slot.obj.visible = false
    }
  }

  // ---- teardown -----------------------------------------------------------------

  /** Releases every GPU resource this system owns: all six pools, the pickup
   * pads, every live projectile mesh plus the shared per-kind kits behind
   * them, the three canvas textures, and the death-fade plane (removed from
   * the camera it was parented to in the constructor). Called once from
   * game.teardown() when a match ends -- without it, every rematch would
   * leak this match's effect pools, projectile geometries and textures. */
  dispose(): void {
    this.disposePickups()
    const pools: Slot<THREE.Object3D>[][] = [
      this.tracers,
      this.muzzles,
      this.explosions,
      this.rings,
      this.sparks,
      this.slashes,
    ]
    for (const pool of pools) {
      for (const slot of pool) {
        this.scene.remove(slot.obj)
        disposeObject3D(slot.obj)
      }
    }
    for (const mesh of this.projectileMeshes.values()) this.scene.remove(mesh)
    this.projectileMeshes.clear()
    for (const kit of this.projectileKits.values()) {
      kit.core.dispose()
      kit.coreMat.dispose()
      kit.glow.dispose()
      kit.glowMat.dispose()
    }
    this.projectileKits.clear()

    this.camera.remove(this.deathFade)
    disposeObject3D(this.deathFade)

    // Shared across every pooled material's `map` above (already disposed N
    // times via disposeObject3D -- Texture.dispose() just dispatches a
    // 'dispose' event, safe to call redundantly), disposed once more
    // explicitly here so this system's own allocations are provably
    // released even if the pools were ever empty.
    this.dotTexture.dispose()
    this.flareTexture.dispose()
    this.streakTexture.dispose()
  }
}

const PROJECTILE_SPEC: Record<SnapProjectile['kind'], { shape: 'dart' | 'rod' | 'orb'; size: number; color: number }> = {
  boomtube: { shape: 'rod', size: 0.09, color: 0xff5533 },
  swarm_dart: { shape: 'dart', size: 0.07, color: 0x55ffaa },
  cinderlob: { shape: 'orb', size: 0.13, color: 0xff9944 },
  frag: { shape: 'orb', size: 0.12, color: 0x9fd08a },
  mag: { shape: 'orb', size: 0.14, color: 0xffaa33 },
}
