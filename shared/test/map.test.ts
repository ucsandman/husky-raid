import { describe, it, expect } from 'vitest'
import { MAPS } from '../src/maps'
import { validateMap } from '../src/map'

describe('maps', () => {
  for (const [name, map] of Object.entries(MAPS)) {
    it(`${name} is valid`, () => {
      expect(validateMap(map)).toEqual([])
      expect(map.spawns[0].length).toBeGreaterThanOrEqual(4)
      expect(map.spawns[1].length).toBeGreaterThanOrEqual(4)
    })
    it(`${name} is mirror-symmetric in flag stands`, () => {
      // stands mirror across z=0 plane
      expect(map.flagStands[0].z).toBeCloseTo(-map.flagStands[1].z)
    })
  }
})
