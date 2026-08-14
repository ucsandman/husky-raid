import type { ClientMsg, ServerMsg } from '@riftlane/shared'
import { connect } from './net'
import { InputManager } from './input'
import { Game } from './game'
import { store, type Phase } from './state'
import { initMenu } from './ui/menu'
import { audioEngine, ALL_SOUND_NAMES } from './audio'
import './ui/style.css'

const SERVER_URL = `ws://${location.hostname}:8080`
// Server snapshots at 20Hz -- log once a second instead of flooding the console.
const SNAPSHOT_LOG_INTERVAL = 20

// Dev-only manual audio smoke test for Task 16's browser pass: run
// window.__riftlaneAudioTest() in the console to hear every synthesized
// sound once, back to back.
declare global {
  interface Window {
    __riftlaneAudioTest?: () => void
  }
}
window.__riftlaneAudioTest = () => {
  audioEngine.init()
  ALL_SOUND_NAMES.forEach((name, i) => setTimeout(() => audioEngine.play(name), i * 500))
}

// AudioContext must start inside a user-gesture handler -- this fires on
// the first pointerdown anywhere (pointer-lock click on the canvas or any
// menu button both qualify) and is a no-op on every gesture after the
// first (init() is idempotent).
document.addEventListener('pointerdown', () => audioEngine.init(), { once: true, capture: true })

// Wired to settings.volume (state.ts, persisted to localStorage) --
// unconditional so a volume-only change (which doesn't touch state.phase)
// still reaches it, unlike the phase-gated subscriber below.
store.subscribe((state) => audioEngine.setVolume(state.settings.volume))

const appRoot = document.getElementById('app')
const canvas = document.getElementById('game-canvas')
if (!appRoot) throw new Error('missing #app root')
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing #game-canvas')

const inputManager = new InputManager(canvas, () => store.state.settings.sensitivity)

const net = connect(SERVER_URL)
const game = new Game(canvas, inputManager, net)

// The canvas is pointer-events:none by default (style.css) so it can't
// steal clicks from the menu overlay. Flip it on only while actually
// playing, and tear the scene down + release pointer lock the moment we
// leave that phase (menu screen after 'leave', or match_end -> rematch
// declined) so a stale render loop doesn't keep sending input frames.
let lastPhase: Phase | null = null
store.subscribe((state) => {
  if (state.phase === lastPhase) return
  canvas.style.pointerEvents = state.phase === 'playing' ? 'auto' : 'none'
  if (lastPhase === 'playing' && state.phase !== 'playing') {
    game.teardown()
    if (document.pointerLockElement === canvas) document.exitPointerLock()
  }
  lastPhase = state.phase
})

// The server requires `hello` as the literal first message on every socket
// (reconnects included) and identifies the player by whatever name it
// carries -- so we hold off sending it until the player's first real
// action, picking up whatever name they've typed by then instead of
// racing their edit with the initial connection.
let socketOpen = false
let helloSentForSocket = false

net.onStatus((status) => {
  socketOpen = status === 'open'
  if (status === 'open') {
    helloSentForSocket = false
    store.set({ connectionStatus: status, errorMessage: null })
  } else if (status === 'disconnected') {
    store.set({
      connectionStatus: status,
      errorMessage: 'Lost connection to the server. Refresh to try again.',
      phase: 'menu',
      roomCode: null,
      hostId: null,
      players: [],
    })
  } else {
    store.set({ connectionStatus: status })
  }
})

function guardedSend(msg: ClientMsg): void {
  if (!socketOpen) return // dropped -- status bar shows connecting/disconnected
  if (!helloSentForSocket) {
    helloSentForSocket = true
    net.send({ t: 'hello', name: store.state.settings.name.trim() || 'Player' })
  }
  net.send(msg)
}

net.onMsg((msg: ServerMsg) => {
  switch (msg.t) {
    case 'welcome':
      store.set({ playerId: msg.playerId })
      break
    case 'room':
      store.set({ phase: 'lobby', roomCode: msg.code, players: msg.players, hostId: msg.hostId, errorMessage: null })
      break
    case 'queue':
      store.set({ phase: 'queue', queuePosition: msg.position })
      break
    case 'match_start':
      store.set({
        phase: 'playing',
        mapName: msg.mapName,
        playerId: msg.yourId,
        players: msg.players,
        snapshotCount: 0,
      })
      game.start(msg)
      console.log('[riftlane] match_start', msg)
      break
    case 'snapshot': {
      const count = store.state.snapshotCount + 1
      store.set({ snapshotCount: count })
      game.onSnapshot(msg)
      if (count % SNAPSHOT_LOG_INTERVAL === 0) console.log(`[riftlane] snapshots received: ${count}`)
      break
    }
    case 'match_end':
      store.set({
        phase: 'ended',
        matchEnd: { winner: msg.winner, scores: msg.scores, board: msg.board },
        rematchVoted: false,
      })
      break
    case 'error':
      store.set({ errorMessage: msg.message })
      break
  }
})

initMenu(appRoot, guardedSend)
