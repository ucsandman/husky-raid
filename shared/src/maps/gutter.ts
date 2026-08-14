import type { GameMap } from '../map'

// Straight lane along z, ~60 long x 12 wide. Floor is split into a center
// lane plus two side rails, leaving two gutters (death pits) between them —
// like a bowling lane. Bases sit on raised platforms at the far ends.
// The lane's own outer edges (facing each gutter) and the world's outer
// edges (outside each rail) carry a knee-high guard-rail curb -- see boxes
// 13-18 below -- so falling off the LANE takes a deliberate jump, not a
// stray strafe. The rails themselves are no longer curbed on their
// gutter-facing side (the trench fix, task 8): a rail-side curb fought the
// gutters' own "falling takes a jump" design from the other direction, so
// walking off a rail into its gutter is a plain strafe again.
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
    // so the walk edges to/from the alcove waypoints don't cross the pit.
    // Widened to 4m (was 1m), giving path-followers real margin to line up
    // on the bridge rather than needing to hit a 1m target exactly.
    { min: { x: -4, y: -1, z: -20 }, max: { x: -3, y: 0, z: -16 } }, // 5 gutter bridge, z=-18
    { min: { x: -4, y: -1, z: 16 }, max: { x: -3, y: 0, z: 20 } }, // 6 gutter bridge, z=+18
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
    // Guard-rail curbs: knee-high (0.5m) solid lips mounted ON the solid
    // floor right at each edge that faces open air (encroaching ~0.3m into
    // the walkable surface, not hanging out over the pit), so drifting
    // sideways during a firefight bumps into a wall instead of silently
    // dropping into the gutter or off the map. Sitting on the floor side
    // (rather than projecting into the void) matters: the two curbs
    // flanking one gutter never narrow its true 1m gap, so the pit is
    // exactly as fall-into-able as before once you're past the lip -- see
    // the 'death pit' test in physics.test.ts, which free-falls a player
    // through the dead center of this same west gutter (x=-3.5) and must
    // keep landing 'fell'. JUMP_SPEED (8) clears 0.5m in ~2 ticks at 30Hz,
    // so a normal hop still crosses the curb freely -- falling stays
    // possible, it just takes an actual jump (or getting knocked over one
    // by an explosion), not a stray strafe key.
    // West gutter has the two teleporter-alcove bridges (boxes 5/6), so its
    // lane-edge curb is split into 3 segments each with gaps at z [-20,-16]
    // and [16,20] to leave the bridge crossings open. East gutter has no
    // bridge, so its lane-edge curb runs the full lane length uninterrupted.
    // Rail-facing (gutter-side) curb segments that used to sit at x
    // -4.3..-4 / 4..4.3 were removed (the trench fix): those knee-high
    // lips blocked the gutter itself from the rail side, which fought the
    // deliberate "falling takes a jump" design the lane-edge curbs (13-15,
    // 16 below) already provide from the lane side -- see 'death pit' in
    // physics.test.ts, still free-falling through this same gap.
    { min: { x: -3, y: 0, z: -22 }, max: { x: -2.7, y: 0.5, z: -20 } }, // 13 west lane-edge curb, south seg
    { min: { x: -3, y: 0, z: -16 }, max: { x: -2.7, y: 0.5, z: 16 } }, // 14 west lane-edge curb, mid seg
    { min: { x: -3, y: 0, z: 20 }, max: { x: -2.7, y: 0.5, z: 22 } }, // 15 west lane-edge curb, north seg
    { min: { x: 2.7, y: 0, z: -22 }, max: { x: 3, y: 0.5, z: 22 } }, // 16 east lane-edge curb
    { min: { x: -6, y: 0, z: -22 }, max: { x: -5.7, y: 0.5, z: 22 } }, // 17 west outer-edge curb
    { min: { x: 5.7, y: 0, z: -22 }, max: { x: 6, y: 0.5, z: 22 } }, // 18 east outer-edge curb
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
    0x777777, // guard rail curbs (13-18)
    0x777777,
    0x777777,
    0x777777,
    0x777777,
    0x777777,
  ],
  // Velocities scaled by k = sqrt(PLAYER_GRAVITY / GRAVITY) = sqrt(24/20)
  // ~= 1.0954 from their original (0,9,-10)/(0,9,10) so the launched
  // trajectory (a function of v^2/g) is unchanged under stepMovement's
  // snappier PLAYER_GRAVITY (24 vs GRAVITY's 20).
  launchPads: [
    { pos: { x: -1, y: 0, z: 0 }, radius: 1, velocity: { x: 0, y: 9.859, z: -10.954 } },
    { pos: { x: 1, y: 0, z: 0 }, radius: 1, velocity: { x: 0, y: 9.859, z: 10.954 } },
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
