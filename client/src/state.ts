import type { Team } from '@riftlane/shared'

export type Phase = 'menu' | 'lobby' | 'queue' | 'playing' | 'ended'

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'disconnected'

export interface RosterPlayer {
  id: string
  name: string
  team: Team
  bot: boolean
}

export interface MatchEndResult {
  winner: Team | null
  scores: [number, number]
  board: { name: string; kills: number; deaths: number; captures: number }[]
}

export interface Settings {
  name: string
  sensitivity: number
  volume: number
}

export interface ClientState {
  phase: Phase
  connectionStatus: ConnectionStatus
  playerId: string | null
  roomCode: string | null
  hostId: string | null
  players: RosterPlayer[]
  queuePosition: number
  mapName: string | null
  snapshotCount: number
  matchEnd: MatchEndResult | null
  rematchVoted: boolean
  errorMessage: string | null
  settings: Settings
}

const SETTINGS_KEY = 'riftlane:settings'
export const DEFAULT_SENSITIVITY = 0.002

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>
      return {
        name: typeof parsed.name === 'string' ? parsed.name : '',
        sensitivity: typeof parsed.sensitivity === 'number' ? parsed.sensitivity : DEFAULT_SENSITIVITY,
        volume: typeof parsed.volume === 'number' ? parsed.volume : 1,
      }
    }
  } catch {
    // corrupt/unavailable localStorage -- fall through to defaults
  }
  return { name: '', sensitivity: DEFAULT_SENSITIVITY, volume: 1 }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage unavailable (private mode, quota) -- non-fatal
  }
}

function initialState(): ClientState {
  return {
    phase: 'menu',
    connectionStatus: 'connecting',
    playerId: null,
    roomCode: null,
    hostId: null,
    players: [],
    queuePosition: 0,
    mapName: null,
    snapshotCount: 0,
    matchEnd: null,
    rematchVoted: false,
    errorMessage: null,
    settings: loadSettings(),
  }
}

type Listener = (state: ClientState) => void

/** Tiny singleton store: subscribe(fn) gets called immediately with the
 * current state and again on every set(). No selectors/diffing -- the UI
 * is small enough to just re-render on every change. */
class Store {
  state: ClientState = initialState()
  private readonly listeners = new Set<Listener>()

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  set(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn(this.state)
  }
}

export const store = new Store()
