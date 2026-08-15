/**
 * Xbox-layout gamepad reader. Owns nothing but the pad's own edge state --
 * InputManager folds the frame this returns into the same yaw/pitch/keys it
 * already tracks for mouse and keyboard, so the two are additive and a
 * player can hold the stick and press W at once without either winning.
 *
 * Standard mapping only (`Gamepad.mapping === 'standard'`, which every
 * Xbox/PlayStation pad reports on Chrome/Firefox/Safari). A pad that
 * reports something else is ignored rather than guessed at: the button
 * indices below are meaningless without it, and firing the wrong action is
 * worse than doing nothing.
 */

/** Structural subset of the DOM Gamepad this module actually reads. Keeping
 * it structural is what lets the reader be driven by a fake in tests --
 * there is no Gamepad constructor to build one with. */
export interface PadSnapshot {
  buttons: readonly { pressed: boolean; value: number }[]
  axes: readonly number[]
}

/** One render frame's worth of pad state, already deadzoned, curved and
 * (for look) integrated into radians-per-this-frame. */
export interface PadFrame {
  /** Analog move axes in [-1,1], same convention as PlayerInput. */
  forward: number
  strafe: number
  /** Look deltas for THIS frame, in radians. Sign convention matches
   * input.ts's mouse handler: right stick right lowers yaw, up raises pitch. */
  yawDelta: number
  pitchDelta: number
  fire: boolean
  ads: boolean
  jump: boolean
  melee: boolean
  grenade: boolean
  equipment: boolean
  sprint: boolean
  scoreboard: boolean
  /** Rising edges -- true for exactly one frame per press. */
  firePressed: boolean
  slidePressed: boolean
  swapPressed: boolean
  menuPressed: boolean
  /** Anything at all is being touched this frame. */
  active: boolean
}

// Standard-mapping indices.
const BTN_A = 0
const BTN_B = 1
const BTN_X = 2
const BTN_Y = 3
const BTN_LB = 4
const BTN_RB = 5
const BTN_LT = 6
const BTN_RT = 7
const BTN_VIEW = 8
const BTN_START = 9
const BTN_L3 = 10

const AXIS_LX = 0
const AXIS_LY = 1
const AXIS_RX = 2
const AXIS_RY = 3

/** Radial (not per-axis) deadzone: a square deadzone lets a stick pushed
 * diagonally past the corner leak input on an axis the player thinks is
 * centred, which reads as drift. */
const DEADZONE = 0.18
/** Analog trigger travel that counts as a pull. Xbox triggers rest at ~0.02
 * and are unambiguously pulled well before half. */
const TRIGGER_THRESHOLD = 0.35
/** Base turn rates at padSensitivity 1, radians/second. Yaw is faster than
 * pitch on purpose: horizontal tracking is most of aiming, and a pitch axis
 * this quick overshoots on a stick with a fraction of a mouse's travel. */
const LOOK_YAW_RATE = 3.0
const LOOK_PITCH_RATE = 2.1

/** Right-stick response curve. x*|x| keeps the sign, leaves full deflection
 * at 1:1, and squashes the small-input end so fine aim is possible on a
 * stick whose usable travel is about a centimetre. */
function curve(v: number): number {
  return v * Math.abs(v)
}

function defaultSource(): PadSnapshot | null {
  const nav = typeof navigator === 'undefined' ? null : navigator
  if (!nav?.getGamepads) return null
  for (const pad of nav.getGamepads()) {
    if (pad?.connected && pad.mapping === 'standard') return pad
  }
  return null
}

function pressed(pad: PadSnapshot, index: number): boolean {
  return pad.buttons[index]?.pressed === true
}

function pulled(pad: PadSnapshot, index: number): boolean {
  const btn = pad.buttons[index]
  if (!btn) return false
  // Digital-only pads report value 0 with pressed true; take either.
  return btn.value > TRIGGER_THRESHOLD || btn.pressed
}

