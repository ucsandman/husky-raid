import * as THREE from 'three'
import type { SnapPlayer, Team } from '@riftlane/shared'
import { PLAYER_HEAD_CENTER_Y } from '@riftlane/shared'
import { TEAM_GLOW, type MaterialLibrary } from './materials'
import { boxGeom, mergeMesh } from './worldKit'

const VISOR_COLOR = 0x7ff2ff
const CAMO_OPACITY = 0.15
// Brighter than materials.ts's TEAM_HULL (0x36599f / 0xa85c2c): that
// constant also colors map decor (MaterialLibrary.teamHull), which reads
// fine against the sky/rim lights, but the same tone on a soldier's armor
// panels reads almost black once it's only lit by the dusk hemisphere/sun --
// this local, brighter pair is soldier-only so map decor is unaffected.
const SOLDIER_ARMOR: Record<Team, number> = { 0: 0x5f8ce0, 1: 0xdb8a3f }
const NAME_TEX_WIDTH = 256
const NAME_TEX_HEIGHT = 64

interface SoldierData {
  materials: THREE.Material[]
  visorMat: THREE.MeshStandardMaterial
  flagProp: THREE.Group
  flagMat: THREE.MeshStandardMaterial
  nameSprite: THREE.Sprite
  nameMat: THREE.SpriteMaterial
  lastName: string
}

interface Kit {
  armor: THREE.BufferGeometry[]
  hull: THREE.BufferGeometry[]
  plate: THREE.BufferGeometry[]
  trim: THREE.BufferGeometry[]
}

function cyl(r0: number, r1: number, h: number, seg: number): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(r0, r1, h, seg)
}

/** Legs: thigh, shin, boot, kneepad. Built per side so the silhouette reads
 * as a figure rather than a capsule at every distance. */
function addLeg(kit: Kit, side: number): void {
  kit.hull.push(boxGeom(0.2, 0.5, 0.24, side * 0.16, 0.62, 0))
  kit.hull.push(boxGeom(0.17, 0.46, 0.2, side * 0.16, 0.26, 0.015))
  kit.plate.push(boxGeom(0.23, 0.11, 0.36, side * 0.16, 0.055, 0.06))
  kit.armor.push(boxGeom(0.2, 0.15, 0.08, side * 0.16, 0.47, 0.12))
}

/** Arms angled forward into a two-handed grip, with a shoulder pad that
 * breaks the torso outline. */
function addArm(kit: Kit, side: number): void {
  const pad = boxGeom(0.27, 0.21, 0.31, 0, 0, 0)
  pad.rotateZ(side * -0.28)
  pad.translate(side * 0.34, 1.49, 0)
  kit.armor.push(pad)

  const upper = boxGeom(0.15, 0.34, 0.16, 0, 0, 0)
  upper.rotateX(0.25)
  upper.translate(side * 0.33, 1.24, 0.03)
  kit.hull.push(upper)

  const fore = boxGeom(0.14, 0.32, 0.15, 0, 0, 0)
  fore.rotateX(-0.95)
  fore.translate(side * 0.27, 1.05, 0.21)
  kit.hull.push(fore)

  kit.plate.push(boxGeom(0.13, 0.11, 0.15, side * 0.23, 0.97, 0.35))
}

