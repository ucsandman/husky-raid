import * as THREE from 'three'
import type { SnapPlayer, Team } from '@riftlane/shared'
import { MOVE_SPEED, PLAYER_HEAD_CENTER_Y, SPRINT_SPEED_MULT } from '@riftlane/shared'
import { decayTo } from './feel'
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

// ---- joints + locomotion ----------------------------------------------------
//
// Joint heights are measured off the authored geometry below: the thigh's top
// face, the shoulder pad's centre, and the waist seam between pelvis and
// chest plates. Change a joint without re-measuring and the limb detaches.
const HIP_Y = 0.87
const SHOULDER_Y = 1.42
const WAIST_Y = 1.2
const HIP_X = 0.16
const SHOULDER_X = 0.33

/** Walk phase advances with distance travelled, not with time -- a soldier
 * strafing at half speed takes half-length strides at the same cadence
 * instead of sprinting his legs in place. Radians of phase per metre. */
const STRIDE_PER_METRE = 1.15
const LEG_SWING = 0.6
const ARM_SWING = 0.2
/** Amplitude (not phase) is what eases in/out, so a stop freezes the stride
 * mid-step and settles to neutral rather than snapping straight-legged. */
const SWING_TAU = 0.11
/** Torso aim clamp. The sim lets pitch reach +-PI/2; bending a rigid torso
 * that far turns the silhouette into a folded chair. */
const AIM_PITCH_MAX = 0.9
/** performance.now() deltas run wild across a tab switch or a GC pause; one
 * frame's worth of walk cycle is all we ever want to integrate. */
const MAX_FRAME_DT = 0.1

// ---- death collapse ---------------------------------------------------------
const TIP_TIME = 0.45
const TIP_BOUNCE = 0.055
const FADE_DELAY = 0.45
const FADE_TIME = 0.6

/** Spawn protection: emissive multiplier at the top of the pulse, and the
 * pulse rate in rad/s. Fast enough to read as "not settled yet" at a glance,
 * shallow enough not to be mistaken for a muzzle flash. */
const PROT_PULSE = 0.9
const PROT_RATE = 9

interface SoldierData {
  /** The four shared body materials, in emissive-base order below. Every
   * segment references these same four instances, so a camo/death fade is
   * still four writes no matter how many groups the body is split into. */
  materials: THREE.MeshStandardMaterial[]
  visorMat: THREE.MeshStandardMaterial
  /** Authored emissiveIntensity per material, so the spawn-protection pulse
   * can scale from a known floor and restore it exactly. */
  emissiveBase: number[]
  upper: THREE.Group
  /** Index 0 = the -X side, 1 = +X, matching the build loops. */
  legs: THREE.Group[]
  arms: THREE.Group[]
  flagProp: THREE.Group
  flagMat: THREE.MeshStandardMaterial
  nameSprite: THREE.Sprite
  nameMat: THREE.SpriteMaterial
  lastName: string
  phase: number
  swing: number
  /** Seconds into the death collapse; -1 = alive, or collapse finished. */
  deathT: number
  wasAlive: boolean
  /** performance.now()/1000 at the last update; -1 before the first frame. */
  lastT: number
  /** Last emissive multiplier written, so a soldier with no spawn protection
   * costs one float compare per frame instead of five material writes. */
  protMult: number
}

interface Kit {
  armor: THREE.BufferGeometry[]
  hull: THREE.BufferGeometry[]
  plate: THREE.BufferGeometry[]
  trim: THREE.BufferGeometry[]
}

interface Mats {
  armor: THREE.MeshStandardMaterial
  hull: THREE.MeshStandardMaterial
  plate: THREE.MeshStandardMaterial
  trim: THREE.MeshStandardMaterial
}

const PART_LABELS = ['armor', 'hull', 'plate', 'trim'] as const

function cyl(r0: number, r1: number, h: number, seg: number): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(r0, r1, h, seg)
}

function newKit(): Kit {
  return { armor: [], hull: [], plate: [], trim: [] }
}