export class GamepadReader {
  /** Reused across frames -- poll() runs every render frame and must not
   * allocate. Callers read it and are done with it inside the frame. */
  private readonly frame: PadFrame = {
    forward: 0,
    strafe: 0,
    yawDelta: 0,
    pitchDelta: 0,
    fire: false,
    ads: false,
    jump: false,
    melee: false,
    grenade: false,
    equipment: false,
    sprint: false,
    scoreboard: false,
    firePressed: false,
    slidePressed: false,
    swapPressed: false,
    menuPressed: false,
    active: false,
  }
  private prevFire = false
  private prevSlide = false
  private prevSwap = false
  private prevMenu = false

  constructor(private readonly source: () => PadSnapshot | null = defaultSource) {}

  /**
   * Reads the pad once. `lookScale` multiplies both look rates (the caller
   * folds pad sensitivity, the ADS multiplier and aim assist into it).
   * Returns null when no standard-mapping pad is connected -- the caller
   * treats that as "clear everything the pad was holding".
   */
  poll(dt: number, lookScale: number): PadFrame | null {
    const pad = this.source()
    if (!pad) {
      this.prevFire = this.prevSlide = this.prevSwap = this.prevMenu = false
      return null
    }
    const f = this.frame

    const lx = pad.axes[AXIS_LX] ?? 0
    const ly = pad.axes[AXIS_LY] ?? 0
    const moveMag = Math.hypot(lx, ly)
    if (moveMag > DEADZONE) {
      // Rescale so the first millimetre past the deadzone is a genuine 0,
      // not a step to 0.18 -- then clamp, because a stick that overreports
      // past 1 on the diagonal would otherwise be a free speed boost.
      const k = Math.min(1, (moveMag - DEADZONE) / (1 - DEADZONE)) / moveMag
      f.strafe = Math.max(-1, Math.min(1, lx * k))
      f.forward = Math.max(-1, Math.min(1, -ly * k)) // stick up is axis -1, and up means forward
    } else {
      f.forward = 0
      f.strafe = 0
    }

    const rx = pad.axes[AXIS_RX] ?? 0
    const ry = pad.axes[AXIS_RY] ?? 0
    const lookMag = Math.hypot(rx, ry)
    if (lookMag > DEADZONE) {
      const k = Math.min(1, (lookMag - DEADZONE) / (1 - DEADZONE)) / lookMag
      // Mouse-right lowers yaw (see input.ts's onMouseMove) -- stick-right
      // has to do the same or the pad would look inverted against the mouse.
      f.yawDelta = -curve(rx * k) * LOOK_YAW_RATE * lookScale * dt
      f.pitchDelta = -curve(ry * k) * LOOK_PITCH_RATE * lookScale * dt
    } else {
      f.yawDelta = 0
      f.pitchDelta = 0
    }

    const fire = pulled(pad, BTN_RT)
    const slide = pressed(pad, BTN_B)
    const swap = pressed(pad, BTN_Y)
    const menu = pressed(pad, BTN_START)

    f.fire = fire
    f.ads = pulled(pad, BTN_LT)
    f.jump = pressed(pad, BTN_A)
    f.melee = pressed(pad, BTN_LB)
    f.grenade = pressed(pad, BTN_RB)
    f.equipment = pressed(pad, BTN_X)
    f.sprint = pressed(pad, BTN_L3)
    f.scoreboard = pressed(pad, BTN_VIEW)
    f.firePressed = fire && !this.prevFire
    f.slidePressed = slide && !this.prevSlide
    f.swapPressed = swap && !this.prevSwap
    f.menuPressed = menu && !this.prevMenu
    this.prevFire = fire
    this.prevSlide = slide
    this.prevSwap = swap
    this.prevMenu = menu

    f.active =
      f.forward !== 0 ||
      f.strafe !== 0 ||
      f.yawDelta !== 0 ||
      f.pitchDelta !== 0 ||
      f.fire ||
      f.ads ||
      f.jump ||
      f.melee ||
      f.grenade ||
      f.equipment ||
      f.sprint ||
      f.scoreboard ||
      menu ||
      slide ||
      swap

    return f
  }
}
