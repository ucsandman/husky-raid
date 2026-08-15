import type { PlayerInput } from '@riftlane/shared'
import { GamepadReader } from './gamepad'

const KEY_FORWARD = 'KeyW'
const KEY_BACK = 'KeyS'
const KEY_LEFT = 'KeyA'
const KEY_RIGHT = 'KeyD'
const KEY_JUMP = 'Space'
const KEY_MELEE = 'KeyF'
const KEY_GRENADE = 'KeyG'
const KEY_EQUIPMENT = 'KeyE'
const KEY_SWAP_A = 'Digit1'
const KEY_SWAP_B = 'Digit2'
const KEY_SCOREBOARD = 'Tab'
const KEY_SPRINT = 'ShiftLeft'
const KEY_SLIDE = 'ControlLeft'

const PITCH_LIMIT = Math.PI / 2 - 0.01

/** Aim assist, pad only: while the reticle is already on a player, the right
 * stick turns at this fraction of its normal rate. That is the whole of it
 * -- no magnetism, no bullet bending. It makes tracking a strafing target
 * possible on a thumbstick without ever aiming for the player, and it
 * cannot help a mouse, which does not need it. */
const PAD_AIM_ASSIST_SCALE = 0.55

// Keys whose default browser action (page scroll, focus move, browser
// shortcut) would fight the match now that onKeyDown no longer requires
// pointer lock -- a narrow allowlist, not every bound key, so menu keys
// like F/G/E/1/2 keep whatever native behavior they'd otherwise have.
const PREVENT_DEFAULT_KEYS = new Set([KEY_FORWARD, KEY_BACK, KEY_LEFT, KEY_RIGHT, KEY_JUMP, KEY_SLIDE, KEY_SCOREBOARD])

/**
 * Pointer-lock mouselook + keyboard sampler. The protocol's `swap` field is
 * a toggle (server flips activeWeapon 0<->1 on cooldown, there's no
 * "select slot N"), so 1/2/wheel all just request one toggle pulse --
 * consumed on the next sample() so holding a key doesn't spam toggles.
 *
 * Only mouselook (onMouseMove) requires pointer lock. Keyboard and mouse
 * BUTTON state are tracked independent of it: lock resolves ~100-200ms
 * after the click that requests it, so gating keydown/mousedown on
 * `locked` swallowed every match's first trigger pull, and everything
 * typed before lock landed. Losing lock (Escape, alt-tab, window blur)
 * clears all held state instead, so nothing stays phantom-pressed.
 *
 * A gamepad is a third source layered on top of the same fields (see
 * pollGamepad): its state is OR'd/added into the keyboard's, so nothing
 * about mouse and keyboard changes when a pad is plugged in, and a player
 * can use both at once.
 */
export class InputManager {
  private readonly keys = new Set<string>()
  private mouseDown = false
  private firePending = false // edge latch: catches a click+release faster than one sample() tick
  private adsDown = false
  private locked = false
  private yaw = 0
  private pitch = 0
  private swapPending = false
  private slidePending = false

  // ---- gamepad ----------------------------------------------------------
  private readonly gamepad = new GamepadReader()
  /** Held pad state, refreshed by pollGamepad() and merged in sample(). */
  private padForward = 0
  private padStrafe = 0
  private padFire = false
  private padAds = false
  private padJump = false
  private padMelee = false
  private padGrenade = false
  private padEquipment = false
  private padSprint = false
  private padScoreboard = false
  private padMenuPending = false
  /** True once the pad has been touched, false again the moment the mouse
   * actually moves. Drives whether a missing pointer lock counts as
   * "paused" -- a pad player never clicks, so never holds lock. */
  private padActive = false
  /** Set by game.ts whenever baseFov changes; pad look slows by this while
   * scoped, exactly as mouse look does. */
  private adsSensitivityMult = 1

  constructor(
    private readonly canvas: HTMLElement,
    private readonly getSensitivity: () => number,
    private readonly getPadSensitivity: () => number
  ) {
    this.canvas.addEventListener('click', this.onCanvasClick)
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    document.addEventListener('mousemove', this.onMouseMove)
    document.addEventListener('mousedown', this.onMouseDown)
    document.addEventListener('mouseup', this.onMouseUp)
    document.addEventListener('wheel', this.onWheel, { passive: true })
    document.addEventListener('keydown', this.onKeyDown)
    document.addEventListener('keyup', this.onKeyUp)
    document.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('blur', this.onBlur)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
  }

