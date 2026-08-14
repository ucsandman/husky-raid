import type { BoardRow, ClientMsg, MedalId, Team } from '@riftlane/shared'
import { store, saveSettings, DEFAULT_SENSITIVITY, type ClientState, type RosterPlayer } from '../state'
import { audioEngine } from '../audio'

const TEAM_COLOR: Record<Team, string> = { 0: 'var(--cobalt)', 1: 'var(--ember)' }
const TEAM_NAME: Record<Team, string> = { 0: 'Cobalt', 1: 'Ember' }

// Real bindings from input.ts -- sprint/slide listed right after move so
// they're readable at a glance (undiscoverable otherwise: both are
// hold-modifier keys with no on-screen prompt in a match).
const CONTROLS: [string, string][] = [
  ['WASD', 'Move'],
  ['Shift', 'Sprint'],
  ['Ctrl', 'Slide'],
  ['Space', 'Jump'],
  ['Mouse', 'Fire'],
  ['F', 'Melee'],
  ['G', 'Grenade'],
  ['E', 'Equipment'],
  ['1 / 2 / Scroll', 'Swap weapon'],
]

type Send = (msg: ClientMsg) => void

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  // Every menu button gets a click sound for free -- one wiring point
  // instead of one at each of the ~9 button call sites below.
  if (tag === 'button') node.addEventListener('click', () => audioEngine.play('ui_click'))
  return node
}

/** Mounts the DOM screen stack into `root` and keeps it in sync with the
 * store. No framework: full re-render of the screen area on every state
 * change (the tree is small). Text inputs use 'change', not 'input', so a
 * re-render never yanks focus out from under someone mid-keystroke. */
export function initMenu(root: HTMLElement, send: Send, onReconnect: () => void): void {
  root.innerHTML = ''
  const app = el('div', 'app')
  root.appendChild(app)

  store.subscribe((state) => render(app, state, send, onReconnect))
}

function render(app: HTMLElement, state: ClientState, send: Send, onReconnect: () => void): void {
  // 'playing' hands the screen to Game's 3D canvas + the Hud overlay
  // (client/src/game.ts, ui/hud.ts) -- this app div must stop painting its
  // own opaque background and stop intercepting clicks/mousemove over it,
  // or it blocks pointer-lock and hides the canvas underneath.
  app.classList.toggle('app--playing', state.phase === 'playing')
  app.innerHTML = ''
  app.appendChild(renderStatusBar(state, onReconnect))

  const screen =
    state.phase === 'menu'
      ? renderMenuScreen(state, send)
      : state.phase === 'queue'
        ? renderQueueScreen(state, send)
        : state.phase === 'lobby'
          ? renderLobbyScreen(state, send)
          : state.phase === 'playing'
            ? renderPlayingScreen(state)
            : renderEndedScreen(state, send)

  app.appendChild(screen)
}

// ---- status bar (connection + error banner, shown on every screen) --------

function renderStatusBar(state: ClientState, onReconnect: () => void): HTMLElement {
  const bar = el('div', 'status-bar')
  // Connection changes and server errors are announced to screen readers
  // without stealing focus.
  bar.setAttribute('role', 'status')
  bar.setAttribute('aria-live', 'polite')

  const dot = el('span', `status-dot status-dot--${state.connectionStatus}`)
  const label = el(
    'span',
    'status-label',
    state.connectionStatus === 'open'
      ? 'connected'
      : state.connectionStatus === 'connecting'
        ? 'connecting…'
        : state.connectionStatus === 'reconnecting'
          ? 'reconnecting…'
          : 'disconnected'
  )
  bar.append(dot, label)

  if (state.errorMessage) {
    const pending = state.connectionStatus === 'reconnecting'
    const err = el('span', `status-error${pending ? ' status-error--pending' : ''}`, state.errorMessage)
    bar.appendChild(err)
  }

  // The client already retries on its own timer, but a player watching a
  // stalled bar should never have to reload the page to get another go --
  // this skips the remaining backoff wait.
  if (state.connectionStatus === 'reconnecting' || state.connectionStatus === 'disconnected') {
    const retry = el('button', 'btn btn--tiny', 'Reconnect')
    retry.addEventListener('click', onReconnect)
    bar.appendChild(retry)
  }

  return bar
}

// ---- menu screen ------------------------------------------------------------