function buildKit(): Kit {
  const kit: Kit = { armor: [], hull: [], plate: [], trim: [] }

  addLeg(kit, -1)
  addLeg(kit, 1)
  addArm(kit, -1)
  addArm(kit, 1)

  kit.armor.push(boxGeom(0.45, 0.24, 0.31, 0, 0.95, 0))
  kit.hull.push(boxGeom(0.49, 0.1, 0.34, 0, 0.87, 0))
  kit.hull.push(boxGeom(0.32, 0.07, 0.29, 0, 1.06, 0.01))
  kit.hull.push(boxGeom(0.32, 0.07, 0.29, 0, 1.15, 0.01))

  kit.armor.push(boxGeom(0.5, 0.44, 0.33, 0, 1.32, 0))
  kit.armor.push(boxGeom(0.44, 0.16, 0.3, 0, 1.53, -0.01))
  kit.plate.push(boxGeom(0.36, 0.3, 0.09, 0, 1.34, 0.2))
  kit.plate.push(boxGeom(0.14, 0.14, 0.05, 0, 1.52, 0.17))

  kit.hull.push(boxGeom(0.37, 0.44, 0.21, 0, 1.34, -0.25))
  kit.hull.push(boxGeom(0.16, 0.12, 0.1, 0, 1.6, -0.36))
  kit.hull.push(boxGeom(0.03, 0.42, 0.03, -0.15, 1.75, -0.28))
  for (const s of [-1, 1]) {
    const nozzle = new THREE.ConeGeometry(0.075, 0.18, 8)
    nozzle.rotateX(Math.PI)
    nozzle.translate(s * 0.12, 1.07, -0.26)
    kit.plate.push(nozzle)
    kit.trim.push(cyl(0.055, 0.055, 0.02, 8).translate(s * 0.12, 0.985, -0.26))
  }

  kit.hull.push(cyl(0.085, 0.085, 0.13, 8).translate(0, 1.4, 0))

  const helmet = new THREE.SphereGeometry(0.23, 14, 10)
  helmet.scale(1, 1.06, 1.1)
  helmet.translate(0, PLAYER_HEAD_CENTER_Y, 0)
  kit.plate.push(helmet)
  kit.armor.push(boxGeom(0.07, 0.17, 0.36, 0, PLAYER_HEAD_CENTER_Y + 0.17, -0.03))
  kit.hull.push(boxGeom(0.21, 0.13, 0.13, 0, PLAYER_HEAD_CENTER_Y - 0.1, 0.17))

  kit.hull.push(boxGeom(0.11, 0.13, 0.44, 0.17, 1.01, 0.42))
  kit.hull.push(boxGeom(0.08, 0.17, 0.11, 0.17, 0.89, 0.36))
  kit.plate.push(cyl(0.036, 0.036, 0.32, 8).rotateX(Math.PI / 2).translate(0.17, 1.03, 0.72))
  kit.trim.push(boxGeom(0.03, 0.04, 0.22, 0.225, 1.04, 0.44))

  // Chest strip and shoulder caps enlarged (0.035->0.055, 0.03->0.05) so the
  // team-color emissive reads as a clear cue at range, not a faint dot.
  kit.trim.push(boxGeom(0.23, 0.055, 0.02, 0, 1.45, 0.245))
  kit.trim.push(boxGeom(0.09, 0.035, 0.02, 0, 1.22, 0.25))
  kit.trim.push(boxGeom(0.26, 0.04, 0.02, 0, 1.47, -0.36))
  for (const s of [-1, 1]) {
    kit.trim.push(boxGeom(0.2, 0.05, 0.02, s * 0.34, 1.58, 0.14))
    kit.trim.push(boxGeom(0.02, 0.03, 0.14, s * 0.26, 0.83, 0))
  }

  return kit
}

function makeFlagProp(mat: THREE.MeshStandardMaterial, poleMat: THREE.Material): THREE.Group {
  const group = new THREE.Group()

  const pole = new THREE.Mesh(cyl(0.028, 0.028, 1.0, 6), poleMat)
  pole.position.set(0.1, 1.5, -0.36)
  pole.rotation.x = -0.35
  group.add(pole)

  const cloth: THREE.BufferGeometry[] = []
  for (let i = 0; i < 3; i++) {
    const seg = new THREE.PlaneGeometry(0.19, 0.34)
    seg.rotateY(Math.sin(i * 1.6) * 0.45)
    seg.translate(0.29 + i * 0.19, 1.78 - i * 0.02, -0.44 + Math.sin(i * 1.6) * 0.05)
    cloth.push(seg)
  }
  const banner = mergeMesh(cloth, mat, 'flagCloth')
  if (banner) {
    mat.side = THREE.DoubleSide
    group.add(banner)
  }

  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 6, 18), mat)
  halo.rotation.x = -Math.PI / 2
  halo.position.y = 2.05
  group.add(halo)

  group.visible = false
  return group
}

/**
 * Authored soldier: legs, pelvis, layered torso, shoulder pads, forward-held
 * arms with a weapon stub, thruster backpack and a crested visor helmet.
 * Geometry is merged down to five draw calls (armour / dark hull / light
 * plate / emissive trim / visor) so seven remote players cost ~35 calls
 * instead of ~200.
 *
 * Built once per remote player at match_start and mutated in place by
 * updateSoldier() every frame -- never recreated. Materials are per-soldier
 * (camo mutates opacity per player) but share the library's textures, which
 * is safe because every soldier is disposed together at teardown.
 */
