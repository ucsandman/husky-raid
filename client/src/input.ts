import type { PlayerInput } from '@riftlane/shared'

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

const PITCH_LIMIT = Math.PI / 2 - 0.01

/**
 * Pointer-lock mouselook + keyboard sampler. The protocol's `swap` field is
 * a toggle (server flips activeWeapon 0<->1 on cooldown, there's no
 * "select slot N"), so 1/2/wheel all just request one toggle pulse --
 * consumed on the next sample() so holding a key doesn't spam toggles.
 */
export class InputManager {
  private readonly keys = new Set<string>()
  private mouseDown = false
  private locked = false
  private yaw = 0
  private pitch = 0
  private swapPending = false

  constructor(
    private readonly canvas: HTMLElement,
    private readonly getSensitivity: () => number
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
  }

  private readonly onCanvasClick = (): void => {
    void this.canvas.requestPointerLock()
  }

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return
    const s = this.getSensitivity()
    this.yaw += e.movementX * s
    this.pitch -= e.movementY * s
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch))
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.locked || e.button !== 0) return
    this.mouseDown = true
  }

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseDown = false
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.locked || e.deltaY === 0) return
    this.swapPending = true
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.locked) return
    this.keys.add(e.code)
    if (e.code === KEY_SWAP_A || e.code === KEY_SWAP_B) this.swapPending = true
    if (e.code === KEY_SCOREBOARD) e.preventDefault() // don't let Tab move browser focus
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
  }

  private readonly onContextMenu = (e: Event): void => {
    if (this.locked) e.preventDefault()
  }

  isLocked(): boolean {
    return this.locked
  }

  /** True while the scoreboard key is held (HUD reads this each frame). */
  scoreboardHeld(): boolean {
    return this.keys.has(KEY_SCOREBOARD)
  }

  sample(seq: number, dt: number): PlayerInput {
    const forward = (this.keys.has(KEY_FORWARD) ? 1 : 0) - (this.keys.has(KEY_BACK) ? 1 : 0)
    const strafe = (this.keys.has(KEY_RIGHT) ? 1 : 0) - (this.keys.has(KEY_LEFT) ? 1 : 0)
    const swap = this.swapPending
    this.swapPending = false
    return {
      seq,
      dt,
      yaw: this.yaw,
      pitch: this.pitch,
      forward,
      strafe,
      jump: this.keys.has(KEY_JUMP),
      fire: this.mouseDown,
      melee: this.keys.has(KEY_MELEE),
      grenade: this.keys.has(KEY_GRENADE),
      equipment: this.keys.has(KEY_EQUIPMENT),
      swap,
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
  }
}
