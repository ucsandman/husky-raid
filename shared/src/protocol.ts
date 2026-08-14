import type { PlayerInput, PlayerState, Team, Vec3, WeaponId } from './types'
import type { FlagState, SimEvent } from './sim'
import type { Projectile } from './combat'

export type ClientMsg =
  | { t: 'hello'; name: string }
  | { t: 'create_room' }
  | { t: 'join_room'; code: string }
  | { t: 'quick_play' }
  | { t: 'leave' }
  | { t: 'start_match' }
  | { t: 'input'; input: PlayerInput }
  | { t: 'rematch_vote' }

export type ServerMsg =
  | { t: 'welcome'; playerId: string }
  | { t: 'room'; code: string; players: { id: string; name: string; team: Team; bot: boolean }[]; hostId: string }
  | { t: 'queue'; position: number }
  | {
      t: 'match_start'
      mapName: string
      yourId: string
      players: { id: string; name: string; team: Team; bot: boolean }[]
    }
  | {
      t: 'snapshot'
      tick: number
      ackSeq: number
      time: number
      players: SnapPlayer[]
      projectiles: SnapProjectile[]
      flags: FlagState[]
      scores: [number, number]
      timeLeft: number
      events: SimEvent[]
    }
  | {
      t: 'match_end'
      winner: Team | null
      scores: [number, number]
      board: { name: string; kills: number; deaths: number; captures: number }[]
    }
  | { t: 'error'; message: string }

/** Over-the-wire subset of PlayerState -- server-authoritative fields the
 * client needs to render/predict a remote player, nothing more. */
export interface SnapPlayer {
  id: string
  team: Team
  bot: boolean
  name: string
  pos: Vec3
  vel: Vec3
  yaw: number
  pitch: number
  alive: boolean
  shield: number
  health: number
  weapons: [WeaponId, WeaponId]
  activeWeapon: 0 | 1
  camo: boolean
  carryingFlag: Team | null
}

export interface SnapProjectile {
  id: number
  kind: Projectile['kind']
  pos: Vec3
  vel: Vec3
}

export function toSnapPlayer(p: PlayerState, now: number): SnapPlayer {
  return {
    id: p.id,
    team: p.team,
    bot: p.bot,
    name: p.name,
    pos: p.pos,
    vel: p.vel,
    yaw: p.yaw,
    pitch: p.pitch,
    alive: p.alive,
    shield: p.shield,
    health: p.health,
    weapons: p.weapons,
    activeWeapon: p.activeWeapon,
    camo: p.camoUntil > now,
    carryingFlag: p.carryingFlag,
  }
}
