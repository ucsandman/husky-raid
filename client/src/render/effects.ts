import * as THREE from 'three'
import type { SimEvent, SnapProjectile, Vec3 } from '@riftlane/shared'
import { disposeObject3D } from './dispose'

const TRACER_LIFE = 0.08
const MUZZLE_LIFE = 0.06
const EXPLOSION_LIFE = 0.3
const SPARK_LIFE = 0.25
const TRACER_LENGTH = 30
const TRACER_POOL = 24
const MUZZLE_POOL = 12
const EXPLOSION_POOL = 8
const SPARK_POOL = 8
const SPARK_POINTS = 16
const SPARK_BURST_RADIUS = 0.5

const TRACER_COLOR = 0xfff2a8
const MUZZLE_COLOR = 0xffe9a0
const EXPLOSION_COLOR = 0xff7a33
const SPARK_COLOR = 0x9fe6ff

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

function softDotTexture(): THREE.Texture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
  }
  const tex = new THREE.CanvasTexture(canvas)
  return tex
}

/**
 * All transient VFX (tracers, muzzle flashes, explosions, shield sparks) +
 * pooled per-id projectile meshes + the death-fade overlay. Pools are
 * fixed-size arrays of pre-allocated Object3Ds, reused round-robin -- 60fps
 * on integrated graphics means never allocating/disposing geometry inside
 * the render loop for effects that fire dozens of times a match.
 */
export class EffectsSystem {
  private readonly scene: THREE.Scene
  private readonly camera: THREE.Camera
  private readonly dotTexture = softDotTexture()
  private readonly tracers: Slot<THREE.Line>[] = []
  private readonly muzzles: Slot<THREE.Sprite>[] = []
  private readonly explosions: Slot<THREE.Mesh>[] = []
  private readonly sparks: Slot<THREE.Points>[] = []
  private readonly projectileMeshes = new Map<number, THREE.Object3D>()
  private readonly deathFade: THREE.Mesh
  /** Reused across every syncProjectiles() call -- see UP_AXIS above. */
  private readonly scratchDir = new THREE.Vector3()
  private time = 0
  private tracerCursor = 0
  private muzzleCursor = 0
  private explosionCursor = 0
  private sparkCursor = 0

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene
    this.camera = camera
    for (let i = 0; i < TRACER_POOL; i++) this.tracers.push(this.makeTracerSlot())
    for (let i = 0; i < MUZZLE_POOL; i++) this.muzzles.push(this.makeMuzzleSlot())
    for (let i = 0; i < EXPLOSION_POOL; i++) this.explosions.push(this.makeExplosionSlot())
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

  private makeTracerSlot(): Slot<THREE.Line> {
    const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
    const mat = new THREE.LineBasicMaterial({ color: TRACER_COLOR, transparent: true, opacity: 0 })
    const line = new THREE.Line(geom, mat)
    line.visible = false
    line.frustumCulled = false
    this.scene.add(line)
    return { obj: line, active: false, life: 0, maxLife: TRACER_LIFE }
  }

  private makeMuzzleSlot(): Slot<THREE.Sprite> {
    const mat = new THREE.SpriteMaterial({
      map: this.dotTexture,
      color: MUZZLE_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    })
    const sprite = new THREE.Sprite(mat)
    sprite.scale.set(0.35, 0.35, 1)
    sprite.visible = false
    this.scene.add(sprite)
    return { obj: sprite, active: false, life: 0, maxLife: MUZZLE_LIFE }
  }

