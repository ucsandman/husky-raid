import type { PlayerInput, PlayerState } from '../src/types'
import { MAPS } from '../src/maps'
import { MAX_HEALTH, MAX_SHIELD, TICK_DT } from '../src/constants'

export function makeTestPlayer(overrides?: Partial<PlayerState>): PlayerState {
  const spawn = MAPS.gutter.spawns[0][0]
  return {
    id: 'p1',
    name: 'Test',
    team: 0,
    bot: false,
    pos: { ...spawn },
    vel: { x: 0, y: 0, z: 0 },
    yaw: MAPS.gutter.spawnYaw[0],
    pitch: 0,
    grounded: true,
    shield: MAX_SHIELD,
    health: MAX_HEALTH,
    alive: true,
    respawnAt: 0,
    lastDamageAt: 0,
    weapons: ['sidearm', 'pulse_smg'],
    activeWeapon: 0,
    ammo: [0, 0],
    cooldownUntil: 0,
    grenadeCooldownUntil: 0,
    grenades: { frag: 0, mag: 0 },
    equipment: null,
    equipmentCharges: 0,
    equipmentCooldownUntil: 0,
    swapCooldownUntil: 0,
    meleeCooldownUntil: 0,
    camoUntil: 0,
    carryingFlag: null,
    stuckDarts: 0,
    kills: 0,
    deaths: 0,
    captures: 0,
    teleportCooldownUntil: 0,
    sprinting: false,
    sliding: false,
    slideTimeRemaining: 0,
    slideCooldownRemaining: 0,
    coyoteTimeRemaining: 0,
    jumpBufferRemaining: 0,
    scoped: false,
    ...overrides,
  }
}

export function makeInput(overrides?: Partial<PlayerInput>): PlayerInput {
  return {
    seq: 0,
    dt: TICK_DT,
    yaw: 0,
    pitch: 0,
    forward: 0,
    strafe: 0,
    jump: false,
    fire: false,
    melee: false,
    grenade: false,
    equipment: false,
    swap: false,
    ...overrides,
  }
}
