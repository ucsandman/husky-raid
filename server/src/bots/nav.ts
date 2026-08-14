import type { GameMap, PlayerInput, PlayerState, Vec3 } from '@riftlane/shared'
import { MOVE_SPEED, distSq } from '@riftlane/shared'

/** XZ distance (ignoring height) within which a bot counts a path node as reached. */
const ARRIVE_DIST = 1.2
const ARRIVE_DIST_SQ = ARRIVE_DIST * ARRIVE_DIST

/** Distance from the edge segment the bot thinks it's walking that triggers a re-path. */
const UNSTICK_DIST = 3

/**
 * stepMovement's accelerate() (Quake-style: builds speed toward wishDir,
 * never cancels the component perpendicular to it) only bleeds off excess
 * speed via applyFriction, which only runs when wishDir is exactly zero
 * (forward=0 AND strafe=0). Since Navigator recomputes yaw toward the
 * target fresh every tick, a bot closing in on a waypoint sweeps its
 * heading like a pursuit curve -- each tick's small course correction
 * *adds* velocity in the new direction on top of the old, uncancelled
 * component, so speed can run away well past MOVE_SPEED (15+ m/s observed)
 * instead of capping at it. Left unchecked this overshoots corners badly
 * enough to walk bots off narrow crossings (e.g. gutter's ~1m teleporter-
 * alcove bridge) into the pit. Governor: whenever XZ speed exceeds
 * GOVERNOR_TRIGGER_SPEED, brake fully (forward=0) so friction can claw it
 * back down. Uses hysteresis (trigger high, release low, latched in
 * Navigator.braking) rather than a single threshold -- a bang-bang check
 * re-evaluated fresh every tick flips forward between 0 and 1 as soon as
 * speed crosses back over the same line, which can lock into a standing
 * resonance (observed: bots frozen oscillating in place, never net
 * progressing) instead of actually shedding speed and moving on.
 */
const GOVERNOR_TRIGGER_SPEED = MOVE_SPEED * 1.3
const GOVERNOR_RELEASE_SPEED = MOVE_SPEED * 0.5

/** Below this cosine of the incoming/outgoing edge angle (~60 degrees), the
 * upcoming waypoint counts as a sharp corner needing a full stop-and-pivot
 * rather than relying on the general speed governor alone -- a corner this
 * sharp taken at any real speed still overshoots a ~1m-wide crossing. */
const SHARP_TURN_COS = 0.5

/** XZ distance from a sharp-corner waypoint at which the deterministic
 * full-stop countdown below triggers. */
const CORNER_BRAKE_RADIUS = 3

/** Ticks of forced forward=0 once a sharp-corner approach is detected --
 * fixed duration (not speed-gated) so it reliably bleeds any speed,
 * including the governor's own runaway bursts, down near zero before the
 * bot commits to the corner. ~0.4s: friction (multiplicative ~0.73/tick)
 * decays even a 15+ m/s runaway under 1 m/s well within this window. */
const CORNER_BRAKE_TICKS = 12

/**
 * Minimum height gain onto the next node, on a 'walk' edge, that triggers a
 * jump. collideCapsule resolves X, then Y, then Z per tick using each
 * step's already-updated position -- so a grounded walker's Z-axis move
 * into a raised platform's footprint (e.g. gutter's 0.5m-high base, sitting
 * above the 0m lane floor) is tested using the *pre-jump* Y, and blocked
 * like a wall, unless the bot is already mid-jump and high enough by the
 * time it reaches the edge. 1 never fired for that 0.5m step, permanently
 * stranding every runner just short of the flag stand it sits on.
 */
const JUMP_HEIGHT_DELTA = 0.3

/**
 * XZ distance from the target node within which the height-gain jump above
 * triggers. A pure height gate (no distance bound) holds jump=true for the
 * WHOLE approach once the target is elevated -- since input.jump re-fires
 * every tick it's grounded, that bunny-hops the entire remaining distance,
 * and each hop carries its horizontal velocity unchanged through ~0.8s of
 * airtime (no friction/only weak air-accel while airborne), which is
 * plenty to drift off a 6m-wide safe lane into a pit on either side. This
 * still needs to be generous enough that jumping actually starts before
 * the bot is physically wall-blocked well short of the target (collision
 * resolves the target's raised footprint as a wall against a still-ground-
 * level walker -- see JUMP_HEIGHT_DELTA's doc comment), so it's set to
 * clear that with room to spare rather than tuned tight to one map.
 */
const JUMP_TRIGGER_DIST = 5

/** Teleporter edges are near-instant, so A* prices them far below their real
 * (often huge) euclidean gap -- this is what makes teleporter shortcuts win
 * over long walk detours. */
const TELEPORTER_EDGE_COST = 2

function euclid(a: Vec3, b: Vec3): number {
  return Math.sqrt(distSq(a, b))
}

