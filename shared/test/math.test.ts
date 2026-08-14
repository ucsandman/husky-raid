import { describe, it, expect } from 'vitest'
import { v3, add, scale, normalize, length, clamp } from '../src/math'

describe('math', () => {
  it('adds and scales vectors', () => {
    expect(add(v3(1, 2, 3), v3(4, 5, 6))).toEqual({ x: 5, y: 7, z: 9 })
    expect(scale(v3(1, -2, 3), 2)).toEqual({ x: 2, y: -4, z: 6 })
  })
  it('normalizes and measures', () => {
    const n = normalize(v3(3, 0, 4))
    expect(length(n)).toBeCloseTo(1)
    expect(normalize(v3(0, 0, 0))).toEqual({ x: 0, y: 0, z: 0 })
  })
  it('clamps', () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-1, 0, 3)).toBe(0)
  })
})
