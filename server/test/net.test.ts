import { describe, it, expect } from 'vitest'
import { sanitizeName } from '../src/net'

describe('net: sanitizeName at the hello trust boundary (fix 3)', () => {
  it('passes through a normal string name unchanged', () => {
    expect(sanitizeName('Alice')).toBe('Alice')
  })

  it('truncates names longer than 24 chars', () => {
    const long = 'x'.repeat(50)
    expect(sanitizeName(long)).toBe('x'.repeat(24))
  })

  it('falls back to Player for a non-string name', () => {
    expect(sanitizeName(12345 as unknown as string)).toBe('Player')
    expect(sanitizeName(null as unknown as string)).toBe('Player')
    expect(sanitizeName(undefined as unknown as string)).toBe('Player')
    expect(sanitizeName({} as unknown as string)).toBe('Player')
  })
})
