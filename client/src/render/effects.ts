import * as THREE from 'three'
import type { SimEvent, SnapProjectile, Vec3 } from '@riftlane/shared'
import { disposeObject3D } from './dispose'
import { makeFlareTexture, makeSoftDotTexture, makeStreakTexture } from './materials'

const TRACER_LIFE = 0.11
const MUZZLE_LIFE = 0.07
const EXPLOSION_LIFE = 0.34
const RING_LIFE = 0.42
const SPARK_LIFE = 0.3
const TRACER_LENGTH = 30
const TRACER_RADIUS = 0.045
const TRACER_POOL = 24
const MUZZLE_POOL = 12
const EXPLOSION_POOL = 8
const RING_POOL = 10
const SPARK_POOL = 12
const SPARK_POINTS = 22
const SPARK_BURST_RADIUS = 0.5

const TRACER_COLOR = 0xfff0b0
const MUZZLE_COLOR = 0xffe08a
const EXPLOSION_COLOR = 0xff8a3c
const SHOCKWAVE_COLOR = 0xffc27a
const SHIELD_SPARK_COLOR = 0x9fe6ff
const DEATH_COLOR = 0xff5f7a

// syncProjectiles orients a mesh toward its velocity every frame for every
// live projectile -- a shared, never-mutated axis constant plus one reused
// scratch vector (below, on the class) avoids two `new THREE.Vector3()`
// allocations per projectile per frame.
const UP_AXIS = new THREE.Vector3(0, 1, 0)

interface Slot<T extends THREE.Object3D> {
  obj: T
  active: boolean
  life: number
  maxLife: number
}

interface ProjectileKit {
  core: THREE.BufferGeometry
  coreMat: THREE.Material
  glow: THREE.BufferGeometry
  glowMat: THREE.Material
}

/** Same forward-vector convention as sim.ts's private viewDir (yaw=0 faces
 * +z) -- duplicated here because the protocol never sends hit points, only
 * shooter yaw/pitch, so tracers are drawn as a fixed-length ray rather than
 * a real raycast against the world (that logic already lives server-side). */
function viewDir(yaw: number, pitch: number): Vec3 {
  return {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  }
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

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene
    this.camera = camera
    for (let i = 0; i < TRACER_POOL; i++) this.tracers.push(this.makeTracerSlot())
    for (let i = 0; i < MUZZLE_POOL; i++) this.muzzles.push(this.makeMuzzleSlot())
    for (let i = 0; i < EXPLOSION_POOL; i++) this.explosions.push(this.makeExplosionSlot())
    for (let i = 0; i < RING_POOL; i++) this.rings.push(this.makeRingSlot())
    for (let i = 0; i < SPARK_POOL; i++) this.sparks.push(this.makeSparkSlot())

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

  spawnShieldSpark(pos: Vec3): void {
    this.spawnSparks(pos, SHIELD_SPARK_COLOR, 1)
  }

  /** Drives tracers + muzzle flashes off 'shot' events, explosions off
   * 'explosion' events, and a spark/ring burst off 'kill'. Shield-break
   * sparks aren't driven from here -- the protocol has no shield_break
   * SimEvent, so game.ts diffs shield values frame-to-frame and calls
   * spawnShieldSpark() directly. */
  handleEvents(events: SimEvent[], eyeOf: (id: string) => { pos: Vec3; yaw: number; pitch: number } | undefined): void {
    for (const ev of events) {
      if (ev.type === 'shot') {
        const shooter = eyeOf(ev.playerId)
        if (shooter) {
          this.spawnTracer(shooter.pos, shooter.yaw, shooter.pitch)
          this.spawnMuzzleFlash(shooter.pos)
        }
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
    const glow = new THREE.SphereGeometry(spec.size * 2.4, 10, 8)
    const glowMat = new THREE.MeshBasicMaterial({
      color: spec.color,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
    return { core, coreMat, glow, glowMat }
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

  /** Releases every GPU resource this system owns: all five pools, every
   * live projectile mesh plus the shared per-kind kits behind them, the
   * three canvas textures, and the death-fade plane (removed from the camera
   * it was parented to in the constructor). Called once from
   * game.teardown() when a match ends -- without it, every rematch would
   * leak this match's effect pools, projectile geometries and textures. */
  dispose(): void {
    const pools: Slot<THREE.Object3D>[][] = [this.tracers, this.muzzles, this.explosions, this.rings, this.sparks]
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
  ion_charge: { shape: 'orb', size: 0.13, color: 0x66ccff },
  frag: { shape: 'orb', size: 0.12, color: 0x9fd08a },
  mag: { shape: 'orb', size: 0.14, color: 0xffaa33 },
}
