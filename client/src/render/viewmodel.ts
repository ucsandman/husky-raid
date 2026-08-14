import * as THREE from 'three'
import type { WeaponId } from '@riftlane/shared'
import { WEAPONS } from '@riftlane/shared'
import type { MaterialLibrary } from './materials'
import { boxGeom, mergeMesh } from './worldKit'

const WEAPON_ORDER: WeaponId[] = [
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

interface Parts {
  shell: THREE.BufferGeometry[]
  metal: THREE.BufferGeometry[]
  glow: THREE.BufferGeometry[]
  muzzleZ: number
  muzzleY: number
}

function accentColor(id: WeaponId): number {
  const idx = Math.max(0, WEAPON_ORDER.indexOf(id))
  return new THREE.Color().setHSL(idx / WEAPON_ORDER.length, 0.72, 0.55).getHex()
}

function cyl(r0: number, r1: number, h: number, seg: number): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(r0, r1, h, seg)
}

/** Barrel-aligned cylinder: authored along -Z, the direction the camera-
 * parented viewmodel rig points. */
function tube(r0: number, r1: number, len: number, z: number, y: number, seg = 10): THREE.BufferGeometry {
  return cyl(r0, r1, len, seg).rotateX(Math.PI / 2).translate(0, y, z)
}

function rifleParts(compact: boolean): Parts {
  const p: Parts = { shell: [], metal: [], glow: [], muzzleZ: compact ? -0.46 : -0.58, muzzleY: 0.005 }
  const reach = compact ? 0.85 : 1

  p.shell.push(boxGeom(0.095, 0.115, 0.36, 0, 0, -0.02))
  p.shell.push(boxGeom(0.075, 0.085, 0.24 * reach, 0, -0.005, -0.26 * reach))
  p.shell.push(boxGeom(0.055, 0.15, 0.075, 0, -0.12, -0.05))
  const grip = boxGeom(0.052, 0.15, 0.065, 0, 0, 0)
  grip.rotateX(0.3)
  grip.translate(0, -0.11, 0.07)
  p.shell.push(grip)
  if (!compact) p.shell.push(boxGeom(0.06, 0.095, 0.17, 0, -0.012, 0.21))

  p.metal.push(tube(0.019, 0.019, 0.24 * reach, -0.4 * reach, 0.005))
  p.metal.push(tube(0.034, 0.03, 0.065, p.muzzleZ + 0.03, 0.005))
  p.metal.push(boxGeom(0.05, 0.03, 0.32, 0, 0.075, -0.06))
  p.metal.push(boxGeom(0.045, 0.055, 0.05, 0, 0.105, -0.15))
  p.metal.push(boxGeom(0.028, 0.028, 0.03, 0, 0.1, 0.13))

  p.glow.push(boxGeom(0.028, 0.018, 0.02, 0, 0.105, -0.175))
  for (const s of [-1, 1]) {
    p.glow.push(boxGeom(0.006, 0.02, 0.2, s * 0.049, 0.005, -0.08))
    for (let v = 0; v < 3; v++) {
      p.glow.push(boxGeom(0.005, 0.035, 0.025, s * 0.039, -0.005, -0.2 * reach - v * 0.06))
    }
  }
  p.glow.push(boxGeom(0.03, 0.012, 0.09, 0, -0.062, -0.02))

  return p
}

function launcherParts(): Parts {
  const p: Parts = { shell: [], metal: [], glow: [], muzzleZ: -0.6, muzzleY: 0.01 }

  p.shell.push(boxGeom(0.13, 0.14, 0.32, 0, 0.005, 0.02))
  p.shell.push(boxGeom(0.1, 0.1, 0.16, 0, -0.09, 0.16))
  const grip = boxGeom(0.06, 0.16, 0.07, 0, 0, 0)
  grip.rotateX(0.28)
  grip.translate(0, -0.12, 0.1)
  p.shell.push(grip)
  p.shell.push(cyl(0.075, 0.075, 0.2, 10).rotateZ(Math.PI / 2).translate(0, 0.11, 0.02))

  p.metal.push(tube(0.062, 0.082, 0.34, -0.36, 0.01, 12))
  p.metal.push(new THREE.TorusGeometry(0.085, 0.017, 6, 16).translate(0, 0.01, p.muzzleZ + 0.04))
  p.metal.push(new THREE.TorusGeometry(0.072, 0.013, 6, 14).translate(0, 0.01, -0.3))
  p.metal.push(boxGeom(0.05, 0.035, 0.28, 0, 0.095, -0.12))

  p.glow.push(new THREE.SphereGeometry(0.045, 10, 8).translate(0, 0.02, -0.09))
  for (const s of [-1, 1]) {
    p.glow.push(boxGeom(0.008, 0.026, 0.22, s * 0.072, 0.01, -0.05))
    p.glow.push(boxGeom(0.03, 0.03, 0.008, s * 0.045, 0.11, -0.09))
  }
  p.glow.push(boxGeom(0.04, 0.014, 0.11, 0, 0.088, -0.24))

  return p
}

