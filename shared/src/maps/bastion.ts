import type { GameMap } from '../map'

// Bastion: the big one. 40m wide (x -20..20) x 80m long (z -40..40) --
// roughly 3x gutter's footprint -- laid out point-symmetric (rotate180:
// x -> -x, z -> -z), so every geometry box, launch pad, teleporter, pickup
// pad and waypoint edge has an exact opposite-team twin.
//
// THREE routes run base to base, separated by two 3m divider walls at
// x = -9..-8 and x = 8..9:
//   1. the center lane (x -8..8), open, with a 1.2m raised mid platform at
//      the origin holding the railspike pad -- the map's power position;
//   2/3. the west and east flank corridors (x -20..-9 / 9..20), each with a
//      launch pad, a teleporter alcove and a scattergun pad.
// The dividers are broken by 3m-wide doorway gaps at z = -19..-16 and
// z = 16..19, so a push can switch routes mid-map instead of committing to
// one at spawn.
//
// Bases sit on 0.5m platforms (z -40..-33 / 33..40) behind a 3m base wall
// with exactly TWO entrances (x -9.5..-5 and 5..9.5); the base's back wall
// is the map's own south/north perimeter segment. The floor is ONE
// continuous slab across the whole footprint -- no death pits anywhere, per
// gutter.ts's rationale -- and a 6m tall, 1m thick perimeter wall sits flush
// against its outer edge, so no walkable edge exists for a player to step,
// strafe, get knocked or get launched off of. deathY is a safety net only.
export const bastion: GameMap = {
  name: 'bastion',
  boxes: [
    // One continuous floor across the entire 40x80 footprint.
    { min: { x: -20, y: -1, z: -40 }, max: { x: 20, y: 0, z: 40 } }, // 0 floor
    // Base platforms (raised 0.5, same step height as gutter's -- see
    // nav.ts's JUMP_HEIGHT_DELTA for why a runner can still mount it).
    // 20m wide so both base doorways (centered x = -7.25 / 7.25) land ON
    // the platform rather than beside it.
    { min: { x: -10, y: 0, z: -40 }, max: { x: 10, y: 0.5, z: -33 } }, // 1 cobalt base platform
    { min: { x: -10, y: 0, z: 33 }, max: { x: 10, y: 0.5, z: 40 } }, // 2 ember base platform
    // Base walls, 3m tall, spanning the full map width with two 4.5m
    // doorway gaps each (x -9.5..-5 and x 5..9.5). Those gaps sit on the
    // divider line extended, so both the center lane and a flank can feed
    // either entrance.
    { min: { x: -20, y: 0, z: -33 }, max: { x: -9.5, y: 3, z: -32 } }, // 3 cobalt base wall, west span
    { min: { x: -5, y: 0, z: -33 }, max: { x: 5, y: 3, z: -32 } }, // 4 cobalt base wall, center span
    { min: { x: 9.5, y: 0, z: -33 }, max: { x: 20, y: 3, z: -32 } }, // 5 cobalt base wall, east span
    { min: { x: 9.5, y: 0, z: 32 }, max: { x: 20, y: 3, z: 33 } }, // 6 ember base wall, east span
    { min: { x: -5, y: 0, z: 32 }, max: { x: 5, y: 3, z: 33 } }, // 7 ember base wall, center span
    { min: { x: -20, y: 0, z: 32 }, max: { x: -9.5, y: 3, z: 33 } }, // 8 ember base wall, west span
    // Divider walls, 3m tall / 1m thick, splitting center lane from flanks.
    // Broken into three segments per side so the two doorway gaps (z
    // -19..-16 and 16..19) line up on both dividers; the stretches beyond
    // z = +-26 are open, so the base approach is shared ground.
    { min: { x: -9, y: 0, z: -26 }, max: { x: -8, y: 3, z: -19 } }, // 9 west divider, cobalt segment
    { min: { x: -9, y: 0, z: -16 }, max: { x: -8, y: 3, z: 16 } }, // 10 west divider, center segment
    { min: { x: -9, y: 0, z: 19 }, max: { x: -8, y: 3, z: 26 } }, // 11 west divider, ember segment
    { min: { x: 8, y: 0, z: -26 }, max: { x: 9, y: 3, z: -19 } }, // 12 east divider, cobalt segment
    { min: { x: 8, y: 0, z: -16 }, max: { x: 9, y: 3, z: 16 } }, // 13 east divider, center segment
    { min: { x: 8, y: 0, z: 19 }, max: { x: 9, y: 3, z: 26 } }, // 14 east divider, ember segment
    // Raised mid feature, 1.2m -- under CLAMBER_MAX_HEIGHT (1.4) so it can
    // be mounted head-on from any side, and it carries the railspike pad on
    // top. No waypoint edge crosses it: the center-lane bot lanes run at
    // x = +-5, leaving 2m of clearance on either side.
    { min: { x: -3, y: 0, z: -4 }, max: { x: 3, y: 1.2, z: 4 } }, // 15 mid platform
    // Cover boxes, 1.1m tall, six per side and each one the exact rotate180
    // twin of its opposite number (16<->22, 17<->23, ... 21<->27) -- the
    // cover-box symmetry assertion in shared/test/map.test.ts enforces this,
    // and both halves of a pair must always move together. Every one is
    // placed clear of every straight line between waypoints joined by a
    // 'walk' edge (bots are point-seeking walkers with no obstacle
    // avoidance); the tightest is box 21 at 1.2m from the west divider's
    // south end, and the tightest against an actual edge is 1.45m.
    { min: { x: -0.8, y: 0, z: -24.8 }, max: { x: 0.8, y: 1.1, z: -23.2 } }, // 16 center lane, cobalt end
    { min: { x: -2.3, y: 0, z: -9.8 }, max: { x: -0.7, y: 1.1, z: -8.2 } }, // 17 center lane, west of mid
    { min: { x: 1.7, y: 0, z: -20.8 }, max: { x: 3.3, y: 1.1, z: -19.2 } }, // 18 center lane, east side
    { min: { x: -17.8, y: 0, z: -20.8 }, max: { x: -16.2, y: 1.1, z: -19.2 } }, // 19 west flank, outer
    { min: { x: 16.2, y: 0, z: -20.8 }, max: { x: 17.8, y: 1.1, z: -19.2 } }, // 20 east flank, outer
    { min: { x: -11.8, y: 0, z: -25.8 }, max: { x: -10.2, y: 1.1, z: -24.2 } }, // 21 west flank, divider nook
    { min: { x: -0.8, y: 0, z: 23.2 }, max: { x: 0.8, y: 1.1, z: 24.8 } }, // 22 twin of 16
    { min: { x: 0.7, y: 0, z: 8.2 }, max: { x: 2.3, y: 1.1, z: 9.8 } }, // 23 twin of 17
    { min: { x: -3.3, y: 0, z: 19.2 }, max: { x: -1.7, y: 1.1, z: 20.8 } }, // 24 twin of 18
    { min: { x: 16.2, y: 0, z: 19.2 }, max: { x: 17.8, y: 1.1, z: 20.8 } }, // 25 twin of 19
    { min: { x: -17.8, y: 0, z: 19.2 }, max: { x: -16.2, y: 1.1, z: 20.8 } }, // 26 twin of 20
    { min: { x: 10.2, y: 0, z: 24.2 }, max: { x: 11.8, y: 1.1, z: 25.8 } }, // 27 twin of 21
    // Perimeter walls, same contract as gutter's 13-16 and hairpin's 11-14:
    // 6m tall (unjumpable, unclamberable), 1m thick (no tunneling), flush
    // against the floor's outer edge so the full x -20..20 / z -40..40
    // footprint stays walkable.
    { min: { x: -21, y: 0, z: -41 }, max: { x: -20, y: 6, z: 41 } }, // 28 west perimeter wall
    { min: { x: 20, y: 0, z: -41 }, max: { x: 21, y: 6, z: 41 } }, // 29 east perimeter wall
    { min: { x: -21, y: 0, z: -41 }, max: { x: 21, y: 6, z: -40 } }, // 30 south perimeter wall (behind cobalt base)
    { min: { x: -21, y: 0, z: 40 }, max: { x: 21, y: 6, z: 41 } }, // 31 north perimeter wall (behind ember base)
  ],
  boxColors: [
    0x888888, // floor
    0x2244aa, // cobalt base platform
    0xaa5522, // ember base platform
    0x777777, // base walls (3-8)
    0x777777,
    0x777777,
    0x777777,
    0x777777,
    0x777777,
    0x777777, // divider walls (9-14)
    0x777777,
    0x777777,
    0x777777,
    0x777777,
    0x777777,
    0x999999, // mid platform
    0x3355bb, // cover (cobalt side, 16-21)
    0x3355bb,
    0x3355bb,
    0x3355bb,
    0x3355bb,
    0x3355bb,
    0xbb6633, // cover (ember side, 22-27)
    0xbb6633,
    0xbb6633,
    0xbb6633,
    0xbb6633,
    0xbb6633,
    0x777777, // perimeter walls (28-31)
    0x777777,
    0x777777,
    0x777777,
  ],
  // One pad per flank, tucked against the outer wall at x = +-18 (3.5m off
  // the flank's walk line, well outside the pad's own 1m trigger radius, so
  // a bot walking the flank is never launched by accident). Unlike gutter's
  // and hairpin's pads there is no pre-PLAYER_GRAVITY original to preserve
  // here, so these velocities are authored directly against PLAYER_GRAVITY
  // (24) -- the constant stepMovement actually integrates, which is what the
  // k = sqrt(24/20) rescale on the other two maps exists to compensate for.
  // Range = vz * 2*vy / PLAYER_GRAVITY = 18.286 * 0.875 = 16m, apex
  // vy^2 / (2*PLAYER_GRAVITY) = 2.3m: launches from z = -14 to z = +2 along
  // the flank, clearing the 1.1m cover boxes and landing nowhere near the
  // z = +-40 perimeter.
  launchPads: [
    { pos: { x: -18, y: 0, z: -14 }, radius: 1, velocity: { x: 0, y: 10.5, z: 18.286 } },
    { pos: { x: 18, y: 0, z: 14 }, radius: 1, velocity: { x: 0, y: 10.5, z: -18.286 } },
  ],
  // Two flank-to-flank shortcuts, each self-symmetric under rotate180 (a's
  // twin IS its own b): step into your own half's outer alcove and come out
  // deep in the OPPOSITE flank next to the enemy base. Sited at x = +-18 so
  // the flank walk line at x = +-14.5 never clips their 1m trigger radius.
  teleporters: [
    { a: { x: -18, y: 0, z: -28 }, b: { x: 18, y: 0, z: 28 }, radius: 1 },
    { a: { x: 18, y: 0, z: -28 }, b: { x: -18, y: 0, z: 28 }, radius: 1 },
  ],
  // No powerPickups: weapons come from the random spawn roll only, so there
  // is nothing to pick up anywhere on the map (see rollLoadout).
  spawns: [
    [
      { x: -4, y: 0.5, z: -38 },
      { x: -1.5, y: 0.5, z: -38 },
      { x: 1.5, y: 0.5, z: -38 },
      { x: 4, y: 0.5, z: -38 },
    ],
    [
      { x: 4, y: 0.5, z: 38 },
      { x: 1.5, y: 0.5, z: 38 },
      { x: -1.5, y: 0.5, z: 38 },
      { x: -4, y: 0.5, z: 38 },
    ],
  ],
  spawnYaw: [0, Math.PI],
  flagStands: [
    { x: 0, y: 0.5, z: -36 },
    { x: 0, y: 0.5, z: 36 },
  ],
  deathY: -10,
  // 36 waypoints. Every 'walk' edge below is a straight line with at least
  // 1.5m of unobstructed width (bots have no avoidance steering), and every
  // edge that crosses a doorway -- the two base entrances and the four
  // divider gaps -- has a waypoint sitting IN the doorway so the crossing is
  // perpendicular rather than diagonal. The whole node set and the whole
  // edge set are invariant under rotate180, so a clearance that holds on the
  // cobalt half holds on the ember half by construction.
  waypoints: [
    { pos: { x: 0, y: 0.5, z: -36 } }, // 0 cobalt flag stand
    { pos: { x: -7.25, y: 0.5, z: -34.5 } }, // 1 cobalt west entrance, inside
    { pos: { x: 7.25, y: 0.5, z: -34.5 } }, // 2 cobalt east entrance, inside
    { pos: { x: -7.25, y: 0, z: -30 } }, // 3 cobalt west entrance, outside
    { pos: { x: 7.25, y: 0, z: -30 } }, // 4 cobalt east entrance, outside
    { pos: { x: 0, y: 0.5, z: 36 } }, // 5 ember flag stand
    { pos: { x: 7.25, y: 0.5, z: 34.5 } }, // 6 ember east entrance, inside
    { pos: { x: -7.25, y: 0.5, z: 34.5 } }, // 7 ember west entrance, inside
    { pos: { x: 7.25, y: 0, z: 30 } }, // 8 ember east entrance, outside
    { pos: { x: -7.25, y: 0, z: 30 } }, // 9 ember west entrance, outside
    { pos: { x: -5, y: 0, z: -17.5 } }, // 10 center lane, west line, cobalt side
    { pos: { x: 5, y: 0, z: -17.5 } }, // 11 center lane, east line, cobalt side
    { pos: { x: 5, y: 0, z: 17.5 } }, // 12 center lane, east line, ember side
    { pos: { x: -5, y: 0, z: 17.5 } }, // 13 center lane, west line, ember side
    { pos: { x: -14.5, y: 0, z: -28 } }, // 14 west flank, cobalt end
    { pos: { x: -14.5, y: 0, z: -17.5 } }, // 15 west flank, at cobalt-side divider gap
    { pos: { x: -14.5, y: 0, z: 0 } }, // 16 west flank, mid
    { pos: { x: -14.5, y: 0, z: 17.5 } }, // 17 west flank, at ember-side divider gap
    { pos: { x: -14.5, y: 0, z: 28 } }, // 18 west flank, ember end
    { pos: { x: 14.5, y: 0, z: 28 } }, // 19 east flank, ember end
    { pos: { x: 14.5, y: 0, z: 17.5 } }, // 20 east flank, at ember-side divider gap
    { pos: { x: 14.5, y: 0, z: 0 } }, // 21 east flank, mid
    { pos: { x: 14.5, y: 0, z: -17.5 } }, // 22 east flank, at cobalt-side divider gap
    { pos: { x: 14.5, y: 0, z: -28 } }, // 23 east flank, cobalt end
    { pos: { x: -8.5, y: 0, z: -17.5 } }, // 24 west divider gap, cobalt side
    { pos: { x: -8.5, y: 0, z: 17.5 } }, // 25 west divider gap, ember side
    { pos: { x: 8.5, y: 0, z: 17.5 } }, // 26 east divider gap, ember side
    { pos: { x: 8.5, y: 0, z: -17.5 } }, // 27 east divider gap, cobalt side
    { pos: { x: -18, y: 0, z: -28 } }, // 28 teleporter alcove, west cobalt
    { pos: { x: 18, y: 0, z: 28 } }, // 29 teleporter alcove, east ember
    { pos: { x: 18, y: 0, z: -28 } }, // 30 teleporter alcove, east cobalt
    { pos: { x: -18, y: 0, z: 28 } }, // 31 teleporter alcove, west ember
    { pos: { x: -18, y: 0, z: -14 } }, // 32 west launch pad
    { pos: { x: -18, y: 0, z: 2 } }, // 33 west launch pad landing
    { pos: { x: 18, y: 0, z: 14 } }, // 34 east launch pad
    { pos: { x: 18, y: 0, z: -2 } }, // 35 east launch pad landing
  ],
  edges: [
    // Base interiors and their two entrances.
    { from: 0, to: 1, kind: 'walk' },
    { from: 0, to: 2, kind: 'walk' },
    { from: 1, to: 3, kind: 'walk' },
    { from: 2, to: 4, kind: 'walk' },
    { from: 3, to: 4, kind: 'walk' },
    { from: 5, to: 6, kind: 'walk' },
    { from: 5, to: 7, kind: 'walk' },
    { from: 6, to: 8, kind: 'walk' },
    { from: 7, to: 9, kind: 'walk' },
    { from: 8, to: 9, kind: 'walk' },
    // Route 1: center lane, two lines at x = +-5 running past the mid
    // platform (2m clearance either side of it).
    { from: 3, to: 10, kind: 'walk' },
    { from: 4, to: 11, kind: 'walk' },
    { from: 10, to: 13, kind: 'walk' },
    { from: 11, to: 12, kind: 'walk' },
    { from: 12, to: 8, kind: 'walk' },
    { from: 13, to: 9, kind: 'walk' },
    // Routes 2 and 3: the flank corridors.
    { from: 3, to: 14, kind: 'walk' },
    { from: 14, to: 15, kind: 'walk' },
    { from: 15, to: 16, kind: 'walk' },
    { from: 16, to: 17, kind: 'walk' },
    { from: 17, to: 18, kind: 'walk' },
    { from: 18, to: 9, kind: 'walk' },
    { from: 4, to: 23, kind: 'walk' },
    { from: 23, to: 22, kind: 'walk' },
    { from: 22, to: 21, kind: 'walk' },
    { from: 21, to: 20, kind: 'walk' },
    { from: 20, to: 19, kind: 'walk' },
    { from: 19, to: 8, kind: 'walk' },
    // Divider doorways: flank -> gap node -> center lane, both legs
    // perpendicular to the wall so the 3m gap is crossed dead centre.
    { from: 15, to: 24, kind: 'walk' },
    { from: 24, to: 10, kind: 'walk' },
    { from: 17, to: 25, kind: 'walk' },
    { from: 25, to: 13, kind: 'walk' },
    { from: 22, to: 27, kind: 'walk' },
    { from: 27, to: 11, kind: 'walk' },
    { from: 20, to: 26, kind: 'walk' },
    { from: 26, to: 12, kind: 'walk' },
    // Teleporter alcoves: own-half outer corner -> opposite flank, deep.
    { from: 14, to: 28, kind: 'walk' },
    { from: 28, to: 29, kind: 'teleporter' },
    { from: 29, to: 19, kind: 'walk' },
    { from: 23, to: 30, kind: 'walk' },
    { from: 30, to: 31, kind: 'teleporter' },
    { from: 31, to: 18, kind: 'walk' },
    // Launch pads: a 16m hop up each flank toward the enemy half.
    { from: 15, to: 32, kind: 'walk' },
    { from: 32, to: 33, kind: 'launchpad' },
    { from: 33, to: 16, kind: 'walk' },
    { from: 20, to: 34, kind: 'walk' },
    { from: 34, to: 35, kind: 'launchpad' },
    { from: 35, to: 21, kind: 'walk' },
  ],
}
