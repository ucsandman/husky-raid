import type { GameMap } from '../map'

// U-shape: two parallel lanes at x = -10 / x = +10, joined by a floor bridge
// at the top of the U (z ~ 30-39). Bases mirror across z = 0 per the map
// schema's mirror-symmetry contract: cobalt at (x:-10, z:-25), ember at
// (x:10, z:25) — near the joint, so the loop back down its own leg is short.
// A teleporter pair cuts straight across the U's gap at z = -10, well
// shorter than walking all the way around through the joint. A launch pad
// and grapple-tagged edges reach a high walkway (y=3) over the joint.
// The gap between the two legs (x roughly -8..8, for most of the U's
// length) used to be open void -- box 3 now fills the whole strip, not just
// the old pad-approach corner, so the whole U is one continuous floor from
// leg to leg. A tall perimeter wall (6m -- boxes 11-14) wraps the entire
// outer edge of that floor: both legs' outsides, the back of each leg, and
// the joint's far edge past z=39, none of which had any guard before. See
// gutter.ts for the matching pattern and its full rationale.
export const hairpin: GameMap = {
  name: 'hairpin',
  boxes: [
    { min: { x: -12, y: -1, z: -30 }, max: { x: -8, y: 0, z: 32 } }, // 0 left leg floor
    { min: { x: 8, y: -1, z: -30 }, max: { x: 12, y: 0, z: 32 } }, // 1 right leg floor
    { min: { x: -12, y: -1, z: 30 }, max: { x: 12, y: 0, z: 39 } }, // 2 joint floor
    // Fills the entire gap between the two legs (x -8..8), from the south
    // end all the way up to the joint at z=30 -- was just the pad-approach
    // corner (z 26..30). This is the fix for the dominant death pit that
    // used to run almost the whole length of the map.
    { min: { x: -8, y: -1, z: -30 }, max: { x: 8, y: 0, z: 30 } }, // 3 center fill floor
    { min: { x: -12, y: 0, z: -30 }, max: { x: -8, y: 0.5, z: -22 } }, // 4 cobalt base
    { min: { x: 8, y: 0, z: 22 }, max: { x: 12, y: 0.5, z: 30 } }, // 5 ember base
    { min: { x: -12, y: 2.7, z: 30 }, max: { x: 12, y: 3, z: 39 } }, // 6 high walkway
    { min: { x: -11, y: 0, z: -5.75 }, max: { x: -9, y: 1, z: -4.25 } }, // 7 cover, left leg
    { min: { x: -11, y: 0, z: 9.25 }, max: { x: -9, y: 1, z: 10.75 } }, // 8 cover, left leg
    { min: { x: 9, y: 0, z: -5.75 }, max: { x: 11, y: 1, z: -4.25 } }, // 9 cover, right leg
    { min: { x: 9, y: 0, z: 9.25 }, max: { x: 11, y: 1, z: 10.75 } }, // 10 cover, right leg
    // Perimeter walls (6m tall, same rationale as gutter.ts's 13-16): the
    // floor inside is fully solid now, so these only need to guard the true
    // outer boundary. West/east now run the FULL z length including the
    // joint (was just the leg length, leaving the joint's west/east edges
    // and its entire north edge unguarded), plus new south/north caps
    // closing off the back of each leg and the far side of the joint,
    // which had no curb at all before, not even the old jumpable kind.
    { min: { x: -13, y: 0, z: -31 }, max: { x: -12, y: 6, z: 40 } }, // 11 west perimeter wall
    { min: { x: 12, y: 0, z: -31 }, max: { x: 13, y: 6, z: 40 } }, // 12 east perimeter wall
    { min: { x: -13, y: 0, z: -31 }, max: { x: 13, y: 6, z: -30 } }, // 13 south perimeter wall
    { min: { x: -13, y: 0, z: 39 }, max: { x: 13, y: 6, z: 40 } }, // 14 north perimeter wall
    // Center-fill cover pair, added so the shortcut straight across the U's
    // middle (box 3, solid floor since the pit fix) has something to fight
    // over instead of being a bare 16m-wide crossing. Mirrored left/right
    // (x -> -x, z fixed) to match this map's cover symmetry -- see boxes
    // 7-10 and the symmetry assertion in shared/test/map.test.ts.
    // Clearance checked against EVERY walk edge: 0-1, 1-2, 2-3, 3-4 and 4-5
    // run along x = -10 and 9-10, 10-11, 11-12, 12-13 along x = 10, both 5m
    // clear; 5-6, 6-7, 7-9 and 9-14 all sit at z >= 25, over 24m clear.
    { min: { x: -5, y: 0, z: -0.75 }, max: { x: -3, y: 1, z: 0.75 } }, // 15 cover, center fill (left)
    { min: { x: 3, y: 0, z: -0.75 }, max: { x: 5, y: 1, z: 0.75 } }, // 16 cover, center fill (right)
  ],
  boxColors: [
    0x777777, // left leg floor
    0x777777, // right leg floor
    0x888888, // joint floor
    0x888888, // center fill floor
    0x2244aa, // cobalt base
    0xaa5522, // ember base
    0x999999, // high walkway
    0x3355bb, // cover (cobalt side)
    0x3355bb,
    0xbb6633, // cover (ember side)
    0xbb6633,
    0x777777, // perimeter walls (11-14)
    0x777777,
    0x777777,
    0x777777,
    0x3355bb, // center-fill cover (cobalt/left side)
    0xbb6633, // center-fill cover (ember/right side)
  ],
  // Velocity scaled by k = sqrt(PLAYER_GRAVITY / GRAVITY) = sqrt(24/20)
  // ~= 1.0954 from its original (0,12,8), same rationale as gutter's pads.
  // Lands on the high walkway around z~35.6, comfortably inside the [30,39]
  // walkway span and nowhere near the z=39 perimeter wall.
  launchPads: [{ pos: { x: 0, y: 0, z: 26 }, radius: 1, velocity: { x: 0, y: 13.145, z: 8.763 } }],
  teleporters: [{ a: { x: -10, y: 0, z: -10 }, b: { x: 10, y: 0, z: -10 }, radius: 1 }],
  // One railspike pad on the U's centerline (x = 0, this map's mirror axis,
  // so it is self-symmetric and exactly equidistant from both bases), at the
  // mouth of the joint rather than at the joint's geometric midpoint (z ~
  // 34.5). The high walkway (box 6) roofs the ENTIRE joint floor, x -12..12
  // / z 30..39, and PICKUP_RADIUS is an XZ radius -- a pad anywhere under it
  // would be collectable straight through the floor by whoever is standing
  // on the walkway above. z = 28 sits 2m clear of the walkway footprint and
  // 2m off the launch pad at (0,0,26), so it guards the route up without
  // being free to anyone who takes it.
  // Mirror-symmetric set (mirrorX: x -> -x, z fixed), matching this map's
  // own cover layout rather than bastion's rotate180 -- both legs run the
  // same z-direction here, so a pad on the x = 0 centre line is already
  // self-symmetric at any z. The sniper keeps the joint mouth (the map's
  // contested feature) and the hammer sits dead centre in the U's fill,
  // equidistant from both bases and on the route between them.
  powerPickups: [
    { pos: { x: 0, y: 0, z: 28 }, weapon: 'railspike', respawnSec: 120 },
    { pos: { x: 0, y: 0, z: 0 }, weapon: 'grav_maul', respawnSec: 150 },
    // One per leg, so each team passes a BR without crossing the U.
    { pos: { x: -10, y: 0, z: 0 }, weapon: 'triad_rifle', respawnSec: 30 },
    { pos: { x: 10, y: 0, z: 0 }, weapon: 'triad_rifle', respawnSec: 30 },
  ],
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
