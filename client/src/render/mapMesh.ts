import * as THREE from 'three'
import type { GameMap, Team, Vec3 } from '@riftlane/shared'

const TEAM_COLOR: Record<Team, number> = { 0: 0x3366ff, 1: 0xff7733 }
const TELEPORTER_COLOR_A = 0x33aaff
const TELEPORTER_COLOR_B = 0xff9933
const LAUNCHPAD_COLOR = 0x55ffcc
const GROUND_COLOR = 0x05060a
const GROUND_SIZE = 400
const GROUND_DROP = 5

/**
 * Builds one static Group for a match's map: a Mesh per AABB (colored from
 * boxColors), launch pads as glowing cylinders, teleporter pairs as
 * emissive rings (blue = 'a' end, orange = 'b' end), team-colored flag
 * stand bases, and a dark ground plane far below deathY (catches the eye
 * during the fall so death pits don't read as a void). Meshes tagged
 * `userData.pulse` are animated by effects.ts's tickMapPulse each frame --
 * mapMesh.ts only builds the geometry, it doesn't own the render loop.
 */
export function buildMap(map: GameMap): THREE.Group {
  const group = new THREE.Group()
  group.name = 'map'

  const boxGeom = new THREE.BoxGeometry(1, 1, 1)
  map.boxes.forEach((box, i) => {
    const color = map.boxColors[i] ?? 0x888888
    const mat = new THREE.MeshLambertMaterial({ color })
    const mesh = new THREE.Mesh(boxGeom, mat)
    const sx = Math.max(box.max.x - box.min.x, 0.01)
    const sy = Math.max(box.max.y - box.min.y, 0.01)
    const sz = Math.max(box.max.z - box.min.z, 0.01)
    mesh.scale.set(sx, sy, sz)
    mesh.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2)
    group.add(mesh)
  })

  for (const pad of map.launchPads) {
    const geom = new THREE.CylinderGeometry(pad.radius, pad.radius, 0.2, 16)
    const mat = new THREE.MeshLambertMaterial({
      color: LAUNCHPAD_COLOR,
      emissive: LAUNCHPAD_COLOR,
      emissiveIntensity: 0.6,
    })
    const mesh = new THREE.Mesh(geom, mat)
    mesh.position.set(pad.pos.x, pad.pos.y + 0.1, pad.pos.z)
    mesh.userData.pulse = true
    mesh.userData.baseEmissive = 0.6
    group.add(mesh)
  }

  for (const tp of map.teleporters) {
    group.add(makeTeleporterRing(tp.a, tp.radius, TELEPORTER_COLOR_A))
    group.add(makeTeleporterRing(tp.b, tp.radius, TELEPORTER_COLOR_B))
  }

  map.flagStands.forEach((stand, i) => {
    const color = TEAM_COLOR[i as Team]
    const geom = new THREE.CylinderGeometry(1, 1.2, 0.6, 8)
    const mat = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.25 })
    const mesh = new THREE.Mesh(geom, mat)
    mesh.position.set(stand.x, stand.y + 0.3, stand.z)
    group.add(mesh)
  })

  const groundGeom = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE)
  const groundMat = new THREE.MeshLambertMaterial({ color: GROUND_COLOR })
  const ground = new THREE.Mesh(groundGeom, groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = map.deathY - GROUND_DROP
  group.add(ground)

  return group
}

function makeTeleporterRing(pos: Vec3, radius: number, color: number): THREE.Mesh {
  const geom = new THREE.RingGeometry(radius * 0.7, radius, 24)
  const mat = new THREE.MeshLambertMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.8,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geom, mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(pos.x, pos.y + 0.05, pos.z)
  mesh.userData.pulse = true
  mesh.userData.baseEmissive = 0.8
  return mesh
}
