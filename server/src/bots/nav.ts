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

/**
 * XZ distance from the goal at which the bot stops pressing forward.
 *
 * Without a stop state steer() drives forward=1 at a point the bot already
 * occupies, and yawTo() on a near-zero delta returns near-noise, so the bot
 * runs full-throttle in a fresh random direction every tick and buzzes in a
 * ~0.5m circle forever instead of arriving. Measured by
 * scripts/bot-stuck-probe.ts before this existed: 44% of all bot-seconds on
 * bastion and 97% on hairpin were spent doing exactly that, every one of
 * them within 0.16m of a flag stand -- which is what a player actually sees
 * as "the bots are stuck in the flag stand".
 *
 * Kept well inside FLAG_PICKUP_RADIUS (1.5), CAPTURE_RADIUS (2) and
 * PICKUP_RADIUS (1.4), so stopping here still counts as reaching the thing
 * the goal was pointing at.
 */
const GOAL_STOP_DIST = 0.9

/**
 * Ticks of no real XZ progress, while actually commanded to move, after
 * which the bot is treated as jammed. ~1s: long enough that a legitimately
 * slow tick (turning in place, climbing) never trips it.
 */
const STUCK_TICKS = 30

/** XZ travel from the stuck anchor that counts as progress and re-arms the check. */
const PROGRESS_DIST = 0.4

/**
 * Ticks of sideways strafe used to slip around whatever blocked the bot.
 * Bots are point-seeking walkers with no obstacle avoidance, and
 * collideCapsule just zeroes the blocked axis -- so a bot walking into a
 * cover box stands there pressing forward until the match ends. The segment-
 * distance UNSTICK_DIST check above cannot see this: a bot jammed *on* its
 * own path line is 0m off that line.
 *
 * Runs a fixed duration rather than ending on first progress, because the
 * sideways travel is itself progress -- ending early would ratchet the bot
 * out 0.4m per second instead of clearing the obstacle in one move. 12 ticks
 * with forward still held gives a 45-degree slip of ~2m sideways, enough to
 * clear the widest cover box on any map (2m) from dead centre. Direction
 * flips after each attempt, so a bot that strafes into a wall goes the other
 * way next time.
 */
const SIDESTEP_TICKS = 12

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
  /** Position the jam detector measures progress against -- see STUCK_TICKS. */
  private progressAnchor: Vec3 | null = null
  private stuckTicks = 0
  private sidestepTicksLeft = 0
  private sidestepDir: 1 | -1 = 1

  setGoal(pos: Vec3): void {
    this.goal = { ...pos }
    this.path = []
    this.pathIndex = 0
    this.clearJamState()
  }

  /** Re-arms the jam detector. Called whenever the bot demonstrably moved,
   * was deliberately stopped, or got a fresh path -- so only genuinely
   * blocked ticks accumulate toward STUCK_TICKS. */
  private clearJamState(): void {
    this.progressAnchor = null
    this.stuckTicks = 0
    this.sidestepTicksLeft = 0
  }

  private replan(map: GameMap, p: PlayerState): void {
    if (!this.goal) return
    const fromWp = nearestWaypoint(map, p.pos)
    const toWp = nearestWaypoint(map, this.goal)
    this.path = findPath(map, fromWp, toWp)
    this.pathIndex = 0
    this.clearJamState()
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

  steer(
    p: PlayerState,
    map: GameMap,
    now: number
  ): { input: Partial<PlayerInput>; wantGrapple: boolean; targetPos: Vec3 | null } {
    void now

    if (!this.goal) {
      return { input: { forward: 0 }, wantGrapple: false, targetPos: null }
    }

    if (this.path.length === 0) {
      this.replan(map, p)
    }

    if (this.path.length === 0) {
      return { input: { forward: 0 }, wantGrapple: false, targetPos: null }
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
    // pathIndex 0 is the off-graph approach leg (current position -> path[0]), which has
    // no real map edge behind it -- default to 'walk' (so jump/wantGrapple below stay off).
    const edgeKind = this.pathIndex > 0 ? findEdgeKind(map, this.path[this.pathIndex - 1], targetNode) : 'walk'

    // Final leg steers at the actual goal, not at the waypoint nearest it.
    // path's last node is nearestWaypoint(goal), so without this the bot's
    // real destination is never a target at all: a defender whose patrol
    // point is 2m off the flag stand walks to the stand's waypoint and
    // arrives nowhere, forever. Restricted to 'walk' so a grapple/launchpad/
    // teleporter final edge still aims at its own waypoint -- wantGrapple
    // below raycasts at targetPos and would otherwise fire at the goal.
    const onFinalLeg = this.pathIndex === this.path.length - 1 && edgeKind === 'walk'
    const targetPos = onFinalLeg ? this.goal : map.waypoints[targetNode].pos

    const distToTargetXZ = Math.hypot(targetPos.x - p.pos.x, targetPos.z - p.pos.z)
    // Standing on the target, the delta fed to yawTo is near-zero and its
    // atan2 is numerical noise -- hold the current facing instead of
    // spinning (see GOAL_STOP_DIST).
    const yaw = distToTargetXZ > 1e-3 ? yawTo(p.pos, targetPos) : p.yaw
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

    // Arrival. Held back while the goal is still a step above the bot, so a
    // runner stopping 0.9m short of a flag stand it has yet to mount keeps
    // pressing (and keeps jumping) instead of parking at the foot of it.
    const arrived = onFinalLeg && distToTargetXZ <= GOAL_STOP_DIST && targetPos.y - p.pos.y <= JUMP_HEIGHT_DELTA

    let forward = arrived || this.braking ? 0 : 1
    if (this.cornerBrakeTicksLeft > 0) {
      forward = 0
      this.cornerBrakeTicksLeft--
    }

    // Jam detection and recovery -- see SIDESTEP_TICKS. Only ticks where the
    // bot was actually told to move count: a governor/corner brake holding
    // forward at 0 is a deliberate stop, not a jam.
    let strafe = 0
    if (forward === 0) {
      this.clearJamState()
    } else {
      if (!this.progressAnchor) this.progressAnchor = { ...p.pos }
      if (this.sidestepTicksLeft > 0) {
        strafe = this.sidestepDir
        this.sidestepTicksLeft--
        if (this.sidestepTicksLeft === 0) {
          this.sidestepDir = this.sidestepDir === 1 ? -1 : 1
          this.clearJamState()
        }
      } else if (xzDistSq(p.pos, this.progressAnchor) >= PROGRESS_DIST * PROGRESS_DIST) {
        this.clearJamState()
      } else if (++this.stuckTicks >= STUCK_TICKS) {
        this.sidestepTicksLeft = SIDESTEP_TICKS
        strafe = this.sidestepDir
      }
    }

    return {
      input: { yaw, forward, strafe, jump },
      wantGrapple,
      targetPos: { ...targetPos },
    }
  }
}

function xzDistSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return dx * dx + dz * dz
}