/** Legs: thigh, shin, boot, kneepad. Built per side so the silhouette reads
 * as a figure rather than a capsule at every distance. */
function addLeg(kit: Kit, side: number): void {
  kit.hull.push(boxGeom(0.2, 0.5, 0.24, side * HIP_X, 0.62, 0))
  kit.hull.push(boxGeom(0.17, 0.46, 0.2, side * HIP_X, 0.26, 0.015))
  kit.plate.push(boxGeom(0.23, 0.11, 0.36, side * HIP_X, 0.055, 0.06))
  kit.armor.push(boxGeom(0.2, 0.15, 0.08, side * HIP_X, 0.47, 0.12))
}

/** Arm limb angled forward into a two-handed grip. The shoulder pad lives on
 * the torso instead (addTorso): it sits on the joint, so swinging it with the
 * limb would wobble the outline rather than read as an arm moving. */
function addArm(kit: Kit, side: number): void {
  const upper = boxGeom(0.15, 0.34, 0.16, 0, 0, 0)
  upper.rotateX(0.25)
  upper.translate(side * SHOULDER_X, 1.24, 0.03)
  kit.hull.push(upper)

  const fore = boxGeom(0.14, 0.32, 0.15, 0, 0, 0)
  fore.rotateX(-0.95)
  fore.translate(side * 0.27, 1.05, 0.21)
  kit.hull.push(fore)

  kit.plate.push(boxGeom(0.13, 0.11, 0.15, side * 0.23, 0.97, 0.35))
}

/** Everything from the pelvis up that does not swing: shoulder pads, layered
 * torso, thruster backpack, helmet, the held weapon stub, and the team-colour
 * trim strips. */
function addTorso(kit: Kit): void {
  for (const s of [-1, 1]) {
    const pad = boxGeom(0.27, 0.21, 0.31, 0, 0, 0)
    pad.rotateZ(s * -0.28)
    pad.translate(s * 0.34, 1.49, 0)
    kit.armor.push(pad)
  }

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
}

/**
 * Merges one body segment down to one mesh per material and re-origins it on
 * its joint, so the returned group can be rotated about a real hip/shoulder/
 * waist by updateSoldier's walk cycle. All four materials are shared with
 * every other segment, so splitting the body costs draw calls, never extra
 * material state.
 */
