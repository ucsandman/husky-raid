import { HostedMatch } from './match'
import { TEAM_SIZE } from '@riftlane/shared'
import type { ClientMsg, PlayerInput, ServerMsg, Team } from '@riftlane/shared'

export type SendFn = (msg: ServerMsg) => void

/** A-Z minus I/O (visually ambiguous with 1/0 in a 4-letter room code). */
const ROOM_CODE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((c) => c !== 'I' && c !== 'O')
const ROOM_CODE_LENGTH = 4

const MAP_ROTATION = ['gutter', 'hairpin']
const ROOM_SIZE = TEAM_SIZE * 2

const QUEUE_MIN_HUMANS = 2
const QUEUE_MAX_WAIT_MS = 10_000
const QUEUE_INSTANT_HUMANS = ROOM_SIZE

interface PlayerConn {
  id: string
  name: string
  send: SendFn
  roomCode: string | null
}

interface QueueEntry {
  id: string
  joinedAt: number
}

export interface Room {
  code: string
  hostId: string
  memberIds: Set<string>
  match: HostedMatch | null
  matchEnded: boolean
  rematchVotes: Set<string>
}

/**
 * Transport-agnostic lobby: rooms, quick-play queue, and match lifecycle.
 * Knows nothing about sockets -- connect()/disconnect()/handle() take a
 * plain send callback so net.ts (and tests) can drive it identically.
 */
export class Lobby {
  private readonly rand: () => number
  private readonly nowFn: () => number
  private readonly players = new Map<string, PlayerConn>()
  private readonly rooms = new Map<string, Room>()
  private readonly queue: QueueEntry[] = []
  private mapIndex = 0
  private readonly queueTimer: ReturnType<typeof setInterval>

  constructor(rand: () => number = Math.random, nowFn: () => number = () => Date.now(), queueIntervalMs = 1000) {
    this.rand = rand
    this.nowFn = nowFn
    this.queueTimer = setInterval(() => this.checkQueue(), queueIntervalMs)
  }

  /** Stops the queue timer. Call on shutdown (and in tests, to avoid leaking timers). */
  stop(): void {
    clearInterval(this.queueTimer)
  }

