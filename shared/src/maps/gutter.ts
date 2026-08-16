import type { GameMap } from '../map'

// Straight lane along z, ~60 long x 12 wide. The full lane footprint (x
// -6..6: center lane, both rails, and the two strips that used to be open
// "gutters" between them) is now ONE CONTINUOUS FLOOR at the same height --
// a stray strafe during a firefight used to drop you into a death pit
// there, which just felt bad, not fun-risky. Bases sit on raised platforms
// at the far ends. A tall perimeter wall (6m -- see boxes 13-16) runs the
// full outer boundary of that footprint, so there is no walkable edge left
// anywhere a player can step, strafe, get knocked, or get launched off of.
// Falling is no longer a normal-play outcome on this map; deathY only
// exists as a safety net for a player who somehow ends up below the floor
// entirely (see the deathY safety-net tests in physics.test.ts/sim.test.ts).
export const gutter: GameMap = {
  name: 'gutter',
  boxes: [
    // base platforms (raised 0.5)
    { min: { x: -6, y: 0, z: -30 }, max: { x: 6, y: 0.5, z: -22 } }, // 0 cobalt base
    { min: { x: -6, y: 0, z: 22 }, max: { x: 6, y: 0.5, z: 30 } }, // 1 ember base
    // lane floor: center + rails. The two former gutter gaps (x [-4,-3] and
    // [3,4]) are filled by boxes 5/6 below at this same height, so x -6..6
    // is one flat, continuous surface end to end.
    { min: { x: -3, y: -1, z: -22 }, max: { x: 3, y: 0, z: 22 } }, // 2 center lane
    { min: { x: -6, y: -1, z: -22 }, max: { x: -4, y: 0, z: 22 } }, // 3 left rail
    { min: { x: 4, y: -1, z: -22 }, max: { x: 6, y: 0, z: 22 } }, // 4 right rail
    // Former "gutter" death-pit gaps, now filled solid at the same height
    // as the lane on both sides. Used to be two short bridge patches only
    // at the teleporter-alcove crossings (west side) plus nothing at all on
    // the east side; now it's the full lane length on both sides, so the
    // old bridge/pit distinction is gone.
    { min: { x: -4, y: -1, z: -22 }, max: { x: -3, y: 0, z: 22 } }, // 5 west gutter fill
    { min: { x: 3, y: -1, z: -22 }, max: { x: 4, y: 0, z: 22 } }, // 6 east gutter fill
    // cover boxes, ~1m tall, staggered every ~6 units down the lane.
    // Box 7 sits at z=-15 rather than centered on node1 (z=-18) -- at z=-18
    // it sat almost exactly on the direct waypoint1->9 walk edge into the
    // teleporter alcove (x -2.7..-1.3 blocking the x -5..0 crossing line),
    // which a simple point-seeking walker has no obstacle-avoidance
    // steering to route around. Box 12 is box 7's 180-degree-rotational
    // mirror (x -> -x, z -> -z, per this map's point-symmetric layout) and
    // moved to z 14.3..15.7 to match -- both must move together, or one
    // team gets extra mid-lane cover the other doesn't. Covered by the
    // cover-box symmetry assertion in shared/test/map.test.ts.
    { min: { x: -2.7, y: 0, z: -15.7 }, max: { x: -1.3, y: 1, z: -14.3 } }, // 7
    { min: { x: 1.3, y: 0, z: -12.7 }, max: { x: 2.7, y: 1, z: -11.3 } }, // 8
    { min: { x: -2.7, y: 0, z: -6.7 }, max: { x: -1.3, y: 1, z: -5.3 } }, // 9
    { min: { x: 1.3, y: 0, z: 5.3 }, max: { x: 2.7, y: 1, z: 6.7 } }, // 10
    { min: { x: -2.7, y: 0, z: 11.3 }, max: { x: -1.3, y: 1, z: 12.7 } }, // 11
    { min: { x: 1.3, y: 0, z: 14.3 }, max: { x: 2.7, y: 1, z: 15.7 } }, // 12
    // Perimeter walls. The floor inside is fully solid now, so the only
    // edge left to guard is the true outer boundary of the footprint (x
    // -6..6, z -30..30) -- including the base platforms' back and side
    // edges, which had no guard at all before, not even the old jumpable
    // kind. 6m tall (jump apex is ~1.2m, clamber tops out 1.4m above the
    // player) so it can't be jumped, clambered over, or knocked over --
    // unlike the old interior gutter curbs, which were a deliberately
    // jumpable 0.5m. 1m thick, well past a sprinting player's per-tick
    // travel distance, to resist tunneling. Sits flush against the floor's
    // outer edge rather than encroaching into it (unlike the old interior
    // curbs), so the full intended x -6..6 width stays walkable.
    { min: { x: -7, y: 0, z: -31 }, max: { x: -6, y: 6, z: 31 } }, // 13 west perimeter wall
    { min: { x: 6, y: 0, z: -31 }, max: { x: 7, y: 6, z: 31 } }, // 14 east perimeter wall
    { min: { x: -7, y: 0, z: -31 }, max: { x: 7, y: 6, z: -30 } }, // 15 south perimeter wall (behind cobalt base)
    { min: { x: -7, y: 0, z: 30 }, max: { x: 7, y: 6, z: 31 } }, // 16 north perimeter wall (behind ember base)
    // Rail cover pair, added so the two rails are worth walking instead of
    // being bare run-up strips. Same 180-degree-rotational pairing as boxes
    // 7-12 (x -> -x, z -> -z): box 17 at (-5, -20.5), box 18 at (5, 20.5).
    // Both sit ON the rails (x -6..-4 / 4..6) and stop 0.7m short of the
    // base platforms at z = +-22, so neither overlaps a platform box.
    // Clearance checked against EVERY walk edge in the graph below: 0-1,
    // 1-2, 2-3, 3-4, 4-5, 5-6, 6-7 and 7-8 all run along x = 0 (4.2m of
    // clearance); 1-9 (z = -18) and 10-7 (z = 18) are the tightest at 1.7m;
    // 4-11, 12-2, 4-13 and 14-6 all sit inside x -1..1 near mid, 3.2m+ away.
    { min: { x: -5.8, y: 0, z: -21.3 }, max: { x: -4.2, y: 1, z: -19.7 } }, // 17
    { min: { x: 4.2, y: 0, z: 19.7 }, max: { x: 5.8, y: 1, z: 21.3 } }, // 18
  ],
  boxColors: [
    0x2244aa, // cobalt base
    0xaa5522, // ember base
    0x888888, // center lane
    0x777777, // left rail
    0x777777, // right rail
    0x777777, // west gutter fill
    0x777777, // east gutter fill
    0x3355bb, // cover (cobalt side)
    0x3355bb,
    0x3355bb,
    0xbb6633, // cover (ember side)
    0xbb6633,
    0xbb6633,
    0x777777, // perimeter walls (13-16)
    0x777777,
    0x777777,
    0x777777,
    0x3355bb, // rail cover (cobalt side)
    0xbb6633, // rail cover (ember side)
  ],
  // Velocities scaled by k = sqrt(PLAYER_GRAVITY / GRAVITY) = sqrt(24/20)
  // ~= 1.0954 from their original (0,9,-10)/(0,9,10) so the launched
  // trajectory (a function of v^2/g) is unchanged under stepMovement's
  // snappier PLAYER_GRAVITY (24 vs GRAVITY's 20). Lands ~9-11m out, well
  // short of the z=-30/30 perimeter -- see the launch-pad landing test.
  launchPads: [
    { pos: { x: -1, y: 0, z: 0 }, radius: 1, velocity: { x: 0, y: 9.859, z: -10.954 } },
    { pos: { x: 1, y: 0, z: 0 }, radius: 1, velocity: { x: 0, y: 9.859, z: 10.954 } },
  ],
  teleporters: [{ a: { x: -5, y: 0, z: -18 }, b: { x: -5, y: 0, z: 18 }, radius: 1 }],
  // One boomtube pad on the east rail at mid, NOT at the origin. PICKUP_RADIUS
  // is 1.4 and both launch pads sit at x = +-1, z = 0 with a 1m trigger
  // radius, so a pad at the origin would be inside the launch pads' own
  // approach: node 4 of the waypoint graph IS (0,0,0), meaning every bot
  // heading for a pad -- and every player stepping on one -- would collect
  // the power weapon for free on the way. z = 0 keeps it exactly 26m from
  // both flag stands (dead even for both teams); the east rail balances the
  // teleporter alcoves, which are both on the west rail.
  // Point-symmetric set (rotate180, matching this map's cover layout). The
  // two power weapons face each other across the mid line at z = 0, so both
  // are exactly equidistant from both bases and neither sits in a flag room
  // -- a one-hit melee that spawns where a defender already stands turns a
  // flag into a camp. gutter takes the Gravity Hammer rather than the Energy
  // Sword: one power melee per map, and the hammer's shorter reach suits a
  // lane this tight.
  powerPickups: [
    { pos: { x: 5, y: 0, z: 0 }, weapon: 'boomtube', respawnSec: 150 },
    { pos: { x: -5, y: 0, z: 0 }, weapon: 'grav_maul', respawnSec: 150 },
    // On the rails, mid-lane, where the cover run already takes bots.
    { pos: { x: -5, y: 0, z: -12 }, weapon: 'scattergun', respawnSec: 45 },
    { pos: { x: 5, y: 0, z: 12 }, weapon: 'scattergun', respawnSec: 45 },
  ],
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
