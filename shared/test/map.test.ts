import { describe, it, expect } from 'vitest'
import { MAPS } from '../src/maps'
import { validateMap } from '../src/map'
import { WEAPONS } from '../src/weapons'

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

    it(`${name} places every power pickup pad legally`, () => {
      // powerPickups is optional (map.ts) -- a map without pads is fine.
      for (const [i, pad] of (map.powerPickups ?? []).entries()) {
        // The pad hands out a real weapon.
        expect(WEAPONS[pad.weapon], `${name} pad ${i} weapon ${pad.weapon}`).toBeDefined()
        // ...and respawns, rather than being a one-off.
        expect(pad.respawnSec, `${name} pad ${i} respawnSec`).toBeGreaterThan(0)
        // A pad buried inside a solid box is unreachable -- no player can
        // stand in it to collect. Strictly inside only: a pad sitting ON a
        // box's top face (e.g. bastion's railspike at y = 1.2 on the 1.2m
        // mid platform) is exactly the intended placement.
        const insideBox = map.boxes.find(
          (box) =>
            pad.pos.x > box.min.x &&
            pad.pos.x < box.max.x &&
            pad.pos.y > box.min.y &&
            pad.pos.y < box.max.y &&
            pad.pos.z > box.min.z &&
            pad.pos.z < box.max.z
        )
        expect(insideBox, `${name} pad ${i} (${pad.weapon}) is inside a box`).toBeUndefined()
      }
    })

    it(`${name} has a symmetric power pickup layout`, () => {
      // Same contract as the cover-box check above, and the same two
      // candidate transforms. A LONE pad is exempt: it can only be
      // self-symmetric by sitting on the transform's fixed point (the
      // origin for rotate180), and both single-pad maps deliberately place
      // theirs off it -- gutter's boomtube sits on the east rail because the
      // origin is inside the two launch pads' approach, and hairpin's
      // railspike sits at z = 28 because the high walkway roofs the joint.
      // gutter's is still exactly equidistant from both flag stands;
      // hairpin's sits on its mirror axis at the mouth of the U-joint,
      // which is the map's own contested feature (its launch pad is at
      // (0,0,26), 2m away) rather than a midpoint between the bases.
      const pads = (map.powerPickups ?? []).map((p) => ({ x: p.pos.x, z: p.pos.z }))
      if (pads.length < 2) return

      const TOL = 0.05
      const rotate180 = (c: { x: number; z: number }) => ({ x: -c.x, z: -c.z })
      const mirrorX = (c: { x: number; z: number }) => ({ x: -c.x, z: c.z })

      const isInvariantUnder = (transform: (c: { x: number; z: number }) => { x: number; z: number }) => {
        const remaining = [...pads]
        for (const c of pads) {
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
