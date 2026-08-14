import * as THREE from 'three'
import type { AABB, GameMap, Team } from '@riftlane/shared'
import { TEAM_GLOW, TELEPORT_A_COLOR, TELEPORT_B_COLOR, type MaterialLibrary } from './materials'
import {
  boundsOf,
  boxGeom,
  makeBackdrop,
  makeBaseGate,
  makeFlagBeacon,
  makeJumpPad,
  makePerimeter,
  makeRiftCrystals,
  makeTeleportPad,
  mergeMesh,
} from './worldKit'

const LANE_ACCENT = 0x49b6ff
const GROUND_SIZE = 700
const GROUND_DROP = 8
const TRIM_H = 0.09
const TRIM_W = 0.26

type BoxRole = 'floor' | 'cover' | 'base' | 'structure'

function teamOfColor(color: number): Team | null {
  const r = (color >> 16) & 0xff
  const b = color & 0xff
  if (b > r + 24) return 0
  if (r > b + 24) return 1
  return null
}

/** Splits the sim's untyped AABB list into art roles. The sim only knows
 * "solid box", so the read is geometric: a small standing block is cover, a
 * wide flat slab carrying a flag stand is a base platform, any other wide
 * flat slab is walkable deck, and anything left over gets plain hull. */
function roleOf(box: AABB, map: GameMap): BoxRole {
  const sx = box.max.x - box.min.x
  const sy = box.max.y - box.min.y
  const sz = box.max.z - box.min.z
  if (sx <= 3 && sz <= 3 && sy >= 0.6) return 'cover'
  if (sy <= 1.6 && sx * sz >= 3) {
    const carriesStand = map.flagStands.some(
      (s) => s.x >= box.min.x && s.x <= box.max.x && s.z >= box.min.z && s.z <= box.max.z && Math.abs(s.y - box.max.y) < 0.6
    )
    return carriesStand ? 'base' : 'floor'
  }
  return 'structure'
}

function topEdgeTrim(box: AABB, out: THREE.BufferGeometry[]): void {
  const y = box.max.y - TRIM_H / 2 + 0.01
  const sx = box.max.x - box.min.x
  const sz = box.max.z - box.min.z
  const cx = (box.min.x + box.max.x) / 2
  const cz = (box.min.z + box.max.z) / 2
  out.push(boxGeom(sx, TRIM_H, TRIM_W, cx, y, box.min.z + TRIM_W / 2))
  out.push(boxGeom(sx, TRIM_H, TRIM_W, cx, y, box.max.z - TRIM_W / 2))
  out.push(boxGeom(TRIM_W, TRIM_H, sz, box.min.x + TRIM_W / 2, y, cz))
  out.push(boxGeom(TRIM_W, TRIM_H, sz, box.max.x - TRIM_W / 2, y, cz))
}

/** Two emissive guide strips inset along the deck's long axis -- the lane's
 * "which way is forward" read at a glance. */
function laneStrips(box: AABB, out: THREE.BufferGeometry[]): void {
  const sx = box.max.x - box.min.x
  const sz = box.max.z - box.min.z
  const cx = (box.min.x + box.max.x) / 2
  const cz = (box.min.z + box.max.z) / 2
  const y = box.max.y + 0.012
  const inset = 0.75
  if (sz >= sx) {
    if (sx < inset * 2 + 0.4) return
    out.push(new THREE.BoxGeometry(0.12, 0.02, sz - 1).translate(box.min.x + inset, y, cz))
    out.push(new THREE.BoxGeometry(0.12, 0.02, sz - 1).translate(box.max.x - inset, y, cz))
  } else {
    if (sz < inset * 2 + 0.4) return
    out.push(new THREE.BoxGeometry(sx - 1, 0.02, 0.12).translate(cx, y, box.min.z + inset))
    out.push(new THREE.BoxGeometry(sx - 1, 0.02, 0.12).translate(cx, y, box.max.z - inset))
  }
}

/** Cover blocks get a real silhouette: a bevelled body, a lipped top plate,
 * four corner posts and a warning band, instead of a recoloured cube. */