  matchCount(): number {
    let n = 0
    for (const room of this.rooms.values()) if (room.match && !room.matchEnded) n++
    return n
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code)
  }

  connect(playerId: string, name: string, send: SendFn): void {
    this.players.set(playerId, { id: playerId, name, send, roomCode: null })
  }

  disconnect(playerId: string): void {
    const player = this.players.get(playerId)
    if (!player) return
    this.removeFromQueue(playerId)
    if (player.roomCode) this.leaveRoom(playerId, player.roomCode)
    this.players.delete(playerId)
  }

  handle(playerId: string, msg: ClientMsg): void {
    const player = this.players.get(playerId)
    if (!player) return
    switch (msg.t) {
      case 'create_room':
        return this.onCreateRoom(player)
      case 'join_room':
        return this.onJoinRoom(player, msg.code)
      case 'start_match':
        return this.onStartMatch(player)
      case 'quick_play':
        return this.onQuickPlay(player)
      case 'leave':
        return this.onLeave(player)
      case 'input':
        return this.onInput(player, msg.input)
      case 'rematch_vote':
        return this.onRematchVote(player)
      case 'hello':
        return // handled by the transport before reaching the lobby
    }
  }

  // ---- room lifecycle ----------------------------------------------------

  private onCreateRoom(player: PlayerConn): void {
    if (player.roomCode) this.leaveRoom(player.id, player.roomCode)
    const code = this.generateRoomCode()
    const room: Room = {
      code,
      hostId: player.id,
      memberIds: new Set([player.id]),
      match: null,
      matchEnded: false,
      rematchVotes: new Set(),
    }
    this.rooms.set(code, room)
    player.roomCode = code
    this.broadcastRoom(room)
  }

  private onJoinRoom(player: PlayerConn, code: string): void {
    const room = this.rooms.get(code)
    if (!room) return this.sendError(player, 'room not found')
    if (player.roomCode === code) return

    if (room.match && !room.matchEnded) {
      const botId = [...room.match.sim.players.values()].find((p) => p.bot)?.id
      if (!botId) return this.sendError(player, 'room full')
      if (player.roomCode) this.leaveRoom(player.id, player.roomCode)
      room.match.removeBot(botId)
      room.match.addHuman(player.id, player.name)
      room.memberIds.add(player.id)
      player.roomCode = code
      this.sendMatchStart(room, player.id)
      return
    }

    if (room.memberIds.size >= ROOM_SIZE) return this.sendError(player, 'room full')
    if (player.roomCode) this.leaveRoom(player.id, player.roomCode)
    room.memberIds.add(player.id)
    player.roomCode = code
    this.broadcastRoom(room)
  }

  private onStartMatch(player: PlayerConn): void {
    const room = player.roomCode ? this.rooms.get(player.roomCode) : undefined
    if (!room) return this.sendError(player, 'not in a room')
    if (room.hostId !== player.id) return this.sendError(player, 'only the host can start the match')
    if (room.match && !room.matchEnded) return this.sendError(player, 'match already in progress')
    this.launchMatch(room, [...room.memberIds])
  }

  private onLeave(player: PlayerConn): void {
    if (player.roomCode) this.leaveRoom(player.id, player.roomCode)
  }

  private onInput(player: PlayerConn, input: PlayerInput): void {
    const room = player.roomCode ? this.rooms.get(player.roomCode) : undefined
    room?.match?.handleInput(player.id, input)
  }

  private onRematchVote(player: PlayerConn): void {
    const room = player.roomCode ? this.rooms.get(player.roomCode) : undefined
    if (!room || !room.match || !room.matchEnded) return
    if (!room.memberIds.has(player.id)) return
    room.rematchVotes.add(player.id)
    const humanCount = room.memberIds.size
    if (humanCount > 0 && room.rematchVotes.size * 2 > humanCount) {
      room.match.stop()
      this.launchMatch(room, [...room.memberIds])
    }
  }

  private leaveRoom(playerId: string, code: string): void {
    const room = this.rooms.get(code)
    if (!room) return
    const player = this.players.get(playerId)
    if (player) player.roomCode = null

    if (room.match && !room.matchEnded && room.match.sim.players.has(playerId)) {
      room.match.removeHuman(playerId)
    }
    room.memberIds.delete(playerId)
    // A departed player's rematch vote no longer counts -- otherwise a
    // stale vote from someone who left could out-live them and later tip
    // a majority computed against the (now smaller) remaining membership.
    room.rematchVotes.delete(playerId)

    if (room.memberIds.size === 0) {
      room.match?.stop()
      this.rooms.delete(code)
      return
    }
    if (room.hostId === playerId) {
      const next = room.memberIds.values().next().value
      if (next) room.hostId = next
    }
  }

  // ---- quick play ---------------------------------------------------------

  private onQuickPlay(player: PlayerConn): void {
    if (player.roomCode) this.leaveRoom(player.id, player.roomCode)
    if (this.queue.some((q) => q.id === player.id)) return
    this.queue.push({ id: player.id, joinedAt: this.nowFn() })
    player.send({ t: 'queue', position: this.queue.length })
    this.checkQueue()
  }

  private removeFromQueue(playerId: string): void {
    const idx = this.queue.findIndex((q) => q.id === playerId)
    if (idx >= 0) this.queue.splice(idx, 1)
  }

  private checkQueue(): void {
    if (this.queue.length === 0) return
    const now = this.nowFn()
    const waitedCount = this.queue.filter((q) => now - q.joinedAt >= QUEUE_MAX_WAIT_MS).length
    const shouldStart = this.queue.length >= QUEUE_INSTANT_HUMANS || waitedCount >= QUEUE_MIN_HUMANS
    if (!shouldStart) return

    const entries = this.queue.splice(0, ROOM_SIZE)
    const humanIds = entries.map((e) => e.id).filter((id) => this.players.has(id))
    if (humanIds.length === 0) return

    const code = this.generateRoomCode()
    const room: Room = {
      code,
      hostId: humanIds[0],
      memberIds: new Set(humanIds),
      match: null,
      matchEnded: false,
      rematchVotes: new Set(),
    }
    this.rooms.set(code, room)
    for (const id of humanIds) {
      const p = this.players.get(id)
      if (p) p.roomCode = code
    }
    this.launchMatch(room, humanIds)
  }

  // ---- match creation -------------------------------------------------------

  private launchMatch(room: Room, humanIds: string[]): void {
    const mapName = this.nextMap()
    const seed = Math.floor(this.rand() * 0x7fffffff)
    const match = new HostedMatch(mapName, seed, (id, msg) => this.routeToRoom(room, id, msg))
    for (const id of humanIds) {
      const p = this.players.get(id)
      if (p) match.addHuman(id, p.name)
    }
    while (match.sim.players.size < ROOM_SIZE) match.addBot()

    room.match = match
    room.matchEnded = false
    room.rematchVotes = new Set()
    match.start()

    for (const id of humanIds) this.sendMatchStart(room, id)
  }

  private routeToRoom(room: Room, playerId: string, msg: ServerMsg): void {
    if (msg.t === 'match_end') room.matchEnded = true
    this.players.get(playerId)?.send(msg)
  }

  private sendMatchStart(room: Room, playerId: string): void {
    const player = this.players.get(playerId)
    const match = room.match
    if (!player || !match) return
    const roster = [...match.sim.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, bot: p.bot }))
    player.send({ t: 'match_start', mapName: match.sim.map.name, yourId: playerId, players: roster })
  }

  // ---- helpers --------------------------------------------------------------

  private sendError(player: PlayerConn, message: string): void {
    player.send({ t: 'error', message })
  }

  private broadcastRoom(room: Room): void {
    // team here is cosmetic/non-authoritative -- just an even split for the
    // pre-match roster display. Real team assignment happens in
    // HostedMatch.addHuman/addBot (pickTeam()) once the match starts.
    const roster = [...room.memberIds].map((id, i) => ({
      id,
      name: this.players.get(id)?.name ?? '',
      team: (i % 2) as Team,
      bot: false,
    }))
    const msg: ServerMsg = { t: 'room', code: room.code, players: roster, hostId: room.hostId }
    for (const id of room.memberIds) this.players.get(id)?.send(msg)
  }

  private generateRoomCode(): string {
    let code: string
    do {
      code = Array.from(
        { length: ROOM_CODE_LENGTH },
        () => ROOM_CODE_LETTERS[Math.floor(this.rand() * ROOM_CODE_LETTERS.length)]
      ).join('')
    } while (this.rooms.has(code))
    return code
  }

  private nextMap(): string {
    const m = MAP_ROTATION[this.mapIndex % MAP_ROTATION.length]
    this.mapIndex++
    return m
  }
}
