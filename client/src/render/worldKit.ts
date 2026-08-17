import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { AABB, Team, Vec3 } from '@riftlane/shared'
import { LAUNCH_COLOR, TEAM_GLOW, type MaterialLibrary } from './materials'

/** Unshared additive card. Pillars, halos and pad shockwaves animate their
 * own opacity, so they cannot use MaterialLibrary's cached additive roles --
 * one prop's fade would drive every other prop of the same colour. */
function freshAdditive(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  })
}

const UV_TILE = 3
const UP = new THREE.Vector3(0, 1, 0)

/** Deterministic layout noise -- the backdrop must be identical on every
 * client and across screenshot runs, so no Math.random anywhere in here. */
export function hash01(n: number): number {
  const s = Math.sin(n * 43.7581 + 9.271) * 39187.6431
  return s - Math.floor(s)
}

/**
 * Rescales a BoxGeometry's per-face UVs to world metres so one shared
 * panel/deck texture tiles at a constant density no matter how big the box
 * is. Relies on the default single-segment box layout: 6 faces in
 * +x,-x,+y,-y,+z,-z order, 4 vertices each.
 */
export function scaleBoxUVs(geom: THREE.BufferGeometry, sx: number, sy: number, sz: number): void {
  const uv = geom.attributes.uv as THREE.BufferAttribute
  const scales = [sz, sy, sz, sy, sx, sz, sx, sz, sx, sy, sx, sy]
  for (let f = 0; f < 6; f++) {
    const us = scales[f * 2]
    const vs = scales[f * 2 + 1]
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i
      uv.setXY(idx, (uv.getX(idx) * us) / UV_TILE, (uv.getY(idx) * vs) / UV_TILE)
    }
  }
  uv.needsUpdate = true
}

export function boxGeom(sx: number, sy: number, sz: number, cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const geom = new THREE.BoxGeometry(sx, sy, sz)
  scaleBoxUVs(geom, sx, sy, sz)
  geom.translate(cx, cy, cz)
  return geom
}

export function mergeMesh(
  geoms: THREE.BufferGeometry[],
  mat: THREE.Material,
  name: string
): THREE.Mesh | null {
  if (geoms.length === 0) return null
  const merged = mergeGeometries(geoms, false)
  for (const g of geoms) g.dispose()
  if (!merged) return null
  const mesh = new THREE.Mesh(merged, mat)
  mesh.name = name
  return mesh
}

export interface Bounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  topY: number
}

export function boundsOf(boxes: AABB[]): Bounds {
  const b: Bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, topY: -Infinity }
  for (const box of boxes) {
    b.minX = Math.min(b.minX, box.min.x)
    b.maxX = Math.max(b.maxX, box.max.x)
    b.minZ = Math.min(b.minZ, box.min.z)
    b.maxZ = Math.max(b.maxZ, box.max.z)
    b.topY = Math.max(b.topY, box.max.y)
  }
  return b
}

// ---- flag beacon ------------------------------------------------------------

/**
 * The flag stand: a raised drum with three claw arms, a pulsing rim and a
 * ground halo. The flag itself is NOT built here -- it has to leave the stand
 * when it is dropped or carried, so mapMesh.ts adds it as a sibling and
 * flag.ts positions it from the snapshot every frame.
 *
 * This used to be the arena's landmark in its own right (see the note inside
 * about the core and pillar that were removed); it is now the plinth the
 * landmark stands in. `rim`/`halo` are tagged for effects.tickMapPulse, which
 * owns the pulse and shimmer animation.
 */
