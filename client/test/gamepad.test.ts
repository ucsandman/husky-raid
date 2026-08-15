import { describe, it, expect } from 'vitest'
import { GamepadReader, type PadSnapshot } from '../src/gamepad'

/**
 * The pad is the one input path with no way to eyeball it in a unit test
 * environment (no Gamepad API in node, no hands on a controller in CI), so
 * every rule that would be a silent, unplayable bug lives here: deadzone,
 * stick direction against the mouse convention, and the edge latches that
 * make a tap register exactly once.
 */

const DT = 1 / 60

function pad(axes: number[], pressedIdx: number[] = [], values: Record<number, number> = {}): PadSnapshot {
  return {
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({
      pressed: pressedIdx.includes(i),
      value: values[i] ?? (pressedIdx.includes(i) ? 1 : 0),
    })),
  }
}

/** Sticks centred. */
const CENTRED = [0, 0, 0, 0]

function reader(get: () => PadSnapshot | null): GamepadReader {
  return new GamepadReader(get)
}

describe('GamepadReader sticks', () => {
  it('returns null when no standard-mapping pad is connected', () => {
    expect(reader(() => null).poll(DT, 1)).toBeNull()
  })

  it('ignores movement inside the radial deadzone', () => {
    const f = reader(() => pad([0.12, -0.12, 0.1, 0.1])).poll(DT, 1)!
    expect(f.forward).toBe(0)
    expect(f.strafe).toBe(0)
    expect(f.yawDelta).toBe(0)
    expect(f.pitchDelta).toBe(0)
    expect(f.active).toBe(false)
  })

  it('maps a full forward push to forward = 1', () => {
    const f = reader(() => pad([0, -1, 0, 0])).poll(DT, 1)!
    expect(f.forward).toBeCloseTo(1, 5)
    expect(f.strafe).toBeCloseTo(0, 5)
    expect(f.active).toBe(true)
  })

  it('rescales past the deadzone so the first usable input is near zero', () => {
    const f = reader(() => pad([0, -0.2, 0, 0])).poll(DT, 1)!
    expect(f.forward).toBeGreaterThan(0)
    expect(f.forward).toBeLessThan(0.05)
  })

  it('never exceeds full throttle on a diagonal', () => {
    const f = reader(() => pad([1, -1, 0, 0])).poll(DT, 1)!
    expect(Math.abs(f.forward)).toBeLessThanOrEqual(1)
    expect(Math.abs(f.strafe)).toBeLessThanOrEqual(1)
  })

  it('turns right and looks up the same way the mouse does', () => {
    // Right stick right: yaw must DECREASE (input.ts subtracts movementX).
    const right = reader(() => pad([0, 0, 1, 0])).poll(DT, 1)!
    expect(right.yawDelta).toBeLessThan(0)
    // Right stick up is axis -1 and must raise pitch (look up, not down).
    const up = reader(() => pad([0, 0, 0, -1])).poll(DT, 1)!
    expect(up.pitchDelta).toBeGreaterThan(0)
  })

  it('scales look by lookScale, which is where sensitivity and aim assist land', () => {
    const full = reader(() => pad([0, 0, -1, 0])).poll(DT, 1)!.yawDelta
    const assisted = reader(() => pad([0, 0, -1, 0])).poll(DT, 0.55)!.yawDelta
    expect(assisted).toBeCloseTo(full * 0.55, 6)
  })

  it('squashes small right-stick input via the x*|x| response curve', () => {
    const half = reader(() => pad([0, 0, -0.59, 0])).poll(DT, 1)!.yawDelta
    const full = reader(() => pad([0, 0, -1, 0])).poll(DT, 1)!.yawDelta
    // ~0.5 after deadzone rescale, curved to ~0.25 -- well under linear.
    expect(half / full).toBeLessThan(0.35)
    expect(half / full).toBeGreaterThan(0.15)
  })
})

describe('GamepadReader buttons', () => {
  it('treats a trigger as pulled only past the threshold', () => {
    expect(reader(() => pad(CENTRED, [], { 7: 0.3 })).poll(DT, 1)!.fire).toBe(false)
    expect(reader(() => pad(CENTRED, [], { 7: 0.4 })).poll(DT, 1)!.fire).toBe(true)
    expect(reader(() => pad(CENTRED, [], { 6: 0.9 })).poll(DT, 1)!.ads).toBe(true)
  })

  it('reports each pulse exactly once while the button stays held', () => {
    let held = true
    const r = reader(() => pad(CENTRED, held ? [1, 3, 9] : [], { 7: held ? 1 : 0 }))

    const first = r.poll(DT, 1)!
    expect(first.firePressed).toBe(true)
    expect(first.slidePressed).toBe(true)
    expect(first.swapPressed).toBe(true)
    expect(first.menuPressed).toBe(true)

    const second = r.poll(DT, 1)!
    expect(second.firePressed).toBe(false)
    expect(second.slidePressed).toBe(false)
    expect(second.swapPressed).toBe(false)
    expect(second.menuPressed).toBe(false)
    expect(second.fire).toBe(true) // still HELD, just no new edge

    held = false
    expect(r.poll(DT, 1)!.fire).toBe(false)
    held = true
    expect(r.poll(DT, 1)!.firePressed).toBe(true) // a second tap registers
  })

  it('maps the held buttons to the actions the sim understands', () => {
    const f = reader(() => pad(CENTRED, [0, 2, 4, 5, 8, 10])).poll(DT, 1)!
    expect(f.jump).toBe(true) // A
    expect(f.equipment).toBe(true) // X
    expect(f.melee).toBe(true) // LB
    expect(f.grenade).toBe(true) // RB
    expect(f.scoreboard).toBe(true) // View
    expect(f.sprint).toBe(true) // L3
  })
})
