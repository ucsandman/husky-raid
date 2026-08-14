import { randomUUID } from 'node:crypto'
import { HostedMatch } from './match'
import { TEAM_SIZE } from '@riftlane/shared'
import type { ClientMsg, PlayerInput, ServerMsg, Team } from '@riftlane/shared'

export type SendFn = (msg: ServerMsg) => void

/** A-Z minus I/O (visually ambiguous with 1/0 in a 4-letter room code). */
const ROOM_CODE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((c) => c !== 'I' && c !== 'O')
const ROOM_CODE_LENGTH = 4

const MAP_ROTATION = ['gutter', 'hairpin']
const ROOM_SIZE = TEAM_SIZE * 2

const QUEUE_MAX_WAIT_MS = 10_000
const QUEUE_INSTANT_HUMANS = ROOM_SIZE

/** How long a dropped player's slot in a live match is held open for them.
 * A stand-in bot plays it meanwhile, so the match never pauses and the other
 * players never wait. Long enough to cover a free-tier host waking up. */
const RESUME_GRACE_MS = 60_000

/** A suspended player's messages go nowhere until their next socket arrives. */
const DISCARD: SendFn = () => {}

interface PlayerConn {
  id: string
  name: string
  send: SendFn
  roomCode: string | null
  /** Bearer token that lets this player's NEXT socket reclaim their slot.
   * Deliberately not the playerId, which is broadcast to every other client
   * in rosters and snapshots and so would let anyone steal the seat. */
  resumeToken: string
  /** Set while the socket is gone but the match slot is still theirs. */
  suspended: { botId: string; team: Team; expiresAt: number } | null
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
  /** resume token -> playerId, for players whose seat is being held. */
  private readonly playerByToken = new Map<string, string>()
  private mapIndex = 0
  private readonly queueTimer: ReturnType<typeof setInterval>

  constructor(rand: () => number = Math.random, nowFn: () => number = () => Date.now(), queueIntervalMs = 1000) {
    this.rand = rand
    this.nowFn = nowFn
    this.queueTimer = setInterval(() => {
      this.expireSuspended()
      this.checkQueue()
    }, queueIntervalMs)
  }

  /** Stops the queue timer and every running match. Call on shutdown (and in
   * tests, to avoid leaking timers). Matches are stopped explicitly now that
   * a room outlives its last human for RESUME_GRACE_MS -- it no longer
   * self-destructs the moment everyone drops. */
  stop(): void {
    clearInterval(this.queueTimer)
    for (const room of this.rooms.values()) room.match?.stop()
  }

  matchCount(): number {
    let n = 0
    for (const room of this.rooms.values()) if (room.match && !room.matchEnded) n++
    return n
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code)
  }

  /** Registers a socket. Returns the token that this player's next socket can
   * present to `resume()` after a drop. */
  connect(playerId: string, name: string, send: SendFn): string {
    const resumeToken = randomUUID()
    this.players.set(playerId, { id: playerId, name, send, roomCode: null, resumeToken, suspended: null })
    this.playerByToken.set(resumeToken, playerId)
    return resumeToken
  }

  /** A socket went away. If the player was in a live match their seat is held
   * open (see RESUME_GRACE_MS) instead of being given up, because the drop is
   * usually the network blinking, not the player leaving. */
  disconnect(playerId: string): void {
    const player = this.players.get(playerId)
    if (!player) return
    this.removeFromQueue(playerId)

    const room = player.roomCode ? this.rooms.get(player.roomCode) : undefined
    const inLiveMatch = !!room?.match && !room.matchEnded && room.match.sim.players.has(playerId)
    if (room?.match && inLiveMatch) {
      const team = room.match.sim.players.get(playerId)?.team ?? 0
      // The stand-in already inherits their kills/deaths/captures, so the
      // scoreboard doesn't visibly lose a player mid-match.
      const standIn = room.match.removeHuman(playerId)
      player.send = DISCARD
      player.suspended = { botId: standIn.id, team, expiresAt: this.nowFn() + RESUME_GRACE_MS }
      return
    }

    this.forget(player)
  }

  /** Gives up a player's seat for good: leaves the room (stopping the match
   * and deleting the room if they were the last one in it) and invalidates
   * their resume token. */
  private forget(player: PlayerConn): void {
    if (player.roomCode) this.leaveRoom(player.id, player.roomCode)
    this.playerByToken.delete(player.resumeToken)
    this.players.delete(player.id)
  }

  /**
   * Puts a returning player back into the match they dropped out of, on the
   * same team and with the score their stand-in kept warm. Returns their
   * playerId, or null when the token is unknown, already spent, expired, or
   * its match is over -- in which case the caller treats them as brand new.
   */
  resume(token: string, send: SendFn): string | null {
    const playerId = this.playerByToken.get(token)
    const player = playerId ? this.players.get(playerId) : undefined
    if (!player?.suspended) return null

    const room = player.roomCode ? this.rooms.get(player.roomCode) : undefined
    if (!room?.match || room.matchEnded || this.nowFn() > player.suspended.expiresAt) {
      this.forget(player)
      return null
    }

    const { botId, team } = player.suspended
    const standIn = room.match.sim.players.get(botId)
    const carried = standIn
      ? { kills: standIn.kills, deaths: standIn.deaths, captures: standIn.captures }
      : null
    room.match.removeBot(botId)

    player.suspended = null
    player.send = send
    const restored = room.match.addHuman(player.id, player.name, team)
    if (carried) Object.assign(restored, carried)

    this.sendMatchStart(room, player.id)
    return player.id
  }

  /** Seats held for players who never came back are released here. */
  private expireSuspended(): void {
    const now = this.nowFn()
    for (const player of [...this.players.values()]) {
      if (player.suspended && now > player.suspended.expiresAt) this.forget(player)
    }
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
    // Trust-boundary guard (fix 3): code arrives as untrusted client JSON,
    // so its shape is checked before it's used as a lookup key at all.
    if (typeof code !== 'string' || !/^[A-Z]{4}$/.test(code)) {
      return this.sendError(player, 'invalid room code')
    }
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
    // A player whose seat is only being held can't vote, so they mustn't
    // count toward the majority they'd have to beat either.
    const humanCount = [...room.memberIds].filter((id) => !this.players.get(id)?.suspended).length
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
    // Bots fill empty slots, so anyone who has waited out the timer gets a
    // match even alone (README: "as few as one human player").
    const shouldStart = this.queue.length >= QUEUE_INSTANT_HUMANS || waitedCount >= 1
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