function bladeParts(): Parts {
  const p: Parts = { shell: [], metal: [], glow: [], muzzleZ: -0.5, muzzleY: 0.01 }

  p.shell.push(boxGeom(0.055, 0.07, 0.24, 0, -0.01, 0.14))
  p.shell.push(boxGeom(0.19, 0.05, 0.07, 0, 0, -0.01))
  p.shell.push(boxGeom(0.06, 0.13, 0.05, 0, -0.07, 0.22))

  const core = new THREE.ConeGeometry(0.075, 0.62, 4)
  core.scale(0.42, 1, 1)
  core.rotateX(-Math.PI / 2)
  core.translate(0, 0.01, -0.33)
  p.metal.push(core)
  p.metal.push(boxGeom(0.09, 0.035, 0.07, 0, 0.02, -0.06))

  p.glow.push(boxGeom(0.012, 0.028, 0.5, 0, 0.012, -0.3))
  p.glow.push(boxGeom(0.14, 0.02, 0.02, 0, 0.026, -0.02))
  for (const s of [-1, 1]) p.glow.push(boxGeom(0.012, 0.022, 0.14, s * 0.026, -0.01, 0.12))

  return p
}

/**
 * Authored first-person weapon, one of three families keyed off
 * WeaponDef.kind so all ten ids read as distinct hardware without ten
 * hand-built models: power_melee gets an energy blade, projectile/charge a
 * heavy launcher, hitscan/burst a rifle (short-barrelled for the sidearm and
 * the SMG). Each family merges to three meshes plus an additive muzzle
 * flare, which game.ts pulses from the fire kick.
 */
export function buildViewmodel(id: WeaponId, lib: MaterialLibrary): THREE.Group {
  const def = WEAPONS[id]
  const group = new THREE.Group()
  group.name = `viewmodel:${id}`
  const accent = accentColor(id)

  const parts =
    def.kind === 'power_melee'
      ? bladeParts()
      : def.kind === 'projectile' || def.kind === 'charge'
        ? launcherParts()
        : rifleParts(id === 'sidearm' || id === 'pulse_smg')

  // The viewmodel hangs off the camera, so which way the sun hits it is
  // whatever the player happens to be facing. A low emissive floor keeps the
  // hardware readable when the player turns away from the key light, without
  // a camera-parented light that would also blow out nearby world geometry.
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x39414f,
    map: lib.panelTex,
    emissive: 0x161c28,
    emissiveIntensity: 1,
    roughness: 0.6,
    metalness: 0.5,
  })
  const metalMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent).lerp(new THREE.Color(0xa7b3c6), 0.5).getHex(),
    emissive: new THREE.Color(accent).multiplyScalar(0.14).getHex(),
    emissiveIntensity: 1,
    roughness: 0.3,
    metalness: 0.8,
  })
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x090d14,
    emissive: accent,
    emissiveIntensity: 1.5,
    roughness: 0.35,
  })

  const shell = mergeMesh(parts.shell, shellMat, 'shell')
  const metal = mergeMesh(parts.metal, metalMat, 'metal')
  const glow = mergeMesh(parts.glow, glowMat, 'glow')
  for (const mesh of [shell, metal, glow]) {
    if (mesh) group.add(mesh)
  }

  const flareMat = new THREE.MeshBasicMaterial({
    map: lib.glowTex,
    color: accent,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const flare = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), flareMat)
  flare.position.set(0, parts.muzzleY, parts.muzzleZ - 0.02)
  flare.renderOrder = 20
  flare.name = 'muzzleFlare'
  group.add(flare)

  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), glowMat)
  tip.position.set(0, parts.muzzleY, parts.muzzleZ)
  group.add(tip)

  group.userData.flare = flare
  group.scale.setScalar(0.8)
  return group
}

/** Drives the muzzle flare from the shot kick (1 = recovered, 0 = just
 * fired). Mutates one material's opacity and one scale -- no allocation. */
export function setViewmodelFlare(group: THREE.Group, kickT: number): void {
  const flare = group.userData.flare as THREE.Mesh | undefined
  if (!flare) return
  const t = Math.max(0, 1 - kickT)
  const mat = flare.material as THREE.MeshBasicMaterial
  mat.opacity = t * t * 1.6
  flare.visible = t > 0.01
  const s = 0.55 + t * 0.9
  flare.scale.set(s, s, 1)
  flare.rotation.z += 0.6
}