export function makeSoldier(team: Team, lib: MaterialLibrary): THREE.Group {
  const group = new THREE.Group()

  // The panel texture's dark #39404f base multiplies the armor color down and
  // metalness has no envMap to reflect, so lit-only team color reads black at
  // range. A team-tinted emissive floor keeps the hue readable in any light.
  const armorMat = new THREE.MeshStandardMaterial({
    color: SOLDIER_ARMOR[team],
    emissive: SOLDIER_ARMOR[team],
    emissiveIntensity: 0.42,
    map: lib.panelTex,
    roughness: 0.5,
    metalness: 0.1,
    transparent: true,
  })
  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x3a4356,
    map: lib.panelTex,
    roughness: 0.68,
    metalness: 0.15,
    transparent: true,
  })
  const plateMat = new THREE.MeshStandardMaterial({
    color: 0xa9b6cc,
    roughness: 0.42,
    metalness: 0.6,
    transparent: true,
  })
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x0b0f18,
    emissive: TEAM_GLOW[team],
    // Bumped from 1.15 -- at 30m+ in the dusk lighting the old value read
    // as a faint dot rather than a readable team-color cue.
    emissiveIntensity: 2.1,
    roughness: 0.4,
    transparent: true,
  })
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0x0a1620,
    emissive: VISOR_COLOR,
    emissiveIntensity: 1.5,
    roughness: 0.15,
    metalness: 0.2,
    transparent: true,
  })

  const kit = buildKit()
  const armor = mergeMesh(kit.armor, armorMat, 'armor')
  const hull = mergeMesh(kit.hull, hullMat, 'hull')
  const plate = mergeMesh(kit.plate, plateMat, 'plate')
  const trim = mergeMesh(kit.trim, trimMat, 'trim')
  for (const mesh of [armor, hull, plate, trim]) {
    if (!mesh) continue
    mesh.receiveShadow = true
    group.add(mesh)
  }
  // Only the two mass-carrying meshes cast: the silhouette is identical and
  // it halves this soldier's cost in the shadow pass.
  if (armor) armor.castShadow = true
  if (hull) hull.castShadow = true

  const visor = new THREE.Mesh(boxGeom(0.31, 0.12, 0.09, 0, PLAYER_HEAD_CENTER_Y + 0.02, 0.2), visorMat)
  visor.name = 'visor'
  group.add(visor)

  const flagMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 1.1,
    roughness: 0.5,
    transparent: true,
  })
  const flagProp = makeFlagProp(flagMat, hullMat)
  group.add(flagProp)

  const nameMat = new THREE.SpriteMaterial({ transparent: true, depthTest: false })
  const nameSprite = new THREE.Sprite(nameMat)
  nameSprite.position.set(0, PLAYER_HEAD_CENTER_Y + 0.6, 0)
  nameSprite.scale.set(1.4, 0.35, 1)
  nameSprite.visible = false
  nameSprite.renderOrder = 10
  group.add(nameSprite)

  const data: SoldierData = {
    materials: [armorMat, hullMat, plateMat, trimMat],
    visorMat,
    flagProp,
    flagMat,
    nameSprite,
    nameMat,
    lastName: '',
  }
  group.userData.soldier = data

  return group
}

/** Mutates `group` (built by makeSoldier) to match one snapshot frame:
 * position/yaw, hidden when dead, translucent when camo'd, flag rig shown
 * for the carried team's color, and a name sprite for humans only (bots
 * never get one -- brief calls for "name sprites for humans only"). */
export function updateSoldier(group: THREE.Group, snap: SnapPlayer): void {
  const data = group.userData.soldier as SoldierData
  group.visible = snap.alive
  if (!snap.alive) return

  group.position.set(snap.pos.x, snap.pos.y, snap.pos.z)
  group.rotation.y = snap.yaw

  const opacity = snap.camo ? CAMO_OPACITY : 1
  for (const mat of data.materials) mat.opacity = opacity
  data.visorMat.opacity = opacity
  data.flagMat.opacity = opacity

  data.flagProp.visible = snap.carryingFlag !== null
  if (snap.carryingFlag !== null) {
    const color = TEAM_GLOW[snap.carryingFlag]
    data.flagMat.color.setHex(color)
    data.flagMat.emissive.setHex(color)
  }

  if (!snap.bot) {
    if (data.lastName !== snap.name) {
      data.lastName = snap.name
      paintNameTexture(data.nameMat, snap.name)
    }
    data.nameSprite.visible = true
    data.nameSprite.material.opacity = opacity
  } else {
    data.nameSprite.visible = false
  }
}

function paintNameTexture(mat: THREE.SpriteMaterial, name: string): void {
  const canvas = document.createElement('canvas')
  canvas.width = NAME_TEX_WIDTH
  canvas.height = NAME_TEX_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'rgba(10, 13, 20, 0.6)'
  ctx.fillRect(0, 14, canvas.width, 36)
  ctx.font = 'bold 32px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#ffffff'
  ctx.fillText(name.slice(0, 16) || '(unnamed)', canvas.width / 2, canvas.height / 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  mat.map?.dispose()
  mat.map = texture
  mat.needsUpdate = true
}