export function makeFlagBeacon(lib: MaterialLibrary, pos: Vec3, team: Team): THREE.Group {
  const group = new THREE.Group()
  group.name = `beacon${team}`
  group.position.set(pos.x, pos.y, pos.z)
  const glow = TEAM_GLOW[team]

  const hullParts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(1.5, 1.75, 0.28, 12).translate(0, 0.14, 0),
    new THREE.CylinderGeometry(1.0, 1.25, 0.35, 12).translate(0, 0.45, 0),
  ]
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    const arm = new THREE.BoxGeometry(0.22, 1.5, 0.34)
    arm.translate(0, 0.9, -1.05)
    arm.rotateY(a)
    hullParts.push(arm)
    const foot = new THREE.BoxGeometry(0.4, 0.16, 0.5)
    foot.translate(0, 0.32, -1.35)
    foot.rotateY(a)
    hullParts.push(foot)
  }
  const hull = mergeMesh(hullParts, lib.hullDark, 'beaconHull')
  if (hull) {
    hull.castShadow = true
    hull.receiveShadow = true
    group.add(hull)
  }

  const trimParts: THREE.BufferGeometry[] = [
    new THREE.TorusGeometry(1.55, 0.06, 6, 20).rotateX(Math.PI / 2).translate(0, 0.3, 0),
    new THREE.TorusGeometry(1.05, 0.05, 6, 18).rotateX(Math.PI / 2).translate(0, 0.64, 0),
  ]
  const rim = mergeMesh(trimParts, lib.teamGlow(team), 'beaconRim')
  if (rim) {
    rim.userData.pulse = true
    rim.userData.baseEmissive = 1.0
    group.add(rim)
  }

  // The floating core and the 26m light pillar that used to live here are
  // gone. They existed because there was no actual flag to look at: the stand
  // had to BE the landmark. Now flag.ts plants a mast and a banner in this
  // drum, and the old pair fought it -- a spinning crystal hovered in front of
  // the cloth, and two concentric additive columns (the pillar plus the flag's
  // own locator shaft) washed the whole base area pale. The drum, claw arms,
  // pulsing rim and ground halo stay: this is the plinth, not the beacon.
  const halo = new THREE.Mesh(new THREE.RingGeometry(1.75, 2.1, 24), freshAdditive(glow, 0.16))
  halo.rotation.x = -Math.PI / 2
  halo.position.y = 0.06
  halo.userData.shimmer = 2
  halo.renderOrder = 3
  group.add(halo)

  return group
}

// ---- jump pad ---------------------------------------------------------------

export function makeJumpPad(lib: MaterialLibrary, pos: Vec3, radius: number): THREE.Group {
  const group = new THREE.Group()
  group.name = 'jumpPad'
  group.position.set(pos.x, pos.y, pos.z)

  const frameParts: THREE.BufferGeometry[] = [
    new THREE.TorusGeometry(radius * 1.05, radius * 0.16, 8, 20).rotateX(Math.PI / 2).translate(0, 0.14, 0),
  ]
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    const leg = new THREE.BoxGeometry(radius * 0.22, 0.3, radius * 0.5)
    leg.translate(0, 0.15, -radius * 1.05)
    leg.rotateY(a)
    frameParts.push(leg)
  }
  const frame = mergeMesh(frameParts, lib.hullDark, 'padFrame')
  if (frame) {
    frame.receiveShadow = true
    group.add(frame)
  }

  const core = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.86, radius * 0.86, 0.12, 20), lib.signal(LAUNCH_COLOR))
  core.position.y = 0.12
  core.userData.pulse = true
  core.userData.baseEmissive = 1.3
  group.add(core)

  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.25, radius * 0.85, 3.4, 12, 1, true),
    freshAdditive(LAUNCH_COLOR, 0.11)
  )
  column.position.y = 1.75
  column.userData.shimmer = 1
  column.renderOrder = 4
  group.add(column)

  const pulseRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 24), freshAdditive(LAUNCH_COLOR, 0.35))
  pulseRing.rotation.x = -Math.PI / 2
  pulseRing.position.y = 0.2
  pulseRing.userData.padPulse = radius
  pulseRing.renderOrder = 5
  group.add(pulseRing)

  return group
}

// ---- teleporter -------------------------------------------------------------