function renderMenuScreen(state: ClientState, send: Send): HTMLElement {
  const screen = el('div', 'screen screen--menu')
  const card = el('div', 'card')

  card.appendChild(el('h1', 'title', 'RIFTLANE'))
  card.appendChild(el('p', 'subtitle', 'arena FPS · capture the flag'))

  const nameRow = el('div', 'field')
  const nameLabel = el('label', 'field-label', 'Callsign')
  nameLabel.htmlFor = 'callsign-input'
  nameRow.appendChild(nameLabel)
  const nameInput = el('input', 'text-input')
  nameInput.id = 'callsign-input'
  nameInput.type = 'text'
  nameInput.maxLength = 16
  nameInput.placeholder = 'Player'
  nameInput.value = state.settings.name
  nameInput.addEventListener('change', () => {
    const settings = { ...state.settings, name: nameInput.value.trim().slice(0, 16) }
    saveSettings(settings)
    store.set({ settings })
  })
  nameRow.appendChild(nameInput)
  card.appendChild(nameRow)

  const actions = el('div', 'actions')
  // Every action below needs a live socket -- without one the send is
  // silently dropped, which reads as a dead button. Disable them and let
  // the status bar explain why.
  const offline = state.connectionStatus !== 'open'

  const quickPlayBtn = el('button', 'btn btn--primary', 'Quick Play')
  quickPlayBtn.disabled = offline
  quickPlayBtn.addEventListener('click', () => send({ t: 'quick_play' }))
  actions.appendChild(quickPlayBtn)

  const createBtn = el('button', 'btn', 'Create Room')
  createBtn.disabled = offline
  createBtn.addEventListener('click', () => send({ t: 'create_room' }))
  actions.appendChild(createBtn)

  const joinRow = el('div', 'join-row')
  const codeInput = el('input', 'text-input text-input--code')
  codeInput.type = 'text'
  codeInput.maxLength = 4
  codeInput.placeholder = 'CODE'
  codeInput.setAttribute('aria-label', 'Room code')
  const joinBtn = el('button', 'btn', 'Join Room')
  joinBtn.disabled = offline
  const doJoin = (): void => {
    const code = codeInput.value.trim().toUpperCase()
    if (code.length === 4) send({ t: 'join_room', code })
  }
  joinBtn.addEventListener('click', doJoin)
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin()
  })
  joinRow.append(codeInput, joinBtn)
  actions.appendChild(joinRow)

  card.appendChild(actions)
  card.appendChild(renderControlsPanel())
  card.appendChild(renderSettingsPanel(state))

  screen.appendChild(card)
  return screen
}

function renderControlsPanel(): HTMLElement {
  const panel = el('div', 'controls-panel')
  panel.appendChild(el('h2', 'panel-heading', 'CONTROLS'))
  const grid = el('div', 'controls-grid')
  for (const [key, action] of CONTROLS) {
    grid.appendChild(el('span', 'control-key', key))
    grid.appendChild(el('span', 'control-action', action))
  }
  panel.appendChild(grid)
  return panel
}

function renderSettingsPanel(state: ClientState): HTMLElement {
  const panel = el('div', 'settings-panel')
  panel.appendChild(el('h2', 'panel-heading', 'SETTINGS'))

  const sensRow = el('div', 'field field--slider')
  const sensValue = el('span', 'field-value', state.settings.sensitivity.toFixed(4))
  const sensLabel = el('label', 'field-label', 'Mouse sensitivity')
  sensLabel.htmlFor = 'sensitivity-input'
  sensRow.appendChild(sensLabel)
  const sensInput = el('input', 'range-input')
  sensInput.id = 'sensitivity-input'
  sensInput.type = 'range'
  sensInput.min = '0.0005'
  sensInput.max = '0.006'
  sensInput.step = '0.0001'
  sensInput.value = String(state.settings.sensitivity || DEFAULT_SENSITIVITY)
  sensInput.addEventListener('input', () => {
    sensValue.textContent = Number(sensInput.value).toFixed(4)
  })
  sensInput.addEventListener('change', () => {
    const settings = { ...state.settings, sensitivity: Number(sensInput.value) }
    saveSettings(settings)
    store.set({ settings })
  })
  sensRow.append(sensInput, sensValue)
  panel.appendChild(sensRow)

  const volRow = el('div', 'field field--slider')
  const volValue = el('span', 'field-value', `${Math.round(state.settings.volume * 100)}%`)
  const volLabel = el('label', 'field-label', 'Volume')
  volLabel.htmlFor = 'volume-input'
  volRow.appendChild(volLabel)
  const volInput = el('input', 'range-input')
  volInput.id = 'volume-input'
  volInput.type = 'range'
  volInput.min = '0'
  volInput.max = '1'
  volInput.step = '0.05'
  volInput.value = String(state.settings.volume)
  volInput.addEventListener('input', () => {
    volValue.textContent = `${Math.round(Number(volInput.value) * 100)}%`
  })
  volInput.addEventListener('change', () => {
    const settings = { ...state.settings, volume: Number(volInput.value) }
    saveSettings(settings)
    store.set({ settings })
  })
  volRow.append(volInput, volValue)
  panel.appendChild(volRow)

  return panel
}