function coverBlock(
  box: AABB,
  hullOut: THREE.BufferGeometry[],
  plateOut: THREE.BufferGeometry[],
  glowOut: THREE.BufferGeometry[]
): void {
  const sx = box.max.x - box.min.x
  const sy = box.max.y - box.min.y
  const sz = box.max.z - box.min.z
  const cx = (box.min.x + box.max.x) / 2
  const cz = (box.min.z + box.max.z) / 2
  const cy = (box.min.y + box.max.y) / 2

  hullOut.push(boxGeom(sx * 0.94, sy * 0.86, sz * 0.94, cx, cy - sy * 0.05, cz))
  plateOut.push(boxGeom(sx, sy * 0.14, sz, cx, box.max.y - sy * 0.07, cz))
  plateOut.push(boxGeom(sx * 1.02, sy * 0.1, sz * 1.02, cx, box.min.y + sy * 0.05, cz))
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      plateOut.push(boxGeom(sx * 0.14, sy * 0.9, sz * 0.14, cx + (dx * sx) / 2.1, cy, cz + (dz * sz) / 2.1))
    }
  }
  glowOut.push(new THREE.BoxGeometry(sx * 0.62, 0.07, 0.03).translate(cx, box.max.y - sy * 0.34, box.min.z - 0.005))
  glowOut.push(new THREE.BoxGeometry(sx * 0.62, 0.07, 0.03).translate(cx, box.max.y - sy * 0.34, box.max.z + 0.005))
  glowOut.push(new THREE.BoxGeometry(0.03, 0.07, sz * 0.62).translate(box.min.x - 0.005, box.max.y - sy * 0.34, cz))
  glowOut.push(new THREE.BoxGeometry(0.03, 0.07, sz * 0.62).translate(box.max.x + 0.005, box.max.y - sy * 0.34, cz))
}

/**
 * Builds one static Group for a match's map. Everything repeated is merged
 * or instanced so the whole world stays inside ~40 draw calls: one deck
 * mesh, one trim mesh, one lane-strip mesh, one cover hull per team, then
 * the authored landmarks (base gates, flag beacons, jump pads, teleporter
 * frames), the perimeter railing, floating rift crystals and three rings of
 * backdrop towers.
 *
 * Meshes tagged `userData.pulse` / `shimmer` / `padPulse` / `spin` / `bob`
 * are animated by effects.ts's tickMapPulse each frame -- mapMesh.ts only
 * decides which parts move, effects.ts decides how.
 *
 * The two team-coloured rim fills live in this group (not scene.ts) because
 * only the map knows where the bases are; parenting them here also means
 * they are removed with the rest of the map on teardown.
 */
