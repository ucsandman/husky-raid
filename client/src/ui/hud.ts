import type { EquipmentId, FlagState, ServerMsg, SnapPlayer, Team, WeaponId } from '@riftlane/shared'
import { MAX_HEALTH, MAX_SHIELD, RESPAWN_DELAY, WEAPONS, clamp } from '@riftlane/shared'
import { audioEngine } from '../audio'
import { announcer } from '../announcer'
import { forwardXZ, rightXZ } from '../render/feel'
import { store, saveSettings, DEFAULT_SENSITIVITY, DEFAULT_FOV, DEFAULT_PAD_SENSITIVITY, type Settings } from '../state'
import './hud.css'

type SnapshotMsg = Extract<ServerMsg, { t: 'snapshot' }>

const HEALTH_PIP_COUNT = 6
const CROSSHAIR_KICK_PX = 6
const CROSSHAIR_RECOVER_RATE = 6 // 1/s
const HITMARKER_MS = 250
const HITMARKER_KILL_MS = 420
const KILLFEED_MS = 4000
const KILLFEED_MAX = 8
const KILL_BANNER_MS = 1400
const KILL_STREAK_WINDOW = 4.5 // seconds; resets the streak counter if exceeded between kills
const KILL_STREAK_LABEL: Record<number, string> = { 2: 'DOUBLE ELIMINATION', 3: 'TRIPLE ELIMINATION' }
const CALLOUT_MS = 2200
/** Motion tracker radius in metres, and the horizontal speed below which a
 * player stops painting. No crouch state exists in the sim, so speed is the
 * only gate -- a player who walks a corner slowly is invisible, which is
 * close enough to Halo's crouch rule to play the same way. */
const TRACKER_RANGE = 25
const TRACKER_MIN_SPEED = 2.2
const DAMAGE_PULSE_MS = 450
const LOW_HEALTH_FRAC = 0.25
const HEARTBEAT_INTERVAL_MAX = 1.1 // seconds, at exactly the 25% threshold
const HEARTBEAT_INTERVAL_MIN = 0.55 // seconds, at 0 health -- faster as health drains
const FIGHT_FLASH_MS = 800
const PICKUP_TOAST_MS = 2400

const TEAM_NAME: Record<Team, string> = { 0: 'Cobalt', 1: 'Ember' }
const EQUIP_GLYPH: Record<EquipmentId, string> = { grapple: 'G', repulsor: 'R', camo: 'C' }
const SPECIAL_WEAPON_NAMES: Record<string, string> = { melee: 'Melee', frag: 'Frag Grenade', mag: 'Mag Grenade' }