// ---- queue screen -------------------------------------------------------------

function renderQueueScreen(state: ClientState, send: Send): HTMLElement {
  const screen = el('div', 'screen screen--queue')
  const card = el('div', 'card')
  card.appendChild(el('h1', 'title', 'SEARCHING'))
  card.appendChild(el('p', 'subtitle', `queue position ${state.queuePosition}`))
  card.appendChild(el('div', 'spinner'))

  const cancelBtn = el('button', 'btn btn--ghost', 'Cancel')
  cancelBtn.addEventListener('click', () => send({ t: 'leave' }))
  card.appendChild(cancelBtn)

  screen.appendChild(card)
  return screen
}

// ---- lobby screen -------------------------------------------------------------

function renderLobbyScreen(state: ClientState, send: Send): HTMLElement {
  const screen = el('div', 'screen screen--lobby')
  const card = el('div', 'card card--wide')

  const codeRow = el('div', 'room-code-row')
  codeRow.appendChild(el('span', 'room-code', state.roomCode ?? '----'))
  const copyBtn = el('button', 'btn btn--small', 'Copy')
  copyBtn.addEventListener('click', () => {
    void copyRoomCode(state.roomCode ?? '', copyBtn)
  })
  codeRow.appendChild(copyBtn)
  card.appendChild(codeRow)

  card.appendChild(el('h2', 'panel-heading', 'PLAYERS'))
  card.appendChild(renderRoster(state.players))

  const isHost = state.hostId !== null && state.hostId === state.playerId
  const actions = el('div', 'actions')
  if (isHost) {
    const startBtn = el('button', 'btn btn--primary', 'Start Match')
    startBtn.addEventListener('click', () => send({ t: 'start_match' }))
    actions.appendChild(startBtn)
  } else {
    actions.appendChild(el('p', 'hint', 'Waiting for host to start…'))
  }
  const leaveBtn = el('button', 'btn btn--ghost', 'Leave')
  leaveBtn.addEventListener('click', () => send({ t: 'leave' }))
  actions.appendChild(leaveBtn)
  card.appendChild(actions)

  screen.appendChild(card)
  return screen
}

function renderRoster(players: RosterPlayer[]): HTMLElement {
  const list = el('ul', 'roster')
  if (players.length === 0) {
    list.appendChild(el('li', 'roster-empty', 'no one here yet'))
    return list
  }
  for (const p of players) {
    const row = el('li', 'roster-row')
    const swatch = el('span', 'team-swatch')
    swatch.style.background = TEAM_COLOR[p.team]
    row.appendChild(swatch)
    row.appendChild(el('span', 'roster-name', p.name || '(unnamed)'))
    row.appendChild(el('span', 'roster-team', TEAM_NAME[p.team]))
    if (p.bot) row.appendChild(el('span', 'tag tag--bot', 'BOT'))
    list.appendChild(row)
  }
  return list
}

async function copyRoomCode(code: string, btn: HTMLButtonElement): Promise<void> {
  const original = btn.textContent
  try {
    await navigator.clipboard.writeText(code)
    btn.textContent = 'Copied!'
  } catch {
    btn.textContent = 'Copy failed'
  }
  setTimeout(() => {
    btn.textContent = original
  }, 1500)
}

// ---- playing screen -----------------------------------------------------------
// Once snapshots are flowing, the real UI is Game's 3D canvas plus the Hud
// overlay (ui/hud.ts) -- both live outside this render() cycle. This only
// shows a connecting card for the brief gap before the first snapshot
// arrives, then renders nothing so it can't cover the HUD.

function renderPlayingScreen(state: ClientState): HTMLElement {
  const screen = el('div', 'screen screen--playing')
  if (state.snapshotCount === 0) {
    const card = el('div', 'card')
    card.appendChild(el('h1', 'title', 'MATCH STARTING'))
    card.appendChild(el('p', 'subtitle', state.mapName ? `map: ${state.mapName}` : 'connecting to arena…'))
    card.appendChild(el('div', 'spinner'))
    screen.appendChild(card)
  }
  return screen
}

