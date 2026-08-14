import type { ClientMsg, ServerMsg } from '@riftlane/shared'
import { connect } from './net'
import { InputManager } from './input'
import { store } from './state'
import { initMenu } from './ui/menu'
import './ui/style.css'

const SERVER_URL = `ws://${location.hostname}:8080`
// Server snapshots at 20Hz -- log once a second instead of flooding the console.
const SNAPSHOT_LOG_INTERVAL = 20

const appRoot = document.getElementById('app')
const canvas = document.getElementById('game-canvas')
if (!appRoot) throw new Error('missing #app root')
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing #game-canvas')

// Wired up here so pointer-lock + key capture are live for Task 12's game
// loop to call .sample() on; nothing drives a render loop with it yet since
// there's no 3D scene in this task.
new InputManager(canvas, () => store.state.settings.sensitivity)

const net = connect(SERVER_URL)

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
      console.log('[riftlane] match_start', msg)
      break
    case 'snapshot': {
      const count = store.state.snapshotCount + 1
      store.set({ snapshotCount: count })
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