/** Returns the waypoint index closest (straight-line) to pos. */
export function nearestWaypoint(map: GameMap, pos: Vec3): number {
  let best = 0
  let bestDistSq = Infinity
  for (let i = 0; i < map.waypoints.length; i++) {
    const d = distSq(map.waypoints[i].pos, pos)
    if (d < bestDistSq) {
      bestDistSq = d
      best = i
    }
  }
  return best
}

/**
 * A* over the map's waypoint graph (undirected -- edges are walked in
 * either direction). Edge cost is euclidean distance, except teleporter
 * edges which cost a flat TELEPORTER_EDGE_COST regardless of the real
 * distance between their endpoints (often tens of meters). That non-metric
 * cost breaks admissibility of a euclidean heuristic: h(n) would sometimes
 * overestimate the true remaining cost near a teleporter, which can make
 * A* return a non-optimal path. Graphs here are ~15 nodes, so exhaustive
 * search is free -- h is fixed at 0, making this plain Dijkstra (still
 * O(n^2) via linear open-set scan rather than a heap, per the same "tiny
 * graph" reasoning).
 */
export function findPath(map: GameMap, fromWp: number, toWp: number): number[] {
  if (fromWp === toWp) return [fromWp]

  const n = map.waypoints.length
  const h = (_i: number) => 0

  const open: number[] = [fromWp]
  const gScore = new Array<number>(n).fill(Infinity)
  const fScore = new Array<number>(n).fill(Infinity)
  const cameFrom = new Array<number>(n).fill(-1)
  const closed = new Array<boolean>(n).fill(false)

  gScore[fromWp] = 0
  fScore[fromWp] = h(fromWp)

  while (open.length > 0) {
    let bestIdx = 0
    for (let i = 1; i < open.length; i++) {
      if (fScore[open[i]] < fScore[open[bestIdx]]) bestIdx = i
    }
    const current = open[bestIdx]

    if (current === toWp) {
      const path: number[] = [current]
      let c = current
      while (cameFrom[c] !== -1) {
        c = cameFrom[c]
        path.unshift(c)
      }
      return path
    }

    open.splice(bestIdx, 1)
    closed[current] = true

    for (const edge of map.edges) {
      let neighbor = -1
      if (edge.from === current) neighbor = edge.to
      else if (edge.to === current) neighbor = edge.from
      else continue
      if (closed[neighbor]) continue

      const edgeCost =
        edge.kind === 'teleporter'
          ? TELEPORTER_EDGE_COST
          : euclid(map.waypoints[edge.from].pos, map.waypoints[edge.to].pos)
      const tentativeG = gScore[current] + edgeCost

      if (tentativeG < gScore[neighbor]) {
        cameFrom[neighbor] = current
        gScore[neighbor] = tentativeG
        fScore[neighbor] = tentativeG + h(neighbor)
        if (!open.includes(neighbor)) open.push(neighbor)
      }
    }
  }

  return []
}

function findEdgeKind(map: GameMap, a: number, b: number): 'walk' | 'launchpad' | 'teleporter' | 'grapple' {
  for (const e of map.edges) {
    if ((e.from === a && e.to === b) || (e.from === b && e.to === a)) return e.kind
  }
  return 'walk'
}

function yawTo(from: Vec3, to: Vec3): number {
  return Math.atan2(to.x - from.x, to.z - from.z)
}

/** Distance from point p to segment ab, projected onto the XZ plane. */
function distToSegmentXZ(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x
  const abz = b.z - a.z
  const abLenSq = abx * abx + abz * abz
  if (abLenSq < 1e-9) {
    return Math.hypot(p.x - a.x, p.z - a.z)
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / abLenSq))
  const cx = a.x + abx * t
  const cz = a.z + abz * t
  return Math.hypot(p.x - cx, p.z - cz)
}

/**
 * Per-bot path follower. Owns a goal position and the A* path toward it;
 * steer() is called once per tick and returns the movement input to feed
 * stepMovement, plus whether the bot wants to fire its grapple this tick.
 */
export class Navigator {
  private goal: Vec3 | null = null
  private path: number[] = []
  private pathIndex = 0
  /** Hysteresis latch for the speed governor -- see GOVERNOR_TRIGGER_SPEED. */
  private braking = false
  /** Rising-edge latch + countdown for the sharp-corner full stop. */
  private inCornerZone = false
  private cornerBrakeTicksLeft = 0

  setGoal(pos: Vec3): void {
    this.goal = { ...pos }
    this.path = []
    this.pathIndex = 0
  }

  private replan(map: GameMap, p: PlayerState): void {
    if (!this.goal) return
    const fromWp = nearestWaypoint(map, p.pos)
    const toWp = nearestWaypoint(map, this.goal)
    this.path = findPath(map, fromWp, toWp)
    this.pathIndex = 0
    this.advancePastReachedNodes(map, p)
  }