function weaponDisplayName(weapon: string): string {
  const def = WEAPONS[weapon as WeaponId]
  if (def) return def.name
  if (weapon in SPECIAL_WEAPON_NAMES) return SPECIAL_WEAPON_NAMES[weapon]
  // Unknown weapon string (e.g. 'fall') -- format like the table names above
  // instead of dumping the raw lowercase wire value.
  return weapon.length > 0 ? weapon.charAt(0).toUpperCase() + weapon.slice(1) : weapon
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

interface TallyEntry {
  kills: number
  deaths: number
  captures: number
  team: Team
  bot: boolean
}

interface WeaponRowEls {
  row: HTMLDivElement
  name: HTMLSpanElement
  ammo: HTMLSpanElement
}

interface ChipEls {
  chip: HTMLDivElement
  count: HTMLSpanElement
}

interface ScoreboardRowEls {
  tr: HTMLTableRowElement
  name: HTMLTableCellElement
  kills: HTMLTableCellElement
  deaths: HTMLTableCellElement
  captures: HTMLTableCellElement
}

interface PauseSlider {
  input: HTMLInputElement
  value: HTMLSpanElement
}

/**
 * The in-match HUD overlay: shield/health, ammo/grenades/equipment,
 * crosshair + hit markers, kill feed, score strip, flag banners, respawn
 * countdown, and the Tab-held scoreboard.
 *
 * Owns one fixed `pointer-events: none` div appended straight to
 * document.body -- NOT routed through ui/menu.ts's render(), which does a
 * full `innerHTML = ''` rebuild on every store change (state.snapshotCount
 * ticks on every 20Hz snapshot). Game (client/src/game.ts) drives update()
 * once per render frame and owns this instance's lifecycle: created in
 * Game.start(), disposed in Game.teardown() -- matching Task 12's
 * no-leaks-across-rematches discipline. This class itself adds no
 * document-level event listeners, so dispose() only needs to clear
 * pending timeouts and remove its own subtree.
 *
 * RULING (server sends no live per-player kills/deaths/captures on the
 * wire -- only shield/health/weapons/ammo/grenades/equipment/camo/flag):
 * the Tab scoreboard's K/D/C columns are tallied client-side from 'kill'/
 * 'capture' SimEvents observed since this Hud was constructed (i.e. since
 * match start). This can undercount if the client joins mid-match or a
 * snapshot is dropped -- acceptable for v1; the match-end screen (Task 11,
 * ui/menu.ts renderEndedScreen) uses the server's authoritative
 * `match_end.board` instead, not this tally.
 *
 * RULING (no generic "you landed a hit" SimEvent exists, only 'shot' with
 * no target and 'kill'): the hit marker fires only on a confirmed kill
 * credited to the local player. It under-fires relative to "every damaging
 * hit" but never fires on a false positive. A self-kill (killerId ===
 * victimId, e.g. a fall) never fires it, never bumps the kill tally, and
 * never highlights as an "own kill" in the feed -- matches
 * MatchSim.killPlayer, which only credits a kill when killerId is set and
 * differs from the victim.
 */
export class Hud {
  private readonly root: HTMLDivElement
  private readonly crosshair: HTMLDivElement
  private readonly hitmarker: HTMLDivElement
  private readonly scopeOverlay: HTMLDivElement
  private readonly killBanner: HTMLDivElement
  private readonly killBannerTitle: HTMLDivElement
  private readonly killBannerStreak: HTMLDivElement
  private readonly damageVignette: HTMLDivElement
  private readonly shieldBreakVignette: HTMLDivElement
  private readonly damageIndicator: HTMLDivElement
  private readonly lowHealthVignette: HTMLDivElement
  private readonly shieldFill: HTMLDivElement
  private readonly healthPips: HTMLDivElement[] = []
  private readonly weaponRows: [WeaponRowEls, WeaponRowEls]
  private readonly fragChip: ChipEls
  private readonly magChip: ChipEls
  private readonly equipChip: HTMLDivElement
  private readonly equipGlyph: HTMLSpanElement
  private readonly equipCount: HTMLSpanElement
  private readonly killfeed: HTMLDivElement
  private readonly scoreCobalt: HTMLSpanElement
  private readonly scoreEmber: HTMLSpanElement
  private readonly timer: HTMLSpanElement
  private readonly ownFlagBanner: HTMLDivElement
  private readonly enemyFlagBanner: HTMLDivElement
  private readonly respawnOverlay: HTMLDivElement
  private readonly respawnCount: HTMLDivElement
  private readonly deathCard: HTMLDivElement
  private readonly tracker: HTMLDivElement
  private readonly trackerBlips: HTMLDivElement
  private readonly trackerSelf: HTMLDivElement
  private readonly calloutBanner: HTMLDivElement
  /** Pooled tracker blips, grown on demand and hidden when unused -- the
   * tracker runs every frame, so it must never allocate per frame. */
  private readonly trackerBlipPool: HTMLDivElement[] = []
  private readonly inputPausedOverlay: HTMLDivElement
  private readonly pausePanel: HTMLDivElement
  private readonly pauseSensSlider: PauseSlider
  private readonly pausePadSlider: PauseSlider
  private readonly pauseFovSlider: PauseSlider
  private readonly pauseVolSlider: PauseSlider
  private readonly phaseBanner: HTMLDivElement
  private readonly pickupToast: HTMLDivElement
  private readonly scoreboard: HTMLDivElement
  private readonly scoreboardCobaltBody: HTMLTableSectionElement
  private readonly scoreboardEmberBody: HTMLTableSectionElement
  /** Scoreboard rows cached by player id, one map per team -- see
   * renderScoreboardTeam(). Rebuilding the tbody from scratch every frame
   * the scoreboard is held (Tab) was the perf bug this replaces. */
  private readonly scoreboardRows: [Map<string, ScoreboardRowEls>, Map<string, ScoreboardRowEls>] = [
    new Map(),
    new Map(),
  ]

  private readonly nameCache = new Map<string, string>()
  private readonly tally = new Map<string, TallyEntry>()
  private readonly pendingTimeouts = new Set<ReturnType<typeof setTimeout>>()

  private prevScores: [number, number] | null = null
  private lastProcessedTick: number | null = null
  private prevAlive = true
  private respawnRemaining = 0
  private crosshairKickT = 1 // 1 = fully recovered, 0 = just fired
  private killStreakCount = 0
  private killStreakRemaining = 0
  private heartbeatRemaining = 0
  private wasInputPaused = false
  private resumeHandler: (() => void) | null = null
  private leaveHandler: (() => void) | null = null
  private lastPhase: 'warmup' | 'playing' | 'ended' | null = null
  private lastCountdownDisplay: number | null = null

  constructor() {
    this.root = el('div', 'hud')

    this.lowHealthVignette = el('div', 'hud-vignette hud-vignette--low-health')
    this.damageVignette = el('div', 'hud-vignette hud-vignette--damage')
    this.shieldBreakVignette = el('div', 'hud-vignette hud-vignette--shield-break')
    this.damageIndicator = el('div', 'hud-damage-indicator')
    this.damageIndicator.appendChild(el('div', 'hud-damage-indicator-arrow'))
    this.root.append(this.lowHealthVignette, this.damageVignette, this.shieldBreakVignette, this.damageIndicator)

    this.killBanner = el('div', 'hud-kill-banner')
    this.killBannerTitle = el('div', 'hud-kill-banner-title')
    this.killBannerStreak = el('div', 'hud-kill-banner-streak')
    this.killBanner.append(this.killBannerTitle, this.killBannerStreak)
    this.root.appendChild(this.killBanner)

    this.crosshair = this.buildCrosshair()
    this.hitmarker = el('div', 'hud-hitmarker')
    this.scopeOverlay = this.buildScope()
    this.root.append(this.crosshair, this.hitmarker, this.scopeOverlay)

    const vitals = el('div', 'hud-vitals')
    const shieldTrack = el('div', 'hud-shield-track')
    this.shieldFill = el('div', 'hud-shield-fill')
    shieldTrack.appendChild(this.shieldFill)
    const pipsRow = el('div', 'hud-health-pips')
    for (let i = 0; i < HEALTH_PIP_COUNT; i++) {
      const pip = el('div', 'hud-pip')
      const fill = el('div', 'hud-pip-fill')
      pip.appendChild(fill)
      pipsRow.appendChild(pip)
      this.healthPips.push(fill)
    }
    vitals.append(shieldTrack, pipsRow)
    this.root.appendChild(vitals)

    const loadout = el('div', 'hud-loadout')
    this.weaponRows = [this.buildWeaponRow(), this.buildWeaponRow()]
    const chips = el('div', 'hud-chips')
    this.fragChip = this.buildShapeChip('frag')
    this.magChip = this.buildShapeChip('mag')
    const equip = this.buildGlyphChip()
    this.equipChip = equip.chip
    this.equipGlyph = equip.glyph
    this.equipCount = equip.count
    chips.append(this.fragChip.chip, this.magChip.chip, this.equipChip)
    loadout.append(this.weaponRows[0].row, this.weaponRows[1].row, chips)
    this.root.appendChild(loadout)

    this.killfeed = el('div', 'hud-killfeed')
    this.root.appendChild(this.killfeed)

    const scorestrip = el('div', 'hud-scorestrip')
    this.scoreCobalt = el('span', 'hud-score-cobalt')
    const dash = el('span')
    dash.textContent = '–'
    this.scoreEmber = el('span', 'hud-score-ember')
    this.timer = el('span', 'hud-timer')
    scorestrip.append(this.scoreCobalt, dash, this.scoreEmber, this.timer)
    this.root.appendChild(scorestrip)

    const flags = el('div', 'hud-flags')
    this.ownFlagBanner = el('div', 'hud-flag-banner')
    this.enemyFlagBanner = el('div', 'hud-flag-banner')
    flags.append(this.ownFlagBanner, this.enemyFlagBanner)
    this.root.appendChild(flags)

    this.respawnOverlay = el('div', 'hud-respawn')
    const respawnTitle = el('div', 'hud-respawn-title')
    respawnTitle.textContent = 'ELIMINATED'
    this.respawnCount = el('div', 'hud-respawn-count')
    this.deathCard = el('div', 'hud-death-card')
    this.respawnOverlay.append(respawnTitle, this.respawnCount, this.deathCard)
    this.root.appendChild(this.respawnOverlay)

    // Motion tracker: bottom-centre, clear of the vitals cluster on the left
    // and the loadout on the right, so it never covers the crosshair.
    this.tracker = el('div', 'hud-tracker')
    const trackerRing = el('div', 'hud-tracker-ring')
    const trackerSweepA = el('div', 'hud-tracker-cross hud-tracker-cross--v')
    const trackerSweepB = el('div', 'hud-tracker-cross hud-tracker-cross--h')
    this.trackerSelf = el('div', 'hud-tracker-self')
    this.trackerBlips = el('div', 'hud-tracker-blips')
    this.tracker.append(trackerRing, trackerSweepA, trackerSweepB, this.trackerBlips, this.trackerSelf)
    this.root.appendChild(this.tracker)

    this.calloutBanner = el('div', 'hud-callout')
    this.root.appendChild(this.calloutBanner)

    // Backdrop stays pointer-events:none (inherited from .hud) so a click
    // outside the panel still lands on the canvas and re-acquires pointer
    // lock, same as the old click-anywhere-to-resume overlay. Only the panel
    // itself opts back in to pointer-events:auto for its buttons/sliders.
    this.inputPausedOverlay = el('div', 'hud-input-paused')
    this.pausePanel = el('div', 'hud-pause-panel')
    const pausedTitle = el('div', 'hud-input-paused-title')
    pausedTitle.textContent = 'PAUSED'
    const pausedHint = el('div', 'hud-input-paused-hint')
    pausedHint.textContent = 'Click outside this panel, or Resume, to continue'
    this.pausePanel.append(pausedTitle, pausedHint)

    const resumeBtn = el('button', 'btn btn--primary hud-pause-btn')
    resumeBtn.type = 'button'
    resumeBtn.textContent = 'Resume'
    resumeBtn.addEventListener('click', () => {
      audioEngine.play('ui_click')
      this.resumeHandler?.()
    })
    this.pausePanel.appendChild(resumeBtn)

    const sliders = el('div', 'hud-pause-sliders')
    this.pauseSensSlider = this.buildPauseSlider(
      sliders,
      'Mouse sensitivity',
      0.0005,
      0.006,
      0.0001,
      (v) => v.toFixed(4),
      (v) => this.patchSettings({ sensitivity: v })
    )
    this.pausePadSlider = this.buildPauseSlider(
      sliders,
      'Controller sensitivity',
      0.1,
      3,
      0.1,
      (v) => v.toFixed(1),
      (v) => this.patchSettings({ padSensitivity: v })
    )
    this.pauseFovSlider = this.buildPauseSlider(
      sliders,
      'Field of view',
      75,
      100,
      1,
      (v) => `${Math.round(v)}°`,
      (v) => this.patchSettings({ fov: Math.round(v) })
    )
    this.pauseVolSlider = this.buildPauseSlider(
      sliders,
      'Volume',
      0,
      1,
      0.05,
      (v) => `${Math.round(v * 100)}%`,
      (v) => this.patchSettings({ volume: v })
    )
    this.pausePanel.appendChild(sliders)

    const leaveBtn = el('button', 'btn btn--ghost hud-pause-btn')
    leaveBtn.type = 'button'
    leaveBtn.textContent = 'Leave Match'
    leaveBtn.addEventListener('click', () => {
      audioEngine.play('ui_click')
      this.leaveHandler?.()
    })
    this.pausePanel.appendChild(leaveBtn)

    this.inputPausedOverlay.appendChild(this.pausePanel)
    this.root.appendChild(this.inputPausedOverlay)

    this.phaseBanner = el('div', 'hud-phase-banner')
    this.root.appendChild(this.phaseBanner)

    this.pickupToast = el('div', 'hud-pickup-toast')
    this.root.appendChild(this.pickupToast)

    this.scoreboard = el('div', 'hud-scoreboard')
    const cobaltCol = this.buildScoreboardTeam(0)
    const emberCol = this.buildScoreboardTeam(1)
    this.scoreboardCobaltBody = cobaltCol.body
    this.scoreboardEmberBody = emberCol.body
    this.scoreboard.append(cobaltCol.el, emberCol.el)
    this.root.appendChild(this.scoreboard)

    document.body.appendChild(this.root)
  }

  /** Called once per render frame from Game.tick(). `snap` is null before
   * the first snapshot arrives; crosshair recovery still runs so it isn't
   * stuck mid-kick if a frame lands right on match start. */
  update(dt: number, snap: SnapshotMsg | null, localId: string | null, scoreboardHeld: boolean): void {
    this.scoreboard.classList.toggle('hud-scoreboard--show', scoreboardHeld)

    this.crosshairKickT = Math.min(1, this.crosshairKickT + dt * CROSSHAIR_RECOVER_RATE)
    const kickPx = (1 - this.crosshairKickT) * CROSSHAIR_KICK_PX
    this.crosshair.style.setProperty('--hud-kick', `${kickPx}px`)

    if (!snap) return

    for (const p of snap.players) this.nameCache.set(p.id, p.name)

    if (snap.tick !== this.lastProcessedTick) {
      this.lastProcessedTick = snap.tick
      this.processEvents(snap.events, snap.players, localId)
    }

    const localSnap = localId ? (snap.players.find((p) => p.id === localId) ?? null) : null
    if (localSnap) {
      this.updateVitals(localSnap)
      this.updateWeapons(localSnap)
      this.updateLoadout(localSnap)
      this.updateFlags(localSnap, snap.flags)
      this.updateRespawn(localSnap, dt)
      this.updateLowHealthCue(localSnap, dt)
      this.updateTracker(localSnap, snap.players)
      this.root.classList.toggle('hud--camo', localSnap.camo)
    } else {
      this.lowHealthVignette.style.opacity = '0'
      this.tracker.classList.remove('hud-tracker--show')
    }

    if (this.killStreakRemaining > 0) {
      this.killStreakRemaining -= dt
      if (this.killStreakRemaining <= 0) this.killStreakCount = 0
    }

    this.updateScoreStrip(snap.scores, snap.timeLeft, localSnap ? localSnap.team : null)
    if (scoreboardHeld) this.updateScoreboard(snap.players)
  }

  dispose(): void {
    for (const t of this.pendingTimeouts) clearTimeout(t)
    this.pendingTimeouts.clear()
    this.root.remove()
  }

  // ---- build helpers -----------------------------------------------------

  /** Halo-style red reticle: driven every render frame from game.ts's
   * cosmetic aim raycast (see game.ts's aimHit) -- toggles a CSS class only,
   * never touches sim state or the crosshair's kick/recovery mechanics. */
  setTargetTracked(active: boolean): void {
    this.crosshair.classList.toggle('hud-crosshair--target', active)
    this.scopeOverlay.classList.toggle('hud-scope--target', active)
  }

  /** Toggled by the game every frame from InputManager.isLocked() (or on a
   * pointerlockchange callback) to show a centered "click to resume"
   * overlay whenever mouse/keyboard input is paused mid-match -- lock lost
   * to Escape, alt-tab, or window blur all land here. This is the fix for a
   * failure mode this project already shipped once: input silently dying
   * with nothing on screen to explain why (docs/ERRORS.md, 2026-08-14).
   * The overlay is a child of `root`, which is pointer-events:none end to
   * end -- it must stay that way, or it eats the very click that would
   * re-acquire lock and recover from this state. The panel inside it is the
   * one exception (see the constructor): it opts back in to
   * pointer-events:auto so its Resume/Leave buttons and sliders are
   * clickable, while the backdrop around it keeps passing clicks through. */
  setInputPaused(paused: boolean): void {
    this.inputPausedOverlay.classList.toggle('hud-input-paused--show', paused)
    // Sync the sliders to the live settings only on the rising edge -- this
    // is called every frame (game.ts:541), and refreshing on every one of
    // those while the overlay is already open would fight a slider mid-drag.
    if (paused && !this.wasInputPaused) this.refreshPauseSliders()
    this.wasInputPaused = paused
  }

  /** Wired by the caller to re-request pointer lock; the Resume button in
   * the pause panel calls it. */
  setResumeHandler(fn: () => void): void {
    this.resumeHandler = fn
  }

  /** Wired by the caller to leave the match; the Leave Match button in the
   * pause panel calls it. */
  setLeaveHandler(fn: () => void): void {
    this.leaveHandler = fn
  }

  /** CSS-only aim-down-sights vignette + reticle. The caller (whoever drives
   * the camera zoom off InputManager's `ads` sample) just toggles this each
   * frame; it also hides the regular crosshair so scoping doesn't leave two
   * reticles on screen at once. Visual only -- no camera/FOV logic here. */
  setScoped(active: boolean): void {
    this.scopeOverlay.classList.toggle('hud-scope--show', active)
    this.crosshair.classList.toggle('hud-crosshair--hidden', active)
  }

  /** Drives the big center-screen warmup countdown and the 'FIGHT' flash on
   * the warmup->playing transition. Meant to be called every frame with the
   * sim's current phase (SnapshotMsg.phase) and remaining warmup seconds --
   * idempotent per frame: it only touches the DOM (and restarts the pulse
   * animation) when the displayed number or the phase actually changes, so
   * a steady countdown doesn't re-trigger its own pop every frame. */
  setPhase(phase: 'warmup' | 'playing' | 'ended', countdownSec: number): void {
    if (phase === 'warmup') {
      const display = Math.max(0, Math.ceil(countdownSec))
      if (this.lastPhase !== 'warmup' || this.lastCountdownDisplay !== display) {
        this.phaseBanner.textContent = String(display)
        this.phaseBanner.className = 'hud-phase-banner hud-phase-banner--countdown'
        void this.phaseBanner.offsetWidth // restart the pulse animation on every new number
        this.phaseBanner.classList.add('hud-phase-banner--pulse')
        this.lastCountdownDisplay = display
      }
    } else if (phase === 'playing' && this.lastPhase === 'warmup') {
      this.phaseBanner.textContent = 'FIGHT'
      this.phaseBanner.className = 'hud-phase-banner hud-phase-banner--fight'
      const t = setTimeout(() => {
        this.phaseBanner.classList.remove('hud-phase-banner--fight')
        this.phaseBanner.textContent = ''
        this.pendingTimeouts.delete(t)
      }, FIGHT_FLASH_MS)
      this.pendingTimeouts.add(t)
      this.lastCountdownDisplay = null
    } else if (phase !== this.lastPhase) {
      this.phaseBanner.textContent = ''
      this.phaseBanner.className = 'hud-phase-banner'
      this.lastCountdownDisplay = null
    }
    this.lastPhase = phase
  }

  /** Center-top toast for a power-weapon pickup. `weaponName` is a
   * display-ready name (as shown in weapon rows/killfeed), not a raw
   * WeaponId -- this only upper-cases it. No SimEvent carries who took a
   * pickup by name, only whether it was the local player, so the non-local
   * case stays deliberately generic rather than guessing at a name. */
  notifyPickup(weaponName: string, byLocalPlayer: boolean): void {
    const name = weaponName.toUpperCase()
    this.pickupToast.textContent = byLocalPlayer ? `POWER WEAPON: ${name}` : `WEAPON TAKEN: ${name}`
    this.pickupToast.classList.toggle('hud-pickup-toast--own', byLocalPlayer)
    this.pickupToast.classList.remove('hud-pickup-toast--show')
    void this.pickupToast.offsetWidth // restart the animation on a rapid second pickup
    this.pickupToast.classList.add('hud-pickup-toast--show')
    const t = setTimeout(() => {
      this.pickupToast.classList.remove('hud-pickup-toast--show')
      this.pendingTimeouts.delete(t)
    }, PICKUP_TOAST_MS)
    this.pendingTimeouts.add(t)
  }

  private buildCrosshair(): HTMLDivElement {
    const wrap = el('div', 'hud-crosshair')
    for (const dir of ['n', 's', 'w', 'e'] as const) {
      wrap.appendChild(el('div', `hud-crosshair-line hud-crosshair-line--${dir}`))
    }
    return wrap
  }

  private buildScope(): HTMLDivElement {
    const wrap = el('div', 'hud-scope')
    wrap.appendChild(el('div', 'hud-scope-dot'))
    return wrap
  }

  private buildWeaponRow(): WeaponRowEls {
    const row = el('div', 'hud-weapon-row')
    const name = el('span', 'hud-weapon-name')
    const ammo = el('span', 'hud-weapon-ammo')
    row.append(name, ammo)
    return { row, name, ammo }
  }

  private buildShapeChip(kind: 'frag' | 'mag'): ChipEls {
    const chip = el('div', 'hud-chip')
    chip.appendChild(el('div', `hud-chip-shape hud-chip-shape--${kind}`))
    const count = el('span', 'hud-chip-count')
    chip.appendChild(count)
    return { chip, count }
  }

  private buildGlyphChip(): { chip: HTMLDivElement; glyph: HTMLSpanElement; count: HTMLSpanElement } {
    const chip = el('div', 'hud-chip')
    const glyph = el('span', 'hud-chip-glyph')
    const count = el('span', 'hud-chip-count')
    chip.append(glyph, count)
    return { chip, glyph, count }
  }

  /** One labeled range row for the pause panel. `format` renders the live
   * value label; `onCommit` fires on 'change' (drag release), matching the
   * 'input' (live label)/'change' (commit) split ui/menu.ts's own settings
   * sliders use. */
  private buildPauseSlider(
    parent: HTMLElement,
    label: string,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
    onCommit: (v: number) => void
  ): PauseSlider {
    const row = el('div', 'field field--slider')
    const lbl = el('label', 'field-label')
    lbl.textContent = label
    row.appendChild(lbl)
    const input = el('input', 'range-input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    const value = el('span', 'field-value')
    input.addEventListener('input', () => {
      value.textContent = format(Number(input.value))
    })
    input.addEventListener('change', () => {
      onCommit(Number(input.value))
    })
    row.append(input, value)
    parent.appendChild(row)
    return { input, value }
  }

  /** Writes into the same settings store + localStorage key ui/menu.ts's
   * settings panel uses -- main.ts's store.subscribe() (volume -> audio)
   * and game.ts's per-frame store.state.settings.sensitivity read both pick
   * this up with no extra wiring needed here. */
  private patchSettings(patch: Partial<Settings>): void {
    const settings = { ...store.state.settings, ...patch }
    saveSettings(settings)
    store.set({ settings })
  }

  /** Pulls current values into the pause sliders. Called only on the
   * false->true pause transition (see setInputPaused) -- calling this every
   * frame while paused would fight a slider being actively dragged, since
   * the range input's own 'input' listener updates the label live but
   * hasn't committed to the store yet. */
  private refreshPauseSliders(): void {
    const s = store.state.settings
    this.pauseSensSlider.input.value = String(s.sensitivity || DEFAULT_SENSITIVITY)
    this.pauseSensSlider.value.textContent = (s.sensitivity || DEFAULT_SENSITIVITY).toFixed(4)
    this.pausePadSlider.input.value = String(s.padSensitivity || DEFAULT_PAD_SENSITIVITY)
    this.pausePadSlider.value.textContent = (s.padSensitivity || DEFAULT_PAD_SENSITIVITY).toFixed(1)
    this.pauseFovSlider.input.value = String(s.fov || DEFAULT_FOV)
    this.pauseFovSlider.value.textContent = `${Math.round(s.fov || DEFAULT_FOV)}°`
    this.pauseVolSlider.input.value = String(s.volume)
    this.pauseVolSlider.value.textContent = `${Math.round(s.volume * 100)}%`
  }

  private buildScoreboardTeam(team: Team): { el: HTMLDivElement; body: HTMLTableSectionElement } {
    const wrap = el('div', 'hud-scoreboard-team')
    const heading = el('div', `hud-scoreboard-heading hud-scoreboard-heading--${team === 0 ? 'cobalt' : 'ember'}`)
    heading.textContent = TEAM_NAME[team]
    const table = el('table', 'hud-scoreboard-table')
    const head = el('tr')
    for (const label of ['Name', 'K', 'D', 'C']) {
      const th = el('th')
      th.textContent = label
      head.appendChild(th)
    }
    const thead = el('thead')
    thead.appendChild(head)
    const body = el('tbody')
    table.append(thead, body)
    wrap.append(heading, table)
    return { el: wrap, body }
  }

  // ---- event processing (gated to run once per new snapshot tick) -------

  private processEvents(events: SnapshotMsg['events'], players: SnapPlayer[], localId: string | null): void {
    for (const ev of events) {
      if (ev.type === 'kill') {
        // Fall deaths (and any other self-inflicted death) come through as
        // killerId === victimId. The server itself never credits that as a
        // kill (MatchSim.killPlayer only bumps killer.kills when killerId
        // is set AND differs from the victim) -- only bumps the victim's
        // death count. Mirror that here: no kill tally, no hit marker, no
        // "own kill" highlight for a fall.
        const isSelfKill = ev.killerId === ev.victimId
        if (!isSelfKill) this.bumpTally(ev.killerId, 'kills', players)
        this.bumpTally(ev.victimId, 'deaths', players)
        this.addKillFeedEntry(ev.killerId, ev.victimId, ev.weapon, localId, isSelfKill)
        if (!isSelfKill && ev.killerId === localId) {
          this.showHitMarker(true, ev.head)
          const victimName = this.nameCache.get(ev.victimId) ?? '???'
          this.showKillBanner(victimName, ev.head)
        }
        if (ev.victimId === localId) {
          const local = players.find((p) => p.id === localId)
          if (local) {
            if (isSelfKill) this.deathCard.textContent = 'NO ONE TO BLAME'
            else this.showDeathCard(ev.killerId, ev.weapon, players, local)
          }
        }
      } else if (ev.type === 'capture') {
        this.bumpTally(ev.playerId, 'captures', players)
      } else if (ev.type === 'flag_taken' || ev.type === 'flag_dropped' || ev.type === 'flag_returned') {
        // `ev.team` is the flag's OWN team. So a flag_taken on MY team's flag
        // is the enemy stealing mine -- the bad case. Six variants, because
        // "flag taken" means opposite things depending on whose it is, and a
        // single neutral string is what makes CTF illegible.
        const localPlayer = players.find((p) => p.id === localId)
        if (localPlayer) {
          const ours = ev.team === localPlayer.team
          if (ev.type === 'flag_taken') {
            this.showCallout(ours ? 'YOUR FLAG HAS BEEN TAKEN' : 'ENEMY FLAG TAKEN', ours ? 'bad' : 'good')
          } else if (ev.type === 'flag_dropped') {
            this.showCallout(ours ? 'YOUR FLAG WAS DROPPED' : 'ENEMY FLAG DROPPED', ours ? 'bad' : 'neutral')
          } else {
            this.showCallout(ours ? 'YOUR FLAG IS SECURE' : 'ENEMY FLAG RETURNED', ours ? 'good' : 'bad')
          }
        }
      } else if (ev.type === 'shot' && ev.playerId === localId) {
        this.crosshairKickT = 0
      }
    }
  }

  private bumpTally(id: string, field: 'kills' | 'deaths' | 'captures', players: SnapPlayer[]): void {
    let entry = this.tally.get(id)
    if (!entry) {
      const found = players.find((p) => p.id === id)
      entry = { kills: 0, deaths: 0, captures: 0, team: found?.team ?? 0, bot: found?.bot ?? false }
      this.tally.set(id, entry)
    }
    entry[field] += 1
  }

  private addKillFeedEntry(
    killerId: string,
    victimId: string,
    weapon: string,
    localId: string | null,
    isSelfKill: boolean
  ): void {
    const victimName = this.nameCache.get(victimId) ?? '???'
    const entry = el('div', 'hud-killfeed-entry')
    if (isSelfKill) {
      // No killer segment for a self-death (e.g. a fall) -- there's no one
      // to credit, so don't imply one with an "X killed X" line.
      entry.textContent = `☠ ${victimName} fell`
    } else {
      const killerName = this.nameCache.get(killerId) ?? '???'
      if (killerId === localId) entry.classList.add('hud-killfeed-entry--own')
      entry.textContent = `${killerName} ▸ ${weaponDisplayName(weapon)} ▸ ${victimName}`
    }
    this.killfeed.prepend(entry)
    while (this.killfeed.children.length > KILLFEED_MAX) {
      this.killfeed.lastElementChild?.remove()
    }
    const t = setTimeout(() => {
      entry.remove()
      this.pendingTimeouts.delete(t)
    }, KILLFEED_MS)
    this.pendingTimeouts.add(t)
  }

  /** `kill` picks the stronger, longer-lived marker style + sound; a plain
   * damaging (non-lethal) hit uses the regular one. `head` layers the
   * headshot ding + a gold marker style on top of a kill. Public so game.ts
   * can fire it for a diffed "local shot damaged someone" hit -- see
   * game.ts's detectLocalHit() for why that has to be a heuristic (no
   * SimEvent on the wire distinguishes a hit from a miss). */
  showHitMarker(kill: boolean, head = false): void {
    this.hitmarker.classList.add('hud-hitmarker--show')
    this.hitmarker.classList.toggle('hud-hitmarker--kill', kill)
    this.hitmarker.classList.toggle('hud-hitmarker--head', head)
    audioEngine.play(kill ? 'hit_kill' : 'hit_tick')
    if (head) audioEngine.play('headshot')
    const t = setTimeout(
      () => {
        this.hitmarker.classList.remove('hud-hitmarker--show')
        this.pendingTimeouts.delete(t)
      },
      kill ? HITMARKER_KILL_MS : HITMARKER_MS
    )
    this.pendingTimeouts.add(t)
  }

  private showKillBanner(victimName: string, head: boolean): void {
    this.killStreakCount += 1
    this.killStreakRemaining = KILL_STREAK_WINDOW
    // The banner's counter is the single source of truth for multikills; the
    // announcer reads it rather than running a second window of its own.
    // Mirrors game.ts's onLocalKill()/spree pairing: a bark on the ladder
    // also gets a matching SFX layer.
    const bark = announcer.multikill(this.killStreakCount)
    if (bark === 'double_kill' || bark === 'triple_kill' || bark === 'overkill' || bark === 'killtacular') {
      audioEngine.playFileSound('multikill_impact')
    }

    this.killBannerTitle.textContent = `ELIMINATED ${victimName}${head ? ' — HEADSHOT' : ''}`
    this.killBannerStreak.textContent = KILL_STREAK_LABEL[this.killStreakCount] ?? (this.killStreakCount >= 4 ? `${this.killStreakCount}x ELIMINATION STREAK` : '')

    this.killBanner.classList.remove('hud-kill-banner--show')
    // Force a reflow so re-triggering the CSS animation on a rapid second
    // kill actually restarts it instead of being a no-op (class already set).
    void this.killBanner.offsetWidth
    this.killBanner.classList.add('hud-kill-banner--show')
    const t = setTimeout(() => {
      this.killBanner.classList.remove('hud-kill-banner--show')
      this.pendingTimeouts.delete(t)
    }, KILL_BANNER_MS)
    this.pendingTimeouts.add(t)
  }

  /** Called from game.ts when the local player's own health+shield just
   * dropped. `bearingRad` is the attacker's direction relative to the
   * player's facing (0 = ahead), or null when game.ts couldn't reliably
   * attribute a single source this tick (see game.ts's detectDamageTaken()
   * -- the wire protocol has no per-hit attacker field, only 'shot' events
   * with no target and 'explosion' events with a position, so direction is
   * a best-effort heuristic, not always available). */
  notifyDamageTaken(bearingRad: number | null): void {
    audioEngine.play('damage_taken')
    this.damageVignette.classList.remove('hud-vignette--pulse')
    void this.damageVignette.offsetWidth
    this.damageVignette.classList.add('hud-vignette--pulse')
    const t = setTimeout(() => {
      this.damageVignette.classList.remove('hud-vignette--pulse')
      this.pendingTimeouts.delete(t)
    }, DAMAGE_PULSE_MS)
    this.pendingTimeouts.add(t)

    if (bearingRad === null) return
    this.damageIndicator.style.transform = `rotate(${bearingRad}rad)`
    this.damageIndicator.classList.remove('hud-damage-indicator--show')
    void this.damageIndicator.offsetWidth
    this.damageIndicator.classList.add('hud-damage-indicator--show')
    const t2 = setTimeout(() => {
      this.damageIndicator.classList.remove('hud-damage-indicator--show')
      this.pendingTimeouts.delete(t2)
    }, DAMAGE_PULSE_MS)
    this.pendingTimeouts.add(t2)
  }

  /** Called from game.ts's shield-diff loop when the local player's own
   * shield just broke. Visual-only -- game.ts already plays the
   * 'shield_break' SFX from the same diff, so this doesn't duplicate it. */
  notifyShieldBreak(): void {
    this.shieldBreakVignette.classList.remove('hud-vignette--pulse')
    void this.shieldBreakVignette.offsetWidth
    this.shieldBreakVignette.classList.add('hud-vignette--pulse')
    const t = setTimeout(() => {
      this.shieldBreakVignette.classList.remove('hud-vignette--pulse')
      this.pendingTimeouts.delete(t)
    }, DAMAGE_PULSE_MS)
    this.pendingTimeouts.add(t)
  }

  // ---- per-frame local-player panels --------------------------------------

  private updateVitals(local: SnapPlayer): void {
    this.shieldFill.style.width = `${clamp(local.shield / MAX_SHIELD, 0, 1) * 100}%`
    const perPip = MAX_HEALTH / HEALTH_PIP_COUNT
    for (let i = 0; i < HEALTH_PIP_COUNT; i++) {
      const frac = clamp((local.health - i * perPip) / perPip, 0, 1)
      this.healthPips[i].style.width = `${frac * 100}%`
    }
  }

  private updateWeapons(local: SnapPlayer): void {
    for (let slot = 0 as 0 | 1; slot < 2; slot++) {
      const weaponId = local.weapons[slot]
      const def = WEAPONS[weaponId]
      const els = this.weaponRows[slot]
      els.name.textContent = def.name
      // An empty mag means the sim is mid-reload (it refills only when the
      // RELOAD_TIME lockout ends), so say so -- a dead trigger with no
      // explanation is indistinguishable from a broken gun.
      const reloading = local.ammo[slot] <= 0 && def.kind !== 'power_melee'
      els.ammo.textContent = reloading ? 'RELOADING' : `${local.ammo[slot]}/${def.magSize}`
      els.ammo.classList.toggle('hud-weapon-ammo--reloading', reloading)
      els.row.classList.toggle('hud-weapon-row--active', slot === local.activeWeapon)
    }
  }

  private updateLoadout(local: SnapPlayer): void {
    this.fragChip.count.textContent = String(local.grenades.frag)
    this.fragChip.chip.classList.toggle('hud-chip--empty', local.grenades.frag <= 0)
    this.magChip.count.textContent = String(local.grenades.mag)
    this.magChip.chip.classList.toggle('hud-chip--empty', local.grenades.mag <= 0)

    const eq = local.equipment
    this.equipGlyph.textContent = eq ? EQUIP_GLYPH[eq] : '–'
    this.equipCount.textContent = eq ? String(local.equipmentCharges) : ''
    this.equipChip.classList.toggle('hud-chip--empty', !eq)
  }

  private updateFlags(local: SnapPlayer, flags: FlagState[]): void {
    const ownFlag = flags[local.team]
    if (ownFlag?.state === 'carried') {
      this.ownFlagBanner.textContent = '▲ YOUR FLAG TAKEN'
      this.ownFlagBanner.className = 'hud-flag-banner hud-flag-banner--show hud-flag-banner--danger'
    } else if (ownFlag?.state === 'dropped') {
      this.ownFlagBanner.textContent = 'YOUR FLAG DROPPED'
      this.ownFlagBanner.className = 'hud-flag-banner hud-flag-banner--show hud-flag-banner--warn'
    } else {
      this.ownFlagBanner.className = 'hud-flag-banner'
    }

    if (local.carryingFlag !== null) {
      this.enemyFlagBanner.textContent = 'ENEMY FLAG SECURED'
      this.enemyFlagBanner.className = 'hud-flag-banner hud-flag-banner--show hud-flag-banner--ok'
    } else {
      this.enemyFlagBanner.className = 'hud-flag-banner'
    }
  }

  /** RESPAWN_DELAY-second countdown, started client-side the tick alive
   * flips false (the server carries no respawnAt on the wire -- see
   * SnapPlayer). Resets the moment alive flips back true. */
  private updateRespawn(local: SnapPlayer, dt: number): void {
    if (!local.alive) {
      this.respawnRemaining = this.prevAlive ? RESPAWN_DELAY : Math.max(0, this.respawnRemaining - dt)
      this.respawnOverlay.classList.add('hud-respawn--show')
      this.respawnCount.textContent = String(Math.ceil(this.respawnRemaining))
    } else {
      this.respawnOverlay.classList.remove('hud-respawn--show')
      this.respawnRemaining = 0
      // Cleared on revival so the next death can never flash the previous
      // killer's name in the frame before its own kill event arrives.
      this.deathCard.textContent = ''
    }
    this.prevAlive = local.alive
  }

  /** Persistent red vignette that ramps in under LOW_HEALTH_FRAC health,
   * plus a repeating heartbeat cue that speeds up as health drains toward
   * 0. Both silence themselves once the player is dead or back above the
   * threshold. */
  private updateLowHealthCue(local: SnapPlayer, dt: number): void {
    const frac = clamp(local.health / MAX_HEALTH, 0, 1)
    if (!local.alive || frac >= LOW_HEALTH_FRAC) {
      this.lowHealthVignette.style.opacity = '0'
      this.heartbeatRemaining = 0
      return
    }
    const severity = 1 - frac / LOW_HEALTH_FRAC // 0 at the threshold, 1 at 0 health
    this.lowHealthVignette.style.opacity = String(0.15 + severity * 0.55)

    this.heartbeatRemaining -= dt
    if (this.heartbeatRemaining <= 0) {
      audioEngine.play('heartbeat')
      this.heartbeatRemaining = HEARTBEAT_INTERVAL_MAX - severity * (HEARTBEAT_INTERVAL_MAX - HEARTBEAT_INTERVAL_MIN)
    }
  }

  private updateScoreStrip(scores: [number, number], timeLeft: number, localTeam: Team | null): void {
    this.scoreCobalt.textContent = String(scores[0])
    this.scoreEmber.textContent = String(scores[1])
    const clamped = Math.max(0, Math.ceil(timeLeft))
    const mins = Math.floor(clamped / 60)
    const secs = clamped % 60
    this.timer.textContent = `${mins}:${String(secs).padStart(2, '0')}`

    // Lead change: pure client-side diffing of a score the server already
    // sends. No protocol cost, and it gives the scoreline a pulse instead of
    // two numbers that quietly tick over.
    if (this.prevScores && localTeam !== null) {
      const leadOf = (s: [number, number]): Team | null =>
        s[0] === s[1] ? null : s[0] > s[1] ? 0 : 1
      const before = leadOf(this.prevScores)
      const after = leadOf(scores)
      if (before !== after && after !== null) {
        const mine = after === localTeam
        this.showCallout(mine ? 'YOU HAVE TAKEN THE LEAD' : `${TEAM_NAME[after].toUpperCase()} TAKES THE LEAD`, mine ? 'good' : 'bad')
        audioEngine.play('lead_change')
        announcer.speak(mine ? 'lead_taken' : 'lead_lost')
      }
    }
    this.prevScores = [scores[0], scores[1]]
  }

  /**
   * Motion tracker. Speed-gated, as in Halo: a player who stops or walks
   * slowly drops off it, which is what turns holding still into a tactic
   * rather than a waste of time.
   *
   * Reads only fields the snapshot already carries for every player with no
   * line-of-sight filter (see match.ts), so this is pure presentation -- no
   * protocol change, no sim change. `camo` hides a player outright.
   */
  private updateTracker(local: SnapPlayer, players: SnapPlayer[]): void {
    this.tracker.classList.toggle('hud-tracker--show', local.alive)
    if (!local.alive) return

    const fwd = forwardXZ(local.yaw)
    const right = rightXZ(local.yaw)
    let used = 0

    for (const p of players) {
      if (p.id === local.id || !p.alive || p.camo) continue
      if (Math.hypot(p.vel.x, p.vel.z) < TRACKER_MIN_SPEED) continue
      const dx = p.pos.x - local.pos.x
      const dz = p.pos.z - local.pos.z
      if (Math.hypot(dx, dz) > TRACKER_RANGE) continue

      // Yaw-relative: forward is up on the dial, right is right.
      const relRight = dx * right.x + dz * right.z
      const relFwd = dx * fwd.x + dz * fwd.z

      const blip = this.trackerBlip(used++)
      blip.style.left = `${50 + (relRight / TRACKER_RANGE) * 50}%`
      blip.style.top = `${50 - (relFwd / TRACKER_RANGE) * 50}%`
      blip.classList.toggle('hud-tracker-blip--enemy', p.team !== local.team)
      blip.style.display = ''
    }

    for (let i = used; i < this.trackerBlipPool.length; i++) {
      this.trackerBlipPool[i].style.display = 'none'
    }
  }

  private trackerBlip(i: number): HTMLDivElement {
    let blip = this.trackerBlipPool[i]
    if (!blip) {
      blip = el('div', 'hud-tracker-blip')
      this.trackerBlipPool.push(blip)
      this.trackerBlips.appendChild(blip)
    }
    return blip
  }

  /** Transient centre-screen line, used by the flag chain and lead changes.
   * Edge-triggered: the persistent flag icon banners stay level-triggered in
   * updateFlags, so the two never fight over the same state. */
  private showCallout(text: string, tone: 'good' | 'bad' | 'neutral'): void {
    this.calloutBanner.textContent = text
    this.calloutBanner.classList.remove('hud-callout--good', 'hud-callout--bad')
    if (tone !== 'neutral') this.calloutBanner.classList.add(`hud-callout--${tone}`)
    this.calloutBanner.classList.remove('hud-callout--show')
    void this.calloutBanner.offsetWidth // restart the animation on a rapid second callout
    this.calloutBanner.classList.add('hud-callout--show')
    const t = setTimeout(() => {
      this.calloutBanner.classList.remove('hud-callout--show')
      this.pendingTimeouts.delete(t)
    }, CALLOUT_MS)
    this.pendingTimeouts.add(t)
  }

  /** Who killed you, with what, and how far away -- rendered into the
   * respawn overlay, the one moment the player is guaranteed to be reading
   * the screen. Matters most against bots, who are otherwise anonymous. */
  private showDeathCard(killerId: string, weapon: string, players: SnapPlayer[], local: SnapPlayer): void {
    const killerName = this.nameCache.get(killerId) ?? '???'
    const killer = players.find((p) => p.id === killerId)
    const dist = killer
      ? Math.round(Math.hypot(killer.pos.x - local.pos.x, killer.pos.y - local.pos.y, killer.pos.z - local.pos.z))
      : null
    const parts = [weaponDisplayName(weapon)]
    if (dist !== null) parts.push(`${dist}m`)
    this.deathCard.textContent = `${killerName} — ${parts.join(' · ')}`
  }

  private updateScoreboard(players: SnapPlayer[]): void {
    const groups: [SnapPlayer[], SnapPlayer[]] = [[], []]
    for (const p of players) groups[p.team].push(p)
    this.renderScoreboardTeam(this.scoreboardCobaltBody, this.scoreboardRows[0], groups[0])
    this.renderScoreboardTeam(this.scoreboardEmberBody, this.scoreboardRows[1], groups[1])
  }

  /** Perf fix: this used to be an innerHTML wipe + full rebuild every frame
   * the scoreboard is held (up to 8 rows * 4 cells, every single frame).
   * Rows are now cached by player id in `rows` and only their textContent
   * is touched when a value actually changed; a row is only created or
   * removed when the roster for this team actually gained or lost someone. */
  private renderScoreboardTeam(body: HTMLTableSectionElement, rows: Map<string, ScoreboardRowEls>, players: SnapPlayer[]): void {
    const seen = new Set<string>()
    for (const p of players) {
      seen.add(p.id)
      let row = rows.get(p.id)
      if (!row) {
        row = this.buildScoreboardRow()
        rows.set(p.id, row)
        body.appendChild(row.tr)
      }
      const stats = this.tally.get(p.id)
      const name = p.bot ? `${p.name} [BOT]` : p.name
      if (row.name.textContent !== name) row.name.textContent = name
      const kills = String(stats?.kills ?? 0)
      if (row.kills.textContent !== kills) row.kills.textContent = kills
      const deaths = String(stats?.deaths ?? 0)
      if (row.deaths.textContent !== deaths) row.deaths.textContent = deaths
      const captures = String(stats?.captures ?? 0)
      if (row.captures.textContent !== captures) row.captures.textContent = captures
    }
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.tr.remove()
        rows.delete(id)
      }
    }
  }

  private buildScoreboardRow(): ScoreboardRowEls {
    const tr = el('tr')
    const name = el('td')
    const kills = el('td')
    const deaths = el('td')
    const captures = el('td')
    tr.append(name, kills, deaths, captures)
    return { tr, name, kills, deaths, captures }
  }
}