export function makeTeleportPad(lib: MaterialLibrary, pos: Vec3, radius: number, color: number): THREE.Group {
  const group = new THREE.Group()
  group.name = 'teleportPad'
  group.position.set(pos.x, pos.y, pos.z)

  const frameParts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    const post = new THREE.CylinderGeometry(0.11, 0.16, 2.6, 6)
    post.translate(0, 1.3, -radius)
    post.rotateY(a)
    frameParts.push(post)
  }
  frameParts.push(new THREE.TorusGeometry(radius, 0.12, 6, 18).rotateX(Math.PI / 2).translate(0, 2.55, 0))
  frameParts.push(new THREE.CylinderGeometry(radius * 1.1, radius * 1.25, 0.16, 16).translate(0, 0.08, 0))
  const frame = mergeMesh(frameParts, lib.hullDark, 'teleFrame')
  if (frame) {
    frame.castShadow = true
    frame.receiveShadow = true
    group.add(frame)
  }

  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.55, radius * 0.95, 22), lib.signal(color))
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.18
  ring.userData.pulse = true
  ring.userData.baseEmissive = 1.2
  group.add(ring)

  const column = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.75, radius * 0.75, 2.5, 12, 1, true), freshAdditive(color, 0.08))
  column.position.y = 1.3
  column.userData.shimmer = 1
  column.renderOrder = 4
  group.add(column)

  return group
}

// ---- base gate --------------------------------------------------------------

/** Arch straddling the outer edge of a base platform: two braced posts, a
 * header beam with a hazard notch, and a team light bar across the top. */
export function makeBaseGate(lib: MaterialLibrary, box: AABB, team: Team, mapCenterZ: number): THREE.Group {
  const group = new THREE.Group()
  group.name = `gate${team}`

  const sx = box.max.x - box.min.x
  const sz = box.max.z - box.min.z
  const spanX = sx >= sz
  const span = (spanX ? sx : sz) + 1.4
  const cx = (box.min.x + box.max.x) / 2
  const cz = (box.min.z + box.max.z) / 2
  const outward = spanX ? (cz < mapCenterZ ? box.min.z - 0.6 : box.max.z + 0.6) : cz
  const outwardX = spanX ? cx : cx < 0 ? box.min.x - 0.6 : box.max.x + 0.6
  group.position.set(outwardX, box.max.y, outward)
  group.rotation.y = spanX ? 0 : Math.PI / 2

  const half = span / 2
  const height = 4.6
  const hullParts: THREE.BufferGeometry[] = [
    boxGeom(0.6, height, 0.7, -half, height / 2, 0),
    boxGeom(0.6, height, 0.7, half, height / 2, 0),
    boxGeom(span + 0.8, 0.7, 0.85, 0, height + 0.2, 0),
    boxGeom(1.1, 0.5, 0.5, -half, height - 0.9, 0),
    boxGeom(1.1, 0.5, 0.5, half, height - 0.9, 0),
    boxGeom(1.4, 0.35, 1.2, -half, 0.18, 0),
    boxGeom(1.4, 0.35, 1.2, half, 0.18, 0),
  ]
  const hull = mergeMesh(hullParts, lib.hull, 'gateHull')
  if (hull) {
    hull.castShadow = true
    hull.receiveShadow = true
    group.add(hull)
  }

  const glowParts: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(span + 0.4, 0.16, 0.06).translate(0, height + 0.62, 0.46),
    new THREE.BoxGeometry(0.16, height - 1.2, 0.06).translate(-half, height / 2 - 0.3, 0.38),
    new THREE.BoxGeometry(0.16, height - 1.2, 0.06).translate(half, height / 2 - 0.3, 0.38),
  ]
  const glow = mergeMesh(glowParts, lib.teamGlow(team), 'gateGlow')
  if (glow) {
    glow.userData.pulse = true
    glow.userData.baseEmissive = 1.0
    group.add(glow)
  }

  return group
}

// ---- perimeter railing + pylons ---------------------------------------------

interface PerimeterPoint {
  x: number
  z: number
  edge: number
}

/**
 * Frames the playable area with lit pylons and a two-bar railing. Candidate
 * posts are sampled along the floor bounding box and dropped wherever there
 * is no floor within reach, so a map with a hole in its footprint (hairpin's
 * open U) never grows a railing hanging over the void.
 */
