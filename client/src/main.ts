import type { ClientMsg, ServerMsg } from '@riftlane/shared'
import { connect, serverUrl } from './net'
import { InputManager } from './input'
import { Game } from './game'
import { store, type Phase } from './state'
import { initMenu } from './ui/menu'
import { audioEngine, ALL_SOUND_NAMES } from './audio'
import './ui/style.css'

// Derived from the page's own origin (and unit-tested in client/test/net.test.ts,
// because getting this wrong only shows up on a real deploy).
const SERVER_URL = serverUrl(location)
// Dev-only manual audio smoke test for Task 16's browser pass: run
// window.__riftlaneAudioTest() in the console to hear every synthesized
// sound once, back to back. Gated out of production builds.
declare global {
  interface Window {
    __riftlaneAudioTest?: () => void
  }
}
if (import.meta.env.DEV) {
  window.__riftlaneAudioTest = () => {
    audioEngine.init()
    ALL_SOUND_NAMES.forEach((name, i) => setTimeout(() => audioEngine.play(name), i * 500))
  }
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
//
// #appRoot has to go click-through at the same time. It is the outer host
// from index.html; ui/menu.ts builds its own `div.app` INSIDE it and puts
// `.app--playing { pointer-events: none }` on that inner div only. The
// outer one is height:100% and paints over the fixed canvas, so it kept
// swallowing the click that requests pointer lock -- and with the lock
// never acquired, InputManager gates out every key and mouse button. The
// game rendered perfectly and ignored the keyboard completely.
let lastPhase: Phase | null = null
store.subscribe((state) => {
  if (state.phase === lastPhase) return
  const playing = state.phase === 'playing'
  canvas.style.pointerEvents = playing ? 'auto' : 'none'
  appRoot.style.pointerEvents = playing ? 'none' : 'auto'
  if (lastPhase === 'playing' && state.phase !== 'playing') {
    game.teardown()
    if (document.pointerLockElement === canvas) document.exitPointerLock()
  }
  lastPhase = state.phase
})

// The resume token goes in sessionStorage, not localStorage: it is a bearer
// token for one player's seat in a live match, and a second tab must never
// be able to take the match away from this one. sessionStorage still
// survives a reload of this tab, which is the case worth surviving.
const RESUME_KEY = 'riftlane:resume'

function readResumeToken(): string | null {
  try {
    return sessionStorage.getItem(RESUME_KEY)
  } catch {
    // storage unavailable (private mode) -- resuming is just off
    return null
  }
}

function writeResumeToken(token: string): void {
  try {
    sessionStorage.setItem(RESUME_KEY, token)
  } catch {
    // storage unavailable (private mode, quota) -- non-fatal
  }
}

// The server requires `hello` as the literal first message on every socket
// (reconnects included) and identifies the player by whatever name it
// carries -- so we hold off sending it until the player's first real
// action, picking up whatever name they've typed by then instead of
// racing their edit with the initial connection.
let socketOpen = false
let helloSentForSocket = false

/** Failed attempts before the status bar explains the wait. A free-tier
 * server sleeps after ~15 min idle and takes about a minute to boot, so the
 * first couple of failures are normal and not worth alarming anyone over. */
const COLD_START_HINT_AFTER = 3

net.onStatus((status, attempt) => {
  socketOpen = status === 'open'
  if (status === 'open') {
    helloSentForSocket = false
    store.set({ connectionStatus: status, errorMessage: null })
    // Someone who dropped mid-match has no button left to press -- they are
    // back on the menu screen -- so a socket carrying a seat to reclaim says
    // hello straight away instead of waiting for an action that won't come.
    if (readResumeToken()) sendHello()
  } else if (status === 'connecting') {
    store.set({ connectionStatus: status, errorMessage: null })
  } else {
    // The socket is gone, and the server keeps no session to resume into --
    // a reconnect lands as a brand-new player with no room and no match. So
    // drop back to the menu rather than leave a frozen scene on screen.
    store.set({
      connectionStatus: status,
      errorMessage:
        status === 'disconnected'
          ? 'You are offline. RIFTLANE reconnects by itself once your network is back.'
          : attempt >= COLD_START_HINT_AFTER
            ? 'Server is waking up. This can take up to a minute.'
            : 'Connection lost. Reconnecting…',
      phase: 'menu',
      roomCode: null,
      hostId: null,
      players: [],
    })
  }
})

function sendHello(): void {
  helloSentForSocket = true
  const resume = readResumeToken()
  const name = store.state.settings.name.trim() || 'Player'
  net.send(resume ? { t: 'hello', name, resume } : { t: 'hello', name })
}

function guardedSend(msg: ClientMsg): void {
  if (!socketOpen) return // dropped -- status bar shows connecting/disconnected
  if (!helloSentForSocket) sendHello()
  net.send(msg)
}

net.onMsg((msg: ServerMsg) => {
  switch (msg.t) {
    case 'welcome':
      writeResumeToken(msg.resumeToken)
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
      break
    case 'snapshot':
      store.set({ snapshotCount: store.state.snapshotCount + 1 })
      game.onSnapshot(msg)
      break
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

initMenu(appRoot, guardedSend, () => net.retryNow())