  private advancePastReachedNodes(map: GameMap, p: PlayerState): void {
    while (
      this.pathIndex < this.path.length - 1 &&
      xzDistSq(p.pos, map.waypoints[this.path[this.pathIndex]].pos) <= ARRIVE_DIST_SQ
    ) {
      this.pathIndex++
    }
  }

  steer(p: PlayerState, map: GameMap, now: number): { input: Partial<PlayerInput>; wantGrapple: boolean } {
    void now

    if (!this.goal) {
      return { input: { forward: 0 }, wantGrapple: false }
    }

    if (this.path.length === 0) {
      this.replan(map, p)
    }

    if (this.path.length === 0) {
      return { input: { forward: 0 }, wantGrapple: false }
    }

    if (this.pathIndex > 0) {
      const a = map.waypoints[this.path[this.pathIndex - 1]].pos
      const b = map.waypoints[this.path[this.pathIndex]].pos
      if (distToSegmentXZ(p.pos, a, b) > UNSTICK_DIST) {
        this.replan(map, p)
      }
    }

    this.advancePastReachedNodes(map, p)

    const targetNode = this.path[this.pathIndex]
    const targetPos = map.waypoints[targetNode].pos
    // pathIndex 0 is the off-graph approach leg (current position -> path[0]), which has
    // no real map edge behind it -- default to 'walk' (so jump/wantGrapple below stay off).
    const edgeKind = this.pathIndex > 0 ? findEdgeKind(map, this.path[this.pathIndex - 1], targetNode) : 'walk'

    const yaw = yawTo(p.pos, targetPos)
    const distToTargetXZ = Math.hypot(targetPos.x - p.pos.x, targetPos.z - p.pos.z)
    const wantGrapple = edgeKind === 'grapple'

    // See GOVERNOR_TRIGGER_SPEED's doc comment: pursuit-curve steering can
    // build runaway speed under this accel model, so cap it every tick
    // regardless of where the bot is on the path (not just near corners --
    // the runaway can build up well before reaching one).
    const speed = Math.hypot(p.vel.x, p.vel.z)
    if (this.braking) {
      if (speed <= GOVERNOR_RELEASE_SPEED) this.braking = false
    } else if (speed > GOVERNOR_TRIGGER_SPEED) {
      this.braking = true
    }

    // See JUMP_TRIGGER_DIST's doc comment for the distance bound, and
    // GOVERNOR_TRIGGER_SPEED's for why !this.braking matters too: no
    // friction/only weak air-accel touches horizontal velocity while
    // airborne, so jumping while the governor is mid-correction freezes
    // its excess speed and carries it, uncancelled, through the ~0.8s hang
    // time -- exactly the runaway-into-a-pit failure this file exists to
    // prevent.
    const jump =
      edgeKind === 'walk' &&
      targetPos.y - p.pos.y > JUMP_HEIGHT_DELTA &&
      distToTargetXZ < JUMP_TRIGGER_DIST &&
      !this.braking

    // See CORNER_BRAKE_TICKS's doc comment: on top of the general governor,
    // force a deterministic full stop on the rising edge of entering a
    // sharp corner's approach zone, so a bot never carries meaningful
    // momentum into the pivot itself.
    let sharpCornerAhead = false
    if (this.pathIndex < this.path.length - 1) {
      const nextPos = map.waypoints[this.path[this.pathIndex + 1]].pos
      const incomingLen = Math.hypot(targetPos.x - p.pos.x, targetPos.z - p.pos.z)
      const outgoingLen = Math.hypot(nextPos.x - targetPos.x, nextPos.z - targetPos.z)
      if (incomingLen > 1e-6 && outgoingLen > 1e-6) {
        const incoming = { x: (targetPos.x - p.pos.x) / incomingLen, z: (targetPos.z - p.pos.z) / incomingLen }
        const outgoing = { x: (nextPos.x - targetPos.x) / outgoingLen, z: (nextPos.z - targetPos.z) / outgoingLen }
        sharpCornerAhead = incoming.x * outgoing.x + incoming.z * outgoing.z < SHARP_TURN_COS
      }
    }
    const inCornerZone = sharpCornerAhead && distToTargetXZ < CORNER_BRAKE_RADIUS
    if (inCornerZone && !this.inCornerZone) {
      this.cornerBrakeTicksLeft = CORNER_BRAKE_TICKS
    }
    this.inCornerZone = inCornerZone

    let forward = this.braking ? 0 : 1
    if (this.cornerBrakeTicksLeft > 0) {
      forward = 0
      this.cornerBrakeTicksLeft--
    }

    return {
      input: { yaw, forward, strafe: 0, jump },
      wantGrapple,
    }
  }
}

function xzDistSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return dx * dx + dz * dz
}