  private makeExplosionSlot(): Slot<THREE.Mesh> {
    const mat = new THREE.MeshBasicMaterial({ color: EXPLOSION_COLOR, transparent: true, opacity: 0 })
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), mat)
    mesh.visible = false
    mesh.scale.setScalar(0.01)
    this.scene.add(mesh)
    return { obj: mesh, active: false, life: 0, maxLife: EXPLOSION_LIFE }
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
      color: SPARK_COLOR,
      size: 0.12,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    })
    const points = new THREE.Points(geom, mat)
    points.visible = false
    points.scale.setScalar(0.1)
    this.scene.add(points)
    return { obj: points, active: false, life: 0, maxLife: SPARK_LIFE }
  }

  // ---- spawn ----------------------------------------------------------------

  spawnTracer(from: Vec3, yaw: number, pitch: number): void {
    const slot = this.tracers[this.tracerCursor]
    this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length
    const dir = viewDir(yaw, pitch)
    const to = { x: from.x + dir.x * TRACER_LENGTH, y: from.y + dir.y * TRACER_LENGTH, z: from.z + dir.z * TRACER_LENGTH }
    const pos = slot.obj.geometry.attributes.position as THREE.BufferAttribute
    pos.setXYZ(0, from.x, from.y, from.z)
    pos.setXYZ(1, to.x, to.y, to.z)
    pos.needsUpdate = true
    slot.obj.visible = true
    slot.active = true
    slot.life = 0
    ;(slot.obj.material as THREE.LineBasicMaterial).opacity = 0.9
  }

  spawnMuzzleFlash(pos: Vec3): void {
    const slot = this.muzzles[this.muzzleCursor]
    this.muzzleCursor = (this.muzzleCursor + 1) % this.muzzles.length
    slot.obj.position.set(pos.x, pos.y, pos.z)
    slot.obj.visible = true
    slot.active = true
    slot.life = 0
    ;(slot.obj.material as THREE.SpriteMaterial).opacity = 1
  }

  spawnExplosion(pos: Vec3): void {
    const slot = this.explosions[this.explosionCursor]
    this.explosionCursor = (this.explosionCursor + 1) % this.explosions.length
    slot.obj.position.set(pos.x, pos.y, pos.z)
    slot.obj.scale.setScalar(0.01)
    slot.obj.visible = true
    slot.active = true
    slot.life = 0
    ;(slot.obj.material as THREE.MeshBasicMaterial).opacity = 0.9
  }

  spawnShieldSpark(pos: Vec3): void {
    const slot = this.sparks[this.sparkCursor]
    this.sparkCursor = (this.sparkCursor + 1) % this.sparks.length
    slot.obj.position.set(pos.x, pos.y, pos.z)
    slot.obj.scale.setScalar(0.1)
    slot.obj.visible = true
    slot.active = true
    slot.life = 0
    ;(slot.obj.material as THREE.PointsMaterial).opacity = 1
  }

  /** Drives tracers + muzzle flashes off 'shot' events and explosions off
   * 'explosion' events. Shield-break sparks aren't driven from here -- the
   * protocol has no shield_break SimEvent, so game.ts diffs shield values
   * frame-to-frame and calls spawnShieldSpark() directly. */
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
      disposeObject3D(mesh)
      this.projectileMeshes.delete(id)
    }
  }

  private makeProjectileMesh(kind: SnapProjectile['kind']): THREE.Object3D {
    switch (kind) {
      case 'boomtube': {
        const group = new THREE.Group()
        const mat = new THREE.MeshLambertMaterial({ color: 0xff5533, emissive: 0xff5533, emissiveIntensity: 0.8 })
        group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.5, 8), mat))
        group.add(new THREE.PointLight(0xff5533, 2, 6))
        return group
      }
      case 'swarm_dart': {
        const mat = new THREE.MeshLambertMaterial({ color: 0x55ffaa, emissive: 0x55ffaa, emissiveIntensity: 0.6 })
        return new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.3, 8), mat)
      }
      case 'ion_charge': {
        const mat = new THREE.MeshLambertMaterial({ color: 0x66ccff, emissive: 0x66ccff, emissiveIntensity: 0.9 })
        return new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), mat)
      }
      case 'frag': {
        const mat = new THREE.MeshLambertMaterial({ color: 0x557755 })
        return new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), mat)
      }
      case 'mag': {
        const mat = new THREE.MeshLambertMaterial({ color: 0xffaa33, emissive: 0xffaa33, emissiveIntensity: 0.4 })
        return new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), mat)
      }
    }
  }

  // ---- map pulse + death fade ------------------------------------------------

  /** Pulses launch pads / teleporter rings tagged `userData.pulse` by
   * mapMesh.ts -- keeps the "which meshes glow" decision in mapMesh.ts and
   * the "how they animate" decision here. */
  tickMapPulse(mapGroup: THREE.Group): void {
    mapGroup.traverse((obj) => {
      if (!obj.userData.pulse || !(obj instanceof THREE.Mesh)) return
      const mat = obj.material as THREE.MeshLambertMaterial
      const base = obj.userData.baseEmissive as number
      mat.emissiveIntensity = base * (0.6 + 0.4 * Math.sin(this.time * 4))
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
    for (const slot of this.tracers) this.advanceFade(slot, dt)
    for (const slot of this.muzzles) this.advanceFade(slot, dt)
    for (const slot of this.sparks) this.advanceSpark(slot, dt)
    for (const slot of this.explosions) this.advanceExplosion(slot, dt)
  }

  private advanceFade(slot: Slot<THREE.Line | THREE.Sprite>, dt: number): void {
    if (!slot.active) return
    slot.life += dt
    const frac = Math.max(0, 1 - slot.life / slot.maxLife)
    const mat = slot.obj.material as THREE.LineBasicMaterial | THREE.SpriteMaterial
    mat.opacity = frac
    if (slot.life >= slot.maxLife) {
      slot.active = false
      slot.obj.visible = false
    }
  }

  private advanceSpark(slot: Slot<THREE.Points>, dt: number): void {
    if (!slot.active) return
    slot.life += dt
    const t = Math.min(1, slot.life / slot.maxLife)
    slot.obj.scale.setScalar(0.1 + t * 0.9)
    ;(slot.obj.material as THREE.PointsMaterial).opacity = 1 - t
    if (slot.life >= slot.maxLife) {
      slot.active = false
      slot.obj.visible = false
    }
  }

  private advanceExplosion(slot: Slot<THREE.Mesh>, dt: number): void {
    if (!slot.active) return
    slot.life += dt
    const t = Math.min(1, slot.life / slot.maxLife)
    slot.obj.scale.setScalar(0.1 + t * 2.4)
    ;(slot.obj.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t)
    if (slot.life >= slot.maxLife) {
      slot.active = false
      slot.obj.visible = false
    }
  }

  // ---- teardown -----------------------------------------------------------------

  /** Releases every GPU resource this system owns: all four pools, every
   * live projectile mesh, the shared dot texture, and the death-fade plane
   * (removed from the camera it was parented to in the constructor).
   * Called once from game.teardown() when a match ends -- without it,
   * every rematch would leak this match's tracer/muzzle/explosion/spark
   * pool + projectile geometries and textures. */
  dispose(): void {
    for (const slot of this.tracers) {
      this.scene.remove(slot.obj)
      disposeObject3D(slot.obj)
    }
    for (const slot of this.muzzles) {
      this.scene.remove(slot.obj)
      disposeObject3D(slot.obj)
    }
    for (const slot of this.explosions) {
      this.scene.remove(slot.obj)
      disposeObject3D(slot.obj)
    }
    for (const slot of this.sparks) {
      this.scene.remove(slot.obj)
      disposeObject3D(slot.obj)
    }
    for (const mesh of this.projectileMeshes.values()) {
      this.scene.remove(mesh)
      disposeObject3D(mesh)
    }
    this.projectileMeshes.clear()

    this.camera.remove(this.deathFade)
    disposeObject3D(this.deathFade)

    // Shared across every muzzle/spark material's `map` above (already
    // disposed N times via disposeObject3D -- Texture.dispose() just
    // dispatches a 'dispose' event, safe to call redundantly), disposed
    // once more explicitly here so this system's own allocation is
    // provably released even if the pools were ever empty.
    this.dotTexture.dispose()
  }
}
