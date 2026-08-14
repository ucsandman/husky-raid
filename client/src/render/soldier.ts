import * as THREE from 'three'
import type { SnapPlayer, Team } from '@riftlane/shared'
import { PLAYER_BODY_CENTER_Y, PLAYER_HEAD_CENTER_Y } from '@riftlane/shared'

const TEAM_COLOR: Record<Team, number> = { 0: 0x3366ff, 1: 0xff7733 }
const VISOR_COLOR = 0x66ffee
const CAMO_OPACITY = 0.15
const NAME_TEX_WIDTH = 256
const NAME_TEX_HEIGHT = 64

interface SoldierData {
  materials: THREE.MeshLambertMaterial[]
  visorMat: THREE.MeshLambertMaterial
  flagProp: THREE.Mesh
  flagMat: THREE.MeshLambertMaterial
  nameSprite: THREE.Sprite
  nameMat: THREE.SpriteMaterial
  lastName: string
}

/**
 * Procedural low-poly soldier: capsule body, chest plate, shoulder pads,
 * visor head, team color. Built once per remote player at match_start and
 * mutated in place by updateSoldier() every frame -- never recreated, so
 * this stays cheap even with 7 bots + effects running.
 */
export function makeSoldier(team: Team): THREE.Group {
  const group = new THREE.Group()
  const color = TEAM_COLOR[team]

  const bodyMat = new THREE.MeshLambertMaterial({ color, transparent: true })
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.0, 4, 8), bodyMat)
  body.position.y = PLAYER_BODY_CENTER_Y
  group.add(body)

  const chestMat = new THREE.MeshLambertMaterial({ color: 0x20242e, transparent: true })
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.18), chestMat)
  chest.position.set(0, 1.05, 0.28)
  group.add(chest)

  const shoulderGeom = new THREE.BoxGeometry(0.22, 0.22, 0.22)
  const shoulderMatL = new THREE.MeshLambertMaterial({ color, transparent: true })
  const shoulderL = new THREE.Mesh(shoulderGeom, shoulderMatL)
  shoulderL.position.set(-0.42, 1.35, 0)
  group.add(shoulderL)
  const shoulderMatR = new THREE.MeshLambertMaterial({ color, transparent: true })
  const shoulderR = new THREE.Mesh(shoulderGeom, shoulderMatR)
  shoulderR.position.set(0.42, 1.35, 0)
  group.add(shoulderR)

  const headMat = new THREE.MeshLambertMaterial({ color: 0xcccccc, transparent: true })
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 10), headMat)
  head.position.set(0, PLAYER_HEAD_CENTER_Y, 0)
  group.add(head)

  const visorMat = new THREE.MeshLambertMaterial({
    color: VISOR_COLOR,
    emissive: VISOR_COLOR,
    emissiveIntensity: 1,
    transparent: true,
  })
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.06), visorMat)
  visor.position.set(0, PLAYER_HEAD_CENTER_Y + 0.02, 0.23)
  group.add(visor)

  const flagMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 0.4,
    transparent: true,
  })
  const flagProp = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.35), flagMat)
  flagProp.position.set(0, 1.4, -0.3)
  flagProp.visible = false
  group.add(flagProp)

  const nameMat = new THREE.SpriteMaterial({ transparent: true, depthTest: false })
  const nameSprite = new THREE.Sprite(nameMat)
  nameSprite.position.set(0, PLAYER_HEAD_CENTER_Y + 0.6, 0)
  nameSprite.scale.set(1.4, 0.35, 1)
  nameSprite.visible = false
  nameSprite.renderOrder = 10
  group.add(nameSprite)

  const data: SoldierData = {
    materials: [bodyMat, chestMat, shoulderMatL, shoulderMatR, headMat],
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
 * position/yaw, hidden when dead, translucent when camo'd, flag prop shown
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
    const color = TEAM_COLOR[snap.carryingFlag]
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
  mat.map?.dispose()
  mat.map = texture
  mat.needsUpdate = true
}