export function makePerimeter(lib: MaterialLibrary, bounds: Bounds, floors: AABB[]): THREE.Group {
  const group = new THREE.Group()
  group.name = 'perimeter'

  const step = 6
  const pad = 0.55
  const points: PerimeterPoint[] = []
  const pushEdge = (fromX: number, fromZ: number, toX: number, toZ: number, edge: number): void => {
    const len = Math.hypot(toX - fromX, toZ - fromZ)
    const n = Math.max(1, Math.round(len / step))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const x = fromX + (toX - fromX) * t
      const z = fromZ + (toZ - fromZ) * t
      if (nearFloor(x, z, floors)) points.push({ x, z, edge })
    }
  }
  pushEdge(bounds.minX - pad, bounds.minZ - pad, bounds.maxX + pad, bounds.minZ - pad, 0)
  pushEdge(bounds.maxX + pad, bounds.minZ - pad, bounds.maxX + pad, bounds.maxZ + pad, 1)
  pushEdge(bounds.maxX + pad, bounds.maxZ + pad, bounds.minX - pad, bounds.maxZ + pad, 2)
  pushEdge(bounds.minX - pad, bounds.maxZ + pad, bounds.minX - pad, bounds.minZ - pad, 3)

  if (points.length === 0) return group

  const postGeom = new THREE.CylinderGeometry(0.12, 0.2, 1.45, 6)
  postGeom.translate(0, 0.72, 0)
  const capGeom = new THREE.BoxGeometry(0.36, 0.14, 0.36)
  capGeom.translate(0, 1.52, 0)
  const lampGeom = new THREE.BoxGeometry(0.26, 0.09, 0.26)
  lampGeom.translate(0, 1.63, 0)

  const posts = new THREE.InstancedMesh(postGeom, lib.hullDark, points.length)
  const caps = new THREE.InstancedMesh(capGeom, lib.hullDark, points.length)
  const lamps = new THREE.InstancedMesh(lampGeom, lib.signal(0x63d8ff), points.length)
  lamps.userData.pulse = true
  lamps.userData.baseEmissive = 1.1

  const m = new THREE.Matrix4()
  const baseY = bounds.topY - 1
  points.forEach((p, i) => {
    m.makeTranslation(p.x, baseY, p.z)
    posts.setMatrixAt(i, m)
    caps.setMatrixAt(i, m)
    lamps.setMatrixAt(i, m)
  })
  posts.instanceMatrix.needsUpdate = true
  caps.instanceMatrix.needsUpdate = true
  lamps.instanceMatrix.needsUpdate = true
  posts.castShadow = true
  group.add(posts, caps, lamps)

  const railParts: THREE.BufferGeometry[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (a.edge !== b.edge) continue
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (len < 0.1 || len > step * 1.6) continue
    const angle = Math.atan2(b.x - a.x, b.z - a.z)
    for (const h of [0.55, 1.05]) {
      const bar = new THREE.BoxGeometry(0.09, 0.09, len)
      bar.rotateY(angle)
      bar.translate((a.x + b.x) / 2, baseY + h, (a.z + b.z) / 2)
      railParts.push(bar)
    }
  }
  const rails = mergeMesh(railParts, lib.hullDark, 'rails')
  if (rails) group.add(rails)

  return group
}

function nearFloor(x: number, z: number, floors: AABB[]): boolean {
  const reach = 1.6
  for (const f of floors) {
    if (x > f.min.x - reach && x < f.max.x + reach && z > f.min.z - reach && z < f.max.z + reach) return true
  }
  return false
}

// ---- rift crystals ----------------------------------------------------------

/** Slow-drifting shards above the lane. Two instanced passes over one
 * octahedron: a solid emissive core and an oversized additive shell that
 * fakes a bloom halo without a post-processing chain. */
