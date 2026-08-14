import type { GameMap } from '../map'

// U-shape: two parallel lanes at x = -10 / x = +10, joined by a floor bridge
// at the top of the U (z ~ 30-39). Bases mirror across z = 0 per the map
// schema's mirror-symmetry contract: cobalt at (x:-10, z:-25), ember at
// (x:10, z:25) — near the joint, so the loop back down its own leg is short.
// A teleporter pair cuts straight across the U's gap at z = -10, well
// shorter than walking all the way around through the joint. A launch pad
// and grapple-tagged edges reach a high walkway (y=3) over the joint.
export const hairpin: GameMap = {
  name: 'hairpin',
  boxes: [
    { min: { x: -12, y: -1, z: -30 }, max: { x: -8, y: 0, z: 32 } }, // 0 left leg floor
    { min: { x: 8, y: -1, z: -30 }, max: { x: 12, y: 0, z: 32 } }, // 1 right leg floor
    { min: { x: -12, y: -1, z: 30 }, max: { x: 12, y: 0, z: 39 } }, // 2 joint floor
    { min: { x: -8, y: -1, z: 26 }, max: { x: 8, y: 0, z: 30 } }, // 3 pad approach floor (bridges legs to joint, x in (-8,8) had no floor)
    { min: { x: -12, y: 0, z: -30 }, max: { x: -8, y: 0.5, z: -22 } }, // 4 cobalt base
    { min: { x: 8, y: 0, z: 22 }, max: { x: 12, y: 0.5, z: 30 } }, // 5 ember base
    { min: { x: -12, y: 2.7, z: 30 }, max: { x: 12, y: 3, z: 39 } }, // 6 high walkway
    { min: { x: -11, y: 0, z: -5.75 }, max: { x: -9, y: 1, z: -4.25 } }, // 7 cover, left leg
    { min: { x: -11, y: 0, z: 9.25 }, max: { x: -9, y: 1, z: 10.75 } }, // 8 cover, left leg
    { min: { x: 9, y: 0, z: -5.75 }, max: { x: 11, y: 1, z: -4.25 } }, // 9 cover, right leg
    { min: { x: 9, y: 0, z: 9.25 }, max: { x: 11, y: 1, z: 10.75 } }, // 10 cover, right leg
  ],
  boxColors: [
    0x777777, // left leg floor
    0x777777, // right leg floor
    0x888888, // joint floor
    0x888888, // pad approach floor
    0x2244aa, // cobalt base
    0xaa5522, // ember base
    0x999999, // high walkway
    0x3355bb, // cover (cobalt side)
    0x3355bb,
    0xbb6633, // cover (ember side)
    0xbb6633,
  ],
  launchPads: [{ pos: { x: 0, y: 0, z: 26 }, radius: 1, velocity: { x: 0, y: 12, z: 8 } }],
  teleporters: [{ a: { x: -10, y: 0, z: -10 }, b: { x: 10, y: 0, z: -10 }, radius: 1 }],
  spawns: [
    [
      { x: -11, y: 0.5, z: -24 },
      { x: -9, y: 0.5, z: -24 },
      { x: -11, y: 0.5, z: -27 },
      { x: -9, y: 0.5, z: -27 },
    ],
    [
      { x: 9, y: 0.5, z: 24 },
      { x: 11, y: 0.5, z: 24 },
      { x: 9, y: 0.5, z: 27 },
      { x: 11, y: 0.5, z: 27 },
    ],
  ],
  spawnYaw: [0, Math.PI],
  flagStands: [
    { x: -10, y: 0.5, z: -25 },
    { x: 10, y: 0.5, z: 25 },
  ],
  deathY: -10,
  waypoints: [
    { pos: { x: -10, y: 0.5, z: -25 } }, // 0 base cobalt
    { pos: { x: -10, y: 0, z: -18 } }, // 1 left leg
    { pos: { x: -10, y: 0, z: -10 } }, // 2 teleporter A
    { pos: { x: -10, y: 0, z: 0 } }, // 3 left leg
    { pos: { x: -10, y: 0, z: 15 } }, // 4 left leg
    { pos: { x: -10, y: 0, z: 30 } }, // 5 left corner into joint
    { pos: { x: 0, y: 0, z: 26 } }, // 6 launch pad approach
    { pos: { x: 0, y: 0, z: 34 } }, // 7 joint mid
    { pos: { x: 0, y: 3, z: 34 } }, // 8 high walkway
    { pos: { x: 10, y: 0, z: 30 } }, // 9 right corner into joint
    { pos: { x: 10, y: 0, z: 15 } }, // 10 right leg
    { pos: { x: 10, y: 0, z: 0 } }, // 11 right leg
    { pos: { x: 10, y: 0, z: -10 } }, // 12 teleporter B
    { pos: { x: 10, y: 0, z: -18 } }, // 13 right leg
    { pos: { x: 10, y: 0.5, z: 25 } }, // 14 base ember
  ],
  edges: [
    { from: 0, to: 1, kind: 'walk' },
    { from: 1, to: 2, kind: 'walk' },
    { from: 2, to: 3, kind: 'walk' },
    { from: 3, to: 4, kind: 'walk' },
    { from: 4, to: 5, kind: 'walk' },
    { from: 5, to: 6, kind: 'walk' },
    { from: 6, to: 7, kind: 'walk' },
    { from: 7, to: 9, kind: 'walk' },
    { from: 9, to: 10, kind: 'walk' },
    { from: 10, to: 11, kind: 'walk' },
    { from: 11, to: 12, kind: 'walk' },
    { from: 12, to: 13, kind: 'walk' },
    { from: 9, to: 14, kind: 'walk' },
    { from: 2, to: 12, kind: 'teleporter' },
    { from: 6, to: 8, kind: 'launchpad' },
    { from: 5, to: 8, kind: 'grapple' },
    { from: 9, to: 8, kind: 'grapple' },
  ],
}
