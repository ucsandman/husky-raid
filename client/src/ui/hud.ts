import type { EquipmentId, FlagState, ServerMsg, SnapPlayer, Team, WeaponId } from '@riftlane/shared'
import { MAX_HEALTH, MAX_SHIELD, RESPAWN_DELAY, WEAPONS, clamp } from '@riftlane/shared'
import { audioEngine } from '../audio'
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
const DAMAGE_PULSE_MS = 450
const LOW_HEALTH_FRAC = 0.25
const HEARTBEAT_INTERVAL_MAX = 1.1 // seconds, at exactly the 25% threshold
const HEARTBEAT_INTERVAL_MIN = 0.55 // seconds, at 0 health -- faster as health drains

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
  private readonly inputPausedOverlay: HTMLDivElement
  private readonly scoreboard: HTMLDivElement
  private readonly scoreboardCobaltBody: HTMLTableSectionElement
  private readonly scoreboardEmberBody: HTMLTableSectionElement

  private readonly nameCache = new Map<string, string>()
  private readonly tally = new Map<string, TallyEntry>()
  private readonly pendingTimeouts = new Set<ReturnType<typeof setTimeout>>()

  private lastProcessedTick: number | null = null
  private prevAlive = true
  private respawnRemaining = 0
  private crosshairKickT = 1 // 1 = fully recovered, 0 = just fired
  private killStreakCount = 0
  private killStreakRemaining = 0
  private heartbeatRemaining = 0

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
    this.respawnOverlay.append(respawnTitle, this.respawnCount)
    this.root.appendChild(this.respawnOverlay)

    this.inputPausedOverlay = el('div', 'hud-input-paused')
    const pausedTitle = el('div', 'hud-input-paused-title')
    pausedTitle.textContent = 'CLICK TO RESUME'
    const pausedHint = el('div', 'hud-input-paused-hint')
    pausedHint.textContent = 'Mouse look and match input are paused'
    this.inputPausedOverlay.append(pausedTitle, pausedHint)
    this.root.appendChild(this.inputPausedOverlay)

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
      this.root.classList.toggle('hud--camo', localSnap.camo)
    } else {
      this.lowHealthVignette.style.opacity = '0'
    }

    if (this.killStreakRemaining > 0) {
      this.killStreakRemaining -= dt
      if (this.killStreakRemaining <= 0) this.killStreakCount = 0
    }

    this.updateScoreStrip(snap.scores, snap.timeLeft)
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
  }

  /** Toggled by the game every frame from InputManager.isLocked() (or on a
   * pointerlockchange callback) to show a centered "click to resume"
   * overlay whenever mouse/keyboard input is paused mid-match -- lock lost
   * to Escape, alt-tab, or window blur all land here. This is the fix for a
   * failure mode this project already shipped once: input silently dying
   * with nothing on screen to explain why (docs/ERRORS.md, 2026-08-14).
   * The overlay is a child of `root`, which is pointer-events:none end to
   * end -- it must stay that way, or it eats the very click that would
   * re-acquire lock and recover from this state. */
  setInputPaused(paused: boolean): void {
    this.inputPausedOverlay.classList.toggle('hud-input-paused--show', paused)
  }

  /** CSS-only aim-down-sights vignette + reticle. The caller (whoever drives
   * the camera zoom off InputManager's `ads` sample) just toggles this each
   * frame; it also hides the regular crosshair so scoping doesn't leave two
   * reticles on screen at once. Visual only -- no camera/FOV logic here. */
  setScoped(active: boolean): void {
    this.scopeOverlay.classList.toggle('hud-scope--show', active)
    this.crosshair.classList.toggle('hud-crosshair--hidden', active)
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
    const reticle = el('div', 'hud-scope-reticle')
    for (const dir of ['n', 's', 'w', 'e'] as const) {
      reticle.appendChild(el('div', `hud-scope-reticle-line hud-scope-reticle-line--${dir}`))
    }
    wrap.appendChild(reticle)
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
      } else if (ev.type === 'capture') {
        this.bumpTally(ev.playerId, 'captures', players)
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

  private updateScoreStrip(scores: [number, number], timeLeft: number): void {
    this.scoreCobalt.textContent = String(scores[0])
    this.scoreEmber.textContent = String(scores[1])
    const clamped = Math.max(0, Math.ceil(timeLeft))
    const mins = Math.floor(clamped / 60)
    const secs = clamped % 60
    this.timer.textContent = `${mins}:${String(secs).padStart(2, '0')}`
  }

  private updateScoreboard(players: SnapPlayer[]): void {
    const groups: [SnapPlayer[], SnapPlayer[]] = [[], []]
    for (const p of players) groups[p.team].push(p)
    this.renderScoreboardTeam(this.scoreboardCobaltBody, groups[0])
    this.renderScoreboardTeam(this.scoreboardEmberBody, groups[1])
  }

  private renderScoreboardTeam(body: HTMLTableSectionElement, players: SnapPlayer[]): void {
    body.innerHTML = '' // safe: only ever holds rows built below via textContent, no untrusted HTML
    for (const p of players) {
      const stats = this.tally.get(p.id)
      const tr = el('tr')
      const nameTd = el('td')
      nameTd.textContent = p.bot ? `${p.name} [BOT]` : p.name
      const kTd = el('td')
      kTd.textContent = String(stats?.kills ?? 0)
      const dTd = el('td')
      dTd.textContent = String(stats?.deaths ?? 0)
      const cTd = el('td')
      cTd.textContent = String(stats?.captures ?? 0)
      tr.append(nameTd, kTd, dTd, cTd)
      body.appendChild(tr)
    }
  }
}