export function makeRiftCrystals(lib: MaterialLibrary, bounds: Bounds): THREE.Group {
  const group = new THREE.Group()
  group.name = 'crystals'
  group.userData.spin = 0.05
  group.userData.bob = 0.5
  group.userData.bobBase = 0

  const count = 16
  const geom = new THREE.OctahedronGeometry(1, 0)
  const cores = new THREE.InstancedMesh(geom, lib.signal(0x7fd4ff), count)
  const shellGeom = new THREE.OctahedronGeometry(1, 0)
  const shells = new THREE.InstancedMesh(shellGeom, lib.additive(0x5fb8ff, 0.09), count)
  shells.renderOrder = 3

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  const pos = new THREE.Vector3()
  const scl = new THREE.Vector3()
  const cx = (bounds.minX + bounds.maxX) / 2
  const cz = (bounds.minZ + bounds.maxZ) / 2
  const spanX = bounds.maxX - bounds.minX
  const spanZ = bounds.maxZ - bounds.minZ

  for (let i = 0; i < count; i++) {
    const s = 0.16 + hash01(i * 3.7) * 0.3
    pos.set(
      cx + (hash01(i * 1.3) - 0.5) * (spanX + 70),
      bounds.topY + 13 + hash01(i * 5.1) * 22,
      cz + (hash01(i * 2.9) - 0.5) * (spanZ + 70)
    )
    e.set(hash01(i * 7.7) * Math.PI, hash01(i * 11.3) * Math.PI, hash01(i * 4.2) * Math.PI)
    q.setFromEuler(e)
    scl.set(s, s * 2.2, s)
    m.compose(pos, q, scl)
    cores.setMatrixAt(i, m)
    scl.multiplyScalar(1.4)
    m.compose(pos, q, scl)
    shells.setMatrixAt(i, m)
  }
  cores.instanceMatrix.needsUpdate = true
  shells.instanceMatrix.needsUpdate = true
  group.add(cores, shells)

  return group
}

// ---- parallax backdrop ------------------------------------------------------

/** Three depth rings of unlit tower silhouettes plus a float of broken
 * islands. Everything is instanced and heavily fogged, so the layers only
 * cost four draw calls but give the void a horizon and a sense of scale. */
export function makeBackdrop(lib: MaterialLibrary, bounds: Bounds): THREE.Group {
  const group = new THREE.Group()
  group.name = 'backdrop'
  const cx = (bounds.minX + bounds.maxX) / 2
  const cz = (bounds.minZ + bounds.maxZ) / 2
  const baseY = bounds.topY

  const rings = [
    { radius: 95, count: 22, height: 30, width: 7, seed: 3 },
    { radius: 155, count: 26, height: 52, width: 12, seed: 41 },
    { radius: 225, count: 28, height: 84, width: 20, seed: 97 },
  ]

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const pos = new THREE.Vector3()
  const scl = new THREE.Vector3()

  rings.forEach((ring, layer) => {
    const geom = new THREE.CylinderGeometry(0.34, 0.5, 1, 4, 1)
    geom.translate(0, 0.5, 0)
    const mesh = new THREE.InstancedMesh(geom, lib.backdrop, ring.count)
    for (let i = 0; i < ring.count; i++) {
      const seed = ring.seed + i
      const a = ((i + hash01(seed) * 0.6) / ring.count) * Math.PI * 2
      const r = ring.radius * (0.82 + hash01(seed * 2.1) * 0.4)
      const h = ring.height * (0.45 + hash01(seed * 3.3) * 1.1)
      const w = ring.width * (0.6 + hash01(seed * 5.7) * 0.9)
      pos.set(cx + Math.cos(a) * r, baseY - 6 + hash01(seed * 7.9) * 6, cz + Math.sin(a) * r)
      q.setFromAxisAngle(UP, hash01(seed * 9.1) * Math.PI)
      scl.set(w, h, w)
      m.compose(pos, q, scl)
      mesh.setMatrixAt(i, m)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    mesh.name = `backdropRing${layer}`
    group.add(mesh)
  })

  const islandGeom = new THREE.IcosahedronGeometry(1, 0)
  islandGeom.scale(1, 0.45, 1)
  const islands = new THREE.InstancedMesh(islandGeom, lib.backdrop, 16)
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + hash01(i * 13.7)
    const r = 70 + hash01(i * 2.3) * 130
    const s = 6 + hash01(i * 6.1) * 16
    pos.set(cx + Math.cos(a) * r, baseY + 14 + hash01(i * 8.9) * 42, cz + Math.sin(a) * r)
    q.setFromAxisAngle(UP, hash01(i * 3.1) * Math.PI)
    scl.set(s, s, s * (0.7 + hash01(i * 4.4) * 0.6))
    m.compose(pos, q, scl)
    islands.setMatrixAt(i, m)
  }
  islands.instanceMatrix.needsUpdate = true
  islands.frustumCulled = false
  group.add(islands)

  return group
}