function buildSegment(kit: Kit, mats: Mats, name: string, px: number, py: number): THREE.Group {
  const group = new THREE.Group()
  group.name = name
  group.position.set(px, py, 0)

  const buckets: [THREE.BufferGeometry[], THREE.MeshStandardMaterial, boolean][] = [
    [kit.armor, mats.armor, true],
    [kit.hull, mats.hull, true],
    [kit.plate, mats.plate, false],
    [kit.trim, mats.trim, false],
  ]
  for (let i = 0; i < buckets.length; i++) {
    const [geoms, mat, casts] = buckets[i]
    const mesh = mergeMesh(geoms, mat, `${name}:${PART_LABELS[i]}`)
    if (!mesh) continue
    // Every part above is authored in soldier-root metres (0 = the feet);
    // pull it back onto the joint so rotating the group swings the limb
    // instead of orbiting it around the character's ankles.
    mesh.geometry.translate(-px, -py, 0)
    mesh.receiveShadow = true
    // Only the two mass-carrying materials cast: the silhouette is identical
    // and it halves this soldier's cost in the shadow pass.
    mesh.castShadow = casts
    group.add(mesh)
  }
  return group
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
 *
 * The body is split into five articulated groups (two legs, two arms, and an
 * upper body that carries the head and the arms) so updateSoldier can run a
 * procedural walk cycle and an aim pitch on it. Geometry inside each group is
 * still merged per material, which costs ~15 draw calls per soldier instead
 * of the ~200 an unmerged build would -- the four body materials plus the
 * visor are shared across every group, so the split adds draw calls only,
 * never material state.
 *
 * Built once per remote player at match_start and mutated in place by
 * updateSoldier() every frame -- never recreated. Materials are per-soldier
 * (camo, the death fade and the spawn-protection pulse all mutate them per
 * player) but share the library's textures, which is safe because every
 * soldier is disposed together at teardown.
 */
export function makeSoldier(team: Team, lib: MaterialLibrary): THREE.Group {
  const group = new THREE.Group()
  // Yaw first, then the death tip about the soldier's OWN sideways axis --
  // the default XYZ order would tip him about world X and drop him sideways
  // at every facing but due north.
  group.rotation.order = 'YXZ'

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
  // Same emissive-floor trick as armorMat above: legs and arms route mostly
  // through hull, and the helmet dome is plate -- without a floor those parts
  // of the silhouette go black in shadow and the soldier reads as a floating
  // torso.
  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x3a4356,
    emissive: 0x3a4356,
    emissiveIntensity: 0.2,
    map: lib.panelTex,
    roughness: 0.68,
    metalness: 0.15,
    transparent: true,
  })
  const plateMat = new THREE.MeshStandardMaterial({
    color: 0xa9b6cc,
    emissive: 0xa9b6cc,
    emissiveIntensity: 0.18,
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

  const mats: Mats = { armor: armorMat, hull: hullMat, plate: plateMat, trim: trimMat }

  const torsoKit = newKit()
  addTorso(torsoKit)
  const upper = buildSegment(torsoKit, mats, 'upper', 0, WAIST_Y)

  const visor = new THREE.Mesh(
    boxGeom(0.31, 0.12, 0.09, 0, PLAYER_HEAD_CENTER_Y + 0.02 - WAIST_Y, 0.2),
    visorMat
  )
  visor.name = 'visor'
  upper.add(visor)

  const arms: THREE.Group[] = []
  const legs: THREE.Group[] = []
  for (const side of [-1, 1]) {
    const armKit = newKit()
    addArm(armKit, side)
    const arm = buildSegment(armKit, mats, `arm${side}`, side * SHOULDER_X, SHOULDER_Y)
    // Parented to the torso, so its own joint is measured from the waist.
    arm.position.y -= WAIST_Y
    upper.add(arm)
    arms.push(arm)

    const legKit = newKit()
    addLeg(legKit, side)
    const leg = buildSegment(legKit, mats, `leg${side}`, side * HIP_X, HIP_Y)
    group.add(leg)
    legs.push(leg)
  }
  group.add(upper)

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

  const materials = [armorMat, hullMat, plateMat, trimMat]
  const data: SoldierData = {
    materials,
    visorMat,
    emissiveBase: [...materials, visorMat].map((m) => m.emissiveIntensity),
    upper,
    legs,
    arms,
    flagProp,
    flagMat,
    nameSprite,
    nameMat,
    lastName: '',
    phase: 0,
    swing: 0,
    deathT: -1,
    wasAlive: false,
    lastT: -1,
    protMult: 1,
  }
  group.userData.soldier = data

  return group
}

/** Tip angle of the death collapse: an ease-out to face-down with a short
 * settle bounce that dies out as the body lands. */
function tipAngle(deathT: number): number {
  const t = Math.min(1, deathT / TIP_TIME)
  const eased = 1 - (1 - t) * (1 - t)
  return (Math.PI / 2) * (eased + Math.sin(t * Math.PI * 3) * TIP_BOUNCE * (1 - t))
}

/** Back to a standing, un-tipped, mid-stride-free pose. Called on the frame a
 * dead soldier comes back alive -- the collapse leaves the root tipped and
 * the limbs frozen wherever the last walk frame put them. */
function resetPose(group: THREE.Group, data: SoldierData): void {
  data.deathT = -1
  data.phase = 0
  data.swing = 0
  group.rotation.x = 0
  data.upper.rotation.x = 0
  for (const leg of data.legs) leg.rotation.x = 0
  for (const arm of data.arms) arm.rotation.x = 0
}

/** Procedural walk cycle + aim pitch. Legs swing opposed about the hips, the
 * arms counter-swing a fraction of that (they are locked into a two-handed
 * grip on a weapon the torso carries, so a full swing would tear the hands
 * off it), and the upper body pitches so an enemy visibly aims up or down. */
function animatePose(data: SoldierData, snap: SnapPlayer, dt: number): void {
  const speed = Math.hypot(snap.vel.x, snap.vel.z)
  data.phase += speed * dt * STRIDE_PER_METRE
  const target = Math.min(SPRINT_SPEED_MULT, speed / MOVE_SPEED)
  data.swing = decayTo(data.swing, target, dt, SWING_TAU)

  const stride = Math.sin(data.phase) * data.swing
  data.legs[0].rotation.x = stride * LEG_SWING
  data.legs[1].rotation.x = -stride * LEG_SWING
  data.arms[0].rotation.x = -stride * ARM_SWING
  data.arms[1].rotation.x = stride * ARM_SWING

  data.upper.rotation.x = -Math.max(-AIM_PITCH_MAX, Math.min(AIM_PITCH_MAX, snap.pitch))
}

/** Mutates `group` (built by makeSoldier) to match one snapshot frame:
 * position/yaw, walk cycle and aim pitch while alive, a collapse-then-fade on
 * death, translucent when camo'd, an emissive pulse while spawn-protected,
 * flag rig shown for the carried team's color, and a name sprite for humans
 * only (bots never get one -- brief calls for "name sprites for humans
 * only").
 *
 * Its own frame delta comes from performance.now() rather than a dt argument:
 * every animation here is client-side cosmetics keyed to one soldier, and the
 * caller's render loop has no per-soldier clock to hand down. Clamped to
 * MAX_FRAME_DT so a backgrounded tab does not integrate a minute of walk
 * cycle on the frame it returns. */
export function updateSoldier(group: THREE.Group, snap: SnapPlayer): void {
  const data = group.userData.soldier as SoldierData
  const now = performance.now() / 1000
  const dt = data.lastT < 0 ? 0 : Math.min(MAX_FRAME_DT, now - data.lastT)
  data.lastT = now

  if (snap.alive) {
    if (!data.wasAlive) resetPose(group, data)
    data.wasAlive = true
    group.visible = true
    group.position.set(snap.pos.x, snap.pos.y, snap.pos.z)
    group.rotation.y = snap.yaw
    animatePose(data, snap, dt)
  } else {
    if (data.wasAlive) {
      data.wasAlive = false
      data.deathT = 0
    }
    // deathT < 0 here means the collapse already finished (or this soldier
    // joined already dead) -- nothing left to animate.
    if (data.deathT < 0) {
      group.visible = false
      return
    }
    // The body stays where it fell: position/yaw are deliberately not
    // re-read, so a corpse does not slide toward the respawn point.
    data.deathT += dt
    group.rotation.x = tipAngle(data.deathT)
    if (data.deathT >= FADE_DELAY + FADE_TIME) {
      data.deathT = -1
      group.visible = false
      return
    }
  }

  const fade =
    data.deathT < 0 ? 1 : 1 - Math.max(0, Math.min(1, (data.deathT - FADE_DELAY) / FADE_TIME))
  const opacity = (snap.camo ? CAMO_OPACITY : 1) * fade
  for (const mat of data.materials) mat.opacity = opacity
  data.visorMat.opacity = opacity
  data.flagMat.opacity = opacity

  // Spawn protection reads as a shimmer rather than a badge: the same team
  // colour the soldier already wears, breathing. Skipped entirely (one float
  // compare) once the multiplier has settled back to its authored floor.
  const protMult = snap.prot ? 1 + PROT_PULSE * (0.5 + 0.5 * Math.sin(now * PROT_RATE)) : 1
  if (protMult !== data.protMult) {
    data.protMult = protMult
    for (let i = 0; i < data.materials.length; i++) {
      data.materials[i].emissiveIntensity = data.emissiveBase[i] * protMult
    }
    data.visorMat.emissiveIntensity = data.emissiveBase[data.materials.length] * protMult
  }

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
