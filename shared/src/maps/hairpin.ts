import type { GameMap } from '../map'

// U-shape: two parallel lanes at x = -10 / x = +10, joined by a floor bridge
// at the top of the U (z ~ 30-39). Bases mirror across z = 0 per the map
// schema's mirror-symmetry contract: cobalt at (x:-10, z:-25), ember at
// (x:10, z:25) — near the joint, so the loop back down its own leg is short.
// A teleporter pair cuts straight across the U's gap at z = -10, well
// shorter than walking all the way around through the joint. A launch pad
// and grapple-tagged edges reach a high walkway (y=3) over the joint.
// Each leg carries guard-rail curbs on both its outer and inner edges --
// see boxes 11-14 below -- since a 4m plank flanked by void on both sides
// is otherwise one bad strafe from a death pit.
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
    // Guard-rail curbs (0.5m, same rationale as gutter.ts): each leg is a
    // 4m plank with open void on BOTH sides for most of its length -- the
    // outside (x <-12 / x >12) and the inside gap between the two legs
    // (x in (-8,8), open until the pad-approach floor fills it at z>=26).
    // Curbs sit on the void side so the 4m walkable width is untouched.
    { min: { x: -12.3, y: 0, z: -30 }, max: { x: -12, y: 0.5, z: 32 } }, // 11 left leg outer curb
    { min: { x: 12, y: 0, z: -30 }, max: { x: 12.3, y: 0.5, z: 32 } }, // 12 right leg outer curb
    { min: { x: -8, y: 0, z: -30 }, max: { x: -7.7, y: 0.5, z: 26 } }, // 13 left leg inner curb
    { min: { x: 7.7, y: 0, z: -30 }, max: { x: 8, y: 0.5, z: 26 } }, // 14 right leg inner curb
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
    0x777777, // guard rail curbs (11-14)
    0x777777,
    0x777777,
    0x777777,
  ],
  // Velocity scaled by k = sqrt(PLAYER_GRAVITY / GRAVITY) = sqrt(24/20)
  // ~= 1.0954 from its original (0,12,8), same rationale as gutter's pads.
  launchPads: [{ pos: { x: 0, y: 0, z: 26 }, radius: 1, velocity: { x: 0, y: 13.145, z: 8.763 } }],
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
