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

    it(`${name} has a symmetric cover-box layout`, () => {
      // "Cover-class" boxes are identified by boxColors -- every map so far
      // tags them 0x3355bb (cobalt side) / 0xbb6633 (ember side). Floor and
      // base boxes are exempted from this check entirely: they're not
      // guaranteed symmetric under either transform below on every map
      // (e.g. hairpin's leg-floor and joint boxes are shaped around its
      // U-layout, not mirrored), and an imbalance there isn't the "one team
      // gets extra cover" bug this test exists to catch.
      const COVER_COLORS = new Set([0x3355bb, 0xbb6633])
      const covers = map.boxes
        .map((box, i) => ({ box, color: map.boxColors[i] }))
        .filter(({ color }) => COVER_COLORS.has(color))
        .map(({ box }) => ({ x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2 }))

      if (covers.length === 0) return

      const TOL = 0.05
      // Two candidate symmetries, either of which is a legitimate map
      // layout: full 180-degree rotation about the origin (gutter: one
      // straight lane, so swapping teams is the same as rotating the whole
      // map), and a left/right mirror that keeps z fixed (hairpin: a
      // U-shape where both legs run the same z-direction, so cover mirrors
      // leg-to-leg rather than end-to-end). A map's cover layout must be
      // internally consistent -- every box paired with exactly one other --
      // under at least one of these, applied uniformly to the whole set.
      const rotate180 = (c: { x: number; z: number }) => ({ x: -c.x, z: -c.z })
      const mirrorX = (c: { x: number; z: number }) => ({ x: -c.x, z: c.z })

      const isInvariantUnder = (transform: (c: { x: number; z: number }) => { x: number; z: number }) => {
        const remaining = [...covers]
        for (const c of covers) {
          const target = transform(c)
          const idx = remaining.findIndex((r) => Math.abs(r.x - target.x) < TOL && Math.abs(r.z - target.z) < TOL)
          if (idx === -1) return false
          remaining.splice(idx, 1)
        }
        return true
      }

      expect(isInvariantUnder(rotate180) || isInvariantUnder(mirrorX)).toBe(true)
    })
  }
})
