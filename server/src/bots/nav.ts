import type { GameMap, PlayerInput, PlayerState, Vec3 } from '@riftlane/shared'
import { distSq } from '@riftlane/shared'

/** XZ distance (ignoring height) within which a bot counts a path node as reached. */
const ARRIVE_DIST = 1.2
const ARRIVE_DIST_SQ = ARRIVE_DIST * ARRIVE_DIST

/** Distance from the edge segment the bot thinks it's walking that triggers a re-path. */
const UNSTICK_DIST = 3

/** Minimum height gain onto the next node, on a 'walk' edge, that requires a jump. */
const JUMP_HEIGHT_DELTA = 1

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
 * either direction). Euclidean-distance heuristic and edge cost, except
 * teleporter edges which cost a flat TELEPORTER_EDGE_COST regardless of
 * the real distance between their endpoints. Graphs here are ~15 nodes, so
 * this scans the open set for the lowest f-score each step rather than
 * using a binary heap.
 */
export function findPath(map: GameMap, fromWp: number, toWp: number): number[] {
  if (fromWp === toWp) return [fromWp]

  const n = map.waypoints.length
  const goalPos = map.waypoints[toWp].pos
  const h = (i: number) => euclid(map.waypoints[i].pos, goalPos)

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
    const edgeKind = this.pathIndex > 0 ? findEdgeKind(map, this.path[this.pathIndex - 1], targetNode) : 'walk'

    const yaw = yawTo(p.pos, targetPos)
    const jump = edgeKind === 'walk' && targetPos.y - p.pos.y > JUMP_HEIGHT_DELTA
    const wantGrapple = edgeKind === 'grapple'

    return {
      input: { yaw, forward: 1, strafe: 0, jump },
      wantGrapple,
    }
  }
}

function xzDistSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return dx * dx + dz * dz
}
