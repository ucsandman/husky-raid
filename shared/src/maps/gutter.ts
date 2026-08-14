import type { GameMap } from '../map'

// Straight lane along z, ~60 long x 12 wide. Floor is split into a center
// lane plus two side rails, leaving two gutters (death pits) between them —
// like a bowling lane. Bases sit on raised platforms at the far ends.
export const gutter: GameMap = {
  name: 'gutter',
  boxes: [
    // base platforms (raised 0.5)
    { min: { x: -6, y: 0, z: -30 }, max: { x: 6, y: 0.5, z: -22 } }, // 0 cobalt base
    { min: { x: -6, y: 0, z: 22 }, max: { x: 6, y: 0.5, z: 30 } }, // 1 ember base
    // lane floor: center + rails, leaving gutters at x in [-4,-3] and [3,4]
    { min: { x: -3, y: -1, z: -22 }, max: { x: 3, y: 0, z: 22 } }, // 2 center lane
    { min: { x: -6, y: -1, z: -22 }, max: { x: -4, y: 0, z: 22 } }, // 3 left rail
    { min: { x: 4, y: -1, z: -22 }, max: { x: 6, y: 0, z: 22 } }, // 4 right rail
    // short bridges over the left gutter, at the teleporter alcove crossings,
    // so the walk edges to/from the alcove waypoints don't cross the pit
    { min: { x: -4, y: -1, z: -18.5 }, max: { x: -3, y: 0, z: -17.5 } }, // 5 gutter bridge, z=-18
    { min: { x: -4, y: -1, z: 17.5 }, max: { x: -3, y: 0, z: 18.5 } }, // 6 gutter bridge, z=+18
    // cover boxes, ~1m tall, staggered every ~6 units down the lane
    { min: { x: -2.7, y: 0, z: -18.7 }, max: { x: -1.3, y: 1, z: -17.3 } }, // 7
    { min: { x: 1.3, y: 0, z: -12.7 }, max: { x: 2.7, y: 1, z: -11.3 } }, // 8
    { min: { x: -2.7, y: 0, z: -6.7 }, max: { x: -1.3, y: 1, z: -5.3 } }, // 9
    { min: { x: 1.3, y: 0, z: 5.3 }, max: { x: 2.7, y: 1, z: 6.7 } }, // 10
    { min: { x: -2.7, y: 0, z: 11.3 }, max: { x: -1.3, y: 1, z: 12.7 } }, // 11
    { min: { x: 1.3, y: 0, z: 17.3 }, max: { x: 2.7, y: 1, z: 18.7 } }, // 12
  ],
  boxColors: [
    0x2244aa, // cobalt base
    0xaa5522, // ember base
    0x888888, // center lane
    0x777777, // left rail
    0x777777, // right rail
    0x777777, // gutter bridge
    0x777777, // gutter bridge
    0x3355bb, // cover (cobalt side)
    0x3355bb,
    0x3355bb,
    0xbb6633, // cover (ember side)
    0xbb6633,
    0xbb6633,
  ],
  launchPads: [
    { pos: { x: -1, y: 0, z: 0 }, radius: 1, velocity: { x: 0, y: 9, z: -10 } },
    { pos: { x: 1, y: 0, z: 0 }, radius: 1, velocity: { x: 0, y: 9, z: 10 } },
  ],
  teleporters: [{ a: { x: -5, y: 0, z: -18 }, b: { x: -5, y: 0, z: 18 }, radius: 1 }],
  spawns: [
    [
      { x: -3, y: 0.5, z: -27 },
      { x: -1, y: 0.5, z: -27 },
      { x: 1, y: 0.5, z: -27 },
      { x: 3, y: 0.5, z: -27 },
    ],
    [
      { x: -3, y: 0.5, z: 27 },
      { x: -1, y: 0.5, z: 27 },
      { x: 1, y: 0.5, z: 27 },
      { x: 3, y: 0.5, z: 27 },
    ],
  ],
  spawnYaw: [0, Math.PI],
  flagStands: [
    { x: 0, y: 0.5, z: -26 },
    { x: 0, y: 0.5, z: 26 },
  ],
  deathY: -10,
  waypoints: [
    { pos: { x: 0, y: 0.5, z: -26 } }, // 0 base cobalt
    { pos: { x: 0, y: 0, z: -18 } }, // 1 lane
    { pos: { x: 0, y: 0, z: -12 } }, // 2 lane
    { pos: { x: 0, y: 0, z: -6 } }, // 3 lane
    { pos: { x: 0, y: 0, z: 0 } }, // 4 mid
    { pos: { x: 0, y: 0, z: 6 } }, // 5 lane
    { pos: { x: 0, y: 0, z: 12 } }, // 6 lane
    { pos: { x: 0, y: 0, z: 18 } }, // 7 lane
    { pos: { x: 0, y: 0.5, z: 26 } }, // 8 base ember
    { pos: { x: -5, y: 0, z: -18 } }, // 9 teleporter alcove A
    { pos: { x: -5, y: 0, z: 18 } }, // 10 teleporter alcove B
    { pos: { x: -1, y: 0, z: 0 } }, // 11 launch pad, cobalt-ward
    { pos: { x: -1, y: 0, z: -9 } }, // 12 launch pad landing, cobalt side
    { pos: { x: 1, y: 0, z: 0 } }, // 13 launch pad, ember-ward
    { pos: { x: 1, y: 0, z: 9 } }, // 14 launch pad landing, ember side
  ],
  edges: [
    { from: 0, to: 1, kind: 'walk' },
    { from: 1, to: 2, kind: 'walk' },
    { from: 2, to: 3, kind: 'walk' },
    { from: 3, to: 4, kind: 'walk' },
    { from: 4, to: 5, kind: 'walk' },
    { from: 5, to: 6, kind: 'walk' },
    { from: 6, to: 7, kind: 'walk' },
    { from: 7, to: 8, kind: 'walk' },
    { from: 1, to: 9, kind: 'walk' },
    { from: 9, to: 10, kind: 'teleporter' },
    { from: 10, to: 7, kind: 'walk' },
    { from: 4, to: 11, kind: 'walk' },
    { from: 11, to: 12, kind: 'launchpad' },
    { from: 12, to: 2, kind: 'walk' },
    { from: 4, to: 13, kind: 'walk' },
    { from: 13, to: 14, kind: 'launchpad' },
    { from: 14, to: 6, kind: 'walk' },
  ],
}