export function buildMap(map: GameMap, lib: MaterialLibrary): THREE.Group {
  const group = new THREE.Group()
  group.name = 'map'

  const deckParts: THREE.BufferGeometry[] = []
  const trimParts: THREE.BufferGeometry[] = []
  const stripParts: THREE.BufferGeometry[] = []
  const structureParts: THREE.BufferGeometry[] = []
  const coverHull: Record<number, THREE.BufferGeometry[]> = { 0: [], 1: [], 2: [] }
  const coverPlate: THREE.BufferGeometry[] = []
  const coverGlow: Record<number, THREE.BufferGeometry[]> = { 0: [], 1: [], 2: [] }
  const floors: AABB[] = []
  const baseBoxes: { box: AABB; team: Team }[] = []

  map.boxes.forEach((box, i) => {
    const role = roleOf(box, map)
    const sx = box.max.x - box.min.x
    const sy = box.max.y - box.min.y
    const sz = box.max.z - box.min.z
    const cx = (box.min.x + box.max.x) / 2
    const cy = (box.min.y + box.max.y) / 2
    const cz = (box.min.z + box.max.z) / 2
    const team = teamOfColor(map.boxColors[i] ?? 0x888888)

    if (role === 'cover') {
      const key = team ?? 2
      coverBlock(box, coverHull[key], coverPlate, coverGlow[key])
      return
    }
    if (role === 'base') {
      baseBoxes.push({ box, team: team ?? (cz < 0 ? 0 : 1) })
      return
    }
    if (role === 'structure') {
      structureParts.push(boxGeom(sx, sy, sz, cx, cy, cz))
      return
    }
    floors.push(box)
    deckParts.push(boxGeom(sx, sy, sz, cx, cy, cz))
    topEdgeTrim(box, trimParts)
    laneStrips(box, stripParts)
  })

  const deck = mergeMesh(deckParts, lib.deck, 'deck')
  if (deck) {
    deck.receiveShadow = true
    group.add(deck)
  }
  const trim = mergeMesh(trimParts, lib.trim, 'deckTrim')
  if (trim) {
    trim.receiveShadow = true
    group.add(trim)
  }
  const strips = mergeMesh(stripParts, lib.signal(LANE_ACCENT), 'laneStrips')
  if (strips) {
    strips.userData.pulse = true
    strips.userData.baseEmissive = 0.85
    group.add(strips)
  }
  const structure = mergeMesh(structureParts, lib.hull, 'structure')
  if (structure) {
    structure.castShadow = true
    structure.receiveShadow = true
    group.add(structure)
  }

  for (const key of [0, 1, 2]) {
    const mat = key === 2 ? lib.hull : lib.teamHull(key as Team)
    const hull = mergeMesh(coverHull[key], mat, `cover${key}`)
    if (hull) {
      hull.castShadow = true
      hull.receiveShadow = true
      group.add(hull)
    }
    const glowMat = key === 2 ? lib.signal(LANE_ACCENT) : lib.teamGlow(key as Team)
    const glow = mergeMesh(coverGlow[key], glowMat, `coverGlow${key}`)
    if (glow) {
      glow.userData.pulse = true
      glow.userData.baseEmissive = 1.0
      group.add(glow)
    }
  }
  const plates = mergeMesh(coverPlate, lib.hullDark, 'coverPlates')
  if (plates) {
    plates.castShadow = true
    plates.receiveShadow = true
    group.add(plates)
  }

  const bounds = boundsOf(map.boxes)
  const mapCenterZ = (bounds.minZ + bounds.maxZ) / 2

  for (const { box, team } of baseBoxes) {
    const sx = box.max.x - box.min.x
    const sy = box.max.y - box.min.y
    const sz = box.max.z - box.min.z
    const cx = (box.min.x + box.max.x) / 2
    const cy = (box.min.y + box.max.y) / 2
    const cz = (box.min.z + box.max.z) / 2
    const pad = mergeMesh([boxGeom(sx, sy, sz, cx, cy, cz)], lib.teamHull(team), `basePad${team}`)
    if (pad) {
      pad.receiveShadow = true
      group.add(pad)
    }
    const rimParts: THREE.BufferGeometry[] = []
    topEdgeTrim(box, rimParts)
    const rim = mergeMesh(rimParts, lib.teamGlow(team), `baseRim${team}`)
    if (rim) {
      rim.userData.pulse = true
      rim.userData.baseEmissive = 1.0
      group.add(rim)
    }
    group.add(makeBaseGate(lib, box, team, mapCenterZ))
  }

  map.flagStands.forEach((stand, i) => {
    group.add(makeFlagBeacon(lib, stand, i as Team))
  })

  for (const pad of map.launchPads) {
    group.add(makeJumpPad(lib, pad.pos, pad.radius))
  }

  for (const tp of map.teleporters) {
    group.add(makeTeleportPad(lib, tp.a, tp.radius, TELEPORT_A_COLOR))
    group.add(makeTeleportPad(lib, tp.b, tp.radius, TELEPORT_B_COLOR))
  }

  group.add(makePerimeter(lib, boundsOf(floors.length > 0 ? floors : map.boxes), floors))
  group.add(makeRiftCrystals(lib, bounds))
  group.add(makeBackdrop(lib, bounds))

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, 1, 1), lib.ground)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = map.deathY - GROUND_DROP
  const groundUv = ground.geometry.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < groundUv.count; i++) {
    groundUv.setXY(i, groundUv.getX(i) * 90, groundUv.getY(i) * 90)
  }
  group.add(ground)

  map.flagStands.forEach((stand, i) => {
    const team = i as Team
    const fill = new THREE.DirectionalLight(TEAM_GLOW[team], 0.55)
    fill.position.set(stand.x, stand.y + 10, stand.z)
    fill.target.position.set(0, 0, mapCenterZ)
    group.add(fill, fill.target)
  })

  return group
}