  private readonly onCanvasClick = (): void => {
    if (document.pointerLockElement === this.canvas) return // already locked -- don't re-request on every fire click
    this.canvas.requestPointerLock().catch(() => {
      // Refused (e.g. mid-Escape lockout). Nothing to do here beyond not
      // throwing an unhandled rejection -- isLocked() staying false is what
      // drives the HUD's "click to resume" overlay (see Hud.setInputPaused).
    })
  }

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas
    if (!this.locked) this.clearHeldState()
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    // A real mouse movement hands control back to mouse+keyboard. Checked
    // BEFORE the lock gate: a pad player never holds pointer lock, so
    // behind the gate this could never fire for them and the pause panel
    // stayed suppressed forever. Zero-delta moves don't count: browsers
    // emit those when the cursor is warped back to centre under pointer
    // lock, and one of those must not knock a pad player out of pad mode
    // mid-match.
    if (e.movementX !== 0 || e.movementY !== 0) this.padActive = false
    if (!this.locked) return
    const s = this.getSensitivity()
    // Moving the mouse right (positive movementX) must turn the view right,
    // i.e. decrease yaw under this project's "yaw=0 faces +z, yaw=PI faces
    // -z" convention (physics.ts's forward = (sin yaw, 0, cos yaw)) --
    // subtracting here, not adding, is what keeps mouse-look non-inverted.
    this.yaw -= e.movementX * s
    this.pitch -= e.movementY * s
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch))
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    // Physical button state, tracked whether or not lock is held yet -- the
    // click that ACQUIRES lock is itself a fire/ADS press, and lock resolves
    // asynchronously well after mousedown, so gating on `locked` here is
    // what swallowed every match's first trigger pull.
    if (e.button === 0) {
      this.mouseDown = true
      this.firePending = true
    } else if (e.button === 2) {
      this.adsDown = true
    }
  }

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseDown = false
    else if (e.button === 2) this.adsDown = false
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.locked || e.deltaY === 0) return
    this.swapPending = true
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Keyboard no longer requires pointer lock (see class doc), but it must
    // still ignore keys typed into a real menu field -- the name/room-code/
    // sensitivity/volume inputs in ui/menu.ts all sit on this same document
    // and would otherwise lose e.g. the W/A/S/D in a typed player name.
    if (!this.isGameTarget(e.target)) return
    if (PREVENT_DEFAULT_KEYS.has(e.code)) e.preventDefault() // stop scroll/focus-move/shortcuts on every repeat too, not just the first
    if (e.repeat) return // OS auto-repeat must not re-spam one-shot pulses (swap, slide)
    this.keys.add(e.code)
    if (e.code === KEY_SWAP_A || e.code === KEY_SWAP_B) this.swapPending = true
    if (e.code === KEY_SLIDE) this.slidePending = true
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
  }

  private readonly onContextMenu = (e: Event): void => {
    // Right mouse button drives ADS (see sample()) -- the browser's context
    // menu must never win that race, not only while lock happens to be held.
    if (this.isGameTarget(e.target)) e.preventDefault()
  }

  private readonly onBlur = (): void => {
    this.clearHeldState()
  }

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.clearHeldState()
  }

  /** A backgrounded tab delivers no keyup/mouseup for whatever was held at
   * the moment focus left -- the browser just stops sending events. Without
   * this, alt-tabbing away while holding W and the trigger comes back
   * running forward and firing with no key physically down. Called on
   * pointer-lock loss too (Escape, or the OS taking lock away), since that
   * has the identical "held state now has no way to self-correct" shape. */
  private clearHeldState(): void {
    this.keys.clear()
    this.mouseDown = false
    this.adsDown = false
    this.firePending = false
    this.clearPadState()
  }

  /** Same idea as clearHeldState for the pad half: a backgrounded tab (or an
   * unplugged controller) stops reporting, so whatever was held has no way
   * to release itself. padActive is deliberately NOT cleared here -- an
   * alt-tab shouldn't demote a pad player back to "click to resume". */
  private clearPadState(): void {
    this.padForward = 0
    this.padStrafe = 0
    this.padFire = false
    this.padAds = false
    this.padJump = false
    this.padMelee = false
    this.padGrenade = false
    this.padEquipment = false
    this.padSprint = false
    this.padScoreboard = false
  }

  /**
   * Reads the gamepad once per RENDER frame (not per sim tick): look is
   * integrated continuously into the same yaw/pitch the mouse writes, so
   * turning with the stick is as smooth as the display, and sample() stays
   * a pure read of whatever the last poll left behind.
   *
   * `scoped` slows look by the same ADS multiplier mouse look gets;
   * `onTarget` (the reticle is already over a player) applies aim assist.
   * Both come from game.ts, which is where the ADS state and the cosmetic
   * target raycast already live.
   */
  pollGamepad(dt: number, opts: { scoped: boolean; onTarget: boolean }): void {
    const lookScale =
      this.getPadSensitivity() *
      (opts.scoped ? this.adsSensitivityMult : 1) *
      (opts.onTarget ? PAD_AIM_ASSIST_SCALE : 1)
    const frame = this.gamepad.poll(dt, lookScale)
    if (!frame) {
      this.clearPadState()
      this.padActive = false
      return
    }
    if (frame.active) this.padActive = true

    this.yaw += frame.yawDelta
    this.pitch += frame.pitchDelta
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch))

    this.padForward = frame.forward
    this.padStrafe = frame.strafe
    this.padFire = frame.fire
    this.padAds = frame.ads
    this.padJump = frame.jump
    this.padMelee = frame.melee
    this.padGrenade = frame.grenade
    this.padEquipment = frame.equipment
    this.padSprint = frame.sprint
    this.padScoreboard = frame.scoreboard

    // Pulses land in the same latches the mouse and keyboard use, so a
    // trigger pull shorter than one sample() tick survives exactly as a
    // short click does.
    if (frame.firePressed) this.firePending = true
    if (frame.slidePressed) this.slidePending = true
    if (frame.swapPressed) this.swapPending = true
    if (frame.menuPressed) this.padMenuPending = true
  }

  /** True while the player is driving with a pad. game.ts uses this to keep
   * the "click to resume" overlay off screen for someone who never clicked. */
  isPadActive(): boolean {
    return this.padActive
  }

  /** One-shot: was Start pressed since the last call? */
  consumePadMenuToggle(): boolean {
    const pressed = this.padMenuPending
    this.padMenuPending = false
    return pressed
  }

  /** game.ts computes the ADS sensitivity multiplier from the live FOV
   * setting; pad look needs the same number and has no other way to get it. */
  setAdsSensitivityMult(mult: number): void {
    this.adsSensitivityMult = mult
  }

  /** True for a keydown/contextmenu whose target is the match itself (the
   * canvas, or the page body when nothing has stolen focus) rather than a
   * menu control. Pointer lock doesn't move DOM focus, so during an actual
   * match this is always true; it only matters on the menu/lobby screens,
   * where it lets Tab/Space/WASD keep working normally inside real form
   * fields and buttons instead of being hijacked as game input. */
  private readonly isGameTarget = (target: EventTarget | null): boolean =>
    target === document.body || target === this.canvas

  isLocked(): boolean {
    return this.locked
  }

  /** Latest continuous look angles, updated on every mousemove -- unlike
   * `sample()`'s yaw/pitch this isn't stepped to the network's fixed-dt
   * input ticks, so it's smooth enough to drive client-only viewmodel sway
   * off the render loop's own dt without waiting on 20Hz snapshots. */
  getLookAngles(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch }
  }

  /** True while the scoreboard key (or the pad's View button) is held --
   * the HUD reads this each frame. */
  scoreboardHeld(): boolean {
    return this.keys.has(KEY_SCOREBOARD) || this.padScoreboard
  }

  sample(seq: number, dt: number): PlayerInput {
    // Keyboard and pad are additive on both move axes, then clamped: the
    // sim clamps them anyway (shared/src/physics.ts), and holding W while
    // pushing the stick forward must be "forward", not "double speed".
    const keyForward = (this.keys.has(KEY_FORWARD) ? 1 : 0) - (this.keys.has(KEY_BACK) ? 1 : 0)
    const keyStrafe = (this.keys.has(KEY_RIGHT) ? 1 : 0) - (this.keys.has(KEY_LEFT) ? 1 : 0)
    const forward = Math.max(-1, Math.min(1, keyForward + this.padForward))
    const strafe = Math.max(-1, Math.min(1, keyStrafe + this.padStrafe))
    const swap = this.swapPending
    this.swapPending = false
    const slideRequest = this.slidePending
    this.slidePending = false
    // mouseDown alone can miss a click+release that both land inside one
    // ~33ms gap between samples; firePending latches the edge so that click
    // still reports fire=true on the next sample() no matter how short it was.
    const fire = this.mouseDown || this.firePending || this.padFire
    this.firePending = false
    return {
      seq,
      dt,
      yaw: this.yaw,
      pitch: this.pitch,
      forward,
      strafe,
      jump: this.keys.has(KEY_JUMP) || this.padJump,
      fire,
      melee: this.keys.has(KEY_MELEE) || this.padMelee,
      grenade: this.keys.has(KEY_GRENADE) || this.padGrenade,
      equipment: this.keys.has(KEY_EQUIPMENT) || this.padEquipment,
      swap,
      sprint: this.keys.has(KEY_SPRINT) || this.padSprint,
      slideRequest,
      ads: this.adsDown || this.padAds,
    }
  }

  dispose(): void {
    this.canvas.removeEventListener('click', this.onCanvasClick)
    document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    document.removeEventListener('mousemove', this.onMouseMove)
    document.removeEventListener('mousedown', this.onMouseDown)
    document.removeEventListener('mouseup', this.onMouseUp)
    document.removeEventListener('wheel', this.onWheel)
    document.removeEventListener('keydown', this.onKeyDown)
    document.removeEventListener('keyup', this.onKeyUp)
    document.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('blur', this.onBlur)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
  }
}