// ---- ended screen -------------------------------------------------------------

function renderEndedScreen(state: ClientState, send: Send): HTMLElement {
  const screen = el('div', 'screen screen--ended')
  const card = el('div', 'card card--wide')

  const result = state.matchEnd
  const winnerText =
    result === null
      ? 'match ended'
      : result.winner === null
        ? 'DRAW'
        : `${TEAM_NAME[result.winner]} WINS`
  const winnerHeading = el('h1', 'title', winnerText)
  if (result?.winner !== undefined && result?.winner !== null) {
    winnerHeading.style.color = TEAM_COLOR[result.winner]
  }
  card.appendChild(winnerHeading)

  if (result) {
    card.appendChild(el('p', 'subtitle', `${result.scores[0]} – ${result.scores[1]}`))
    card.appendChild(renderScoreboard(result.board))
  }

  const actions = el('div', 'actions')
  const rematchBtn = el('button', 'btn btn--primary', state.rematchVoted ? 'Vote cast ✓' : 'Vote Rematch')
  rematchBtn.disabled = state.rematchVoted
  rematchBtn.addEventListener('click', () => {
    send({ t: 'rematch_vote' })
    store.set({ rematchVoted: true })
  })
  actions.appendChild(rematchBtn)

  const leaveBtn = el('button', 'btn btn--ghost', 'Back to Menu')
  leaveBtn.addEventListener('click', () => {
    send({ t: 'leave' })
    store.set({ phase: 'menu', roomCode: null, hostId: null, players: [], matchEnd: null, rematchVoted: false })
  })
  actions.appendChild(leaveBtn)

  card.appendChild(actions)
  screen.appendChild(card)
  return screen
}

/** Short mono glyph + full name for each medal. Glyphs stay two characters
 * so a row of them lines up in the mono face the HUD already uses. */
const MEDAL_LABEL: Record<MedalId, { glyph: string; name: string }> = {
  headshot: { glyph: 'HS', name: 'Headshot' },
  assassination: { glyph: 'AS', name: 'Assassination' },
  double: { glyph: 'x2', name: 'Double Kill' },
  triple: { glyph: 'x3', name: 'Triple Kill' },
  overkill: { glyph: 'x4', name: 'Overkill' },
  spree: { glyph: 'SP', name: 'Killing Spree' },
  frenzy: { glyph: 'FR', name: 'Killing Frenzy' },
  riot: { glyph: 'RR', name: 'Running Riot' },
  killjoy: { glyph: 'KJ', name: 'Killjoy' },
}

/** Display order, rarest last, so the eye lands on the good ones. */
const MEDAL_ORDER: MedalId[] = [
  'headshot',
  'assassination',
  'double',
  'triple',
  'overkill',
  'killjoy',
  'spree',
  'frenzy',
  'riot',
]

function renderMedals(medals: Partial<Record<MedalId, number>>): HTMLElement {
  const wrap = el('div', 'medal-strip')
  for (const id of MEDAL_ORDER) {
    const count = medals[id]
    if (!count) continue
    const chip = el('span', 'medal')
    chip.textContent = count > 1 ? `${MEDAL_LABEL[id].glyph}·${count}` : MEDAL_LABEL[id].glyph
    // The glyph alone is not self-explanatory, so the full name is always
    // one hover (and one screen-reader read) away.
    chip.title = count > 1 ? `${MEDAL_LABEL[id].name} x${count}` : MEDAL_LABEL[id].name
    chip.setAttribute('aria-label', chip.title)
    wrap.appendChild(chip)
  }
  return wrap
}

function renderScoreboard(board: BoardRow[]): HTMLElement {
  const table = el('table', 'scoreboard')
  const head = el('tr', 'scoreboard-head')
  head.append(
    el('th', undefined, 'Name'),
    el('th', undefined, 'K'),
    el('th', undefined, 'D'),
    el('th', undefined, 'C'),
    el('th', undefined, 'Medals')
  )
  table.appendChild(head)
  for (const row of board) {
    const tr = el('tr', 'scoreboard-row')
    const medalCell = el('td')
    medalCell.appendChild(renderMedals(row.medals))
    tr.append(
      el('td', undefined, row.name),
      el('td', undefined, String(row.kills)),
      el('td', undefined, String(row.deaths)),
      el('td', undefined, String(row.captures)),
      medalCell
    )
    table.appendChild(tr)
  }
  return table
}
