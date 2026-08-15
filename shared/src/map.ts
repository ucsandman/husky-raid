import type { Vec3, AABB, WeaponId } from './types'

export interface GameMap {
  name: string
  boxes: AABB[]
  boxColors: number[]
  launchPads: { pos: Vec3; radius: number; velocity: Vec3 }[]
  teleporters: { a: Vec3; b: Vec3; radius: number }[]
  /** Map-placed power weapon spawns. A pad at `pos` offers `weapon`; once
   * taken it respawns `respawnSec` later. Optional: maps without pads omit
   * it and the sim treats it as []. */
  powerPickups?: { pos: Vec3; weapon: WeaponId; respawnSec: number }[]
  spawns: [Vec3[], Vec3[]]
  spawnYaw: [number, number]
  flagStands: [Vec3, Vec3]
  deathY: number
  waypoints: { pos: Vec3 }[]
  edges: { from: number; to: number; kind: 'walk' | 'launchpad' | 'teleporter' | 'grapple' }[]
}

function isInsideBox(p: Vec3, box: AABB): boolean {
  return (
    p.x > box.min.x &&
    p.x < box.max.x &&
    p.y > box.min.y &&
    p.y < box.max.y &&
    p.z > box.min.z &&
    p.z < box.max.z
  )
}

function reachableFromAll(map: GameMap): boolean {
  const n = map.waypoints.length
  if (n === 0) return true
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const e of map.edges) {
    adj[e.from].push(e.to)
    adj[e.to].push(e.from)
  }
  const visited = new Array<boolean>(n).fill(false)
  const queue: number[] = [0]
  visited[0] = true
  let count = 1
  while (queue.length > 0) {
    const cur = queue.shift() as number
    for (const next of adj[cur]) {
      if (!visited[next]) {
        visited[next] = true
        count++
        queue.push(next)
      }
    }
  }
  return count === n
}

export function validateMap(map: GameMap): string[] {
  const problems: string[] = []

  if (map.spawns[0].length < 4) problems.push('team 0 has fewer than 4 spawns')
  if (map.spawns[1].length < 4) problems.push('team 1 has fewer than 4 spawns')

  map.flagStands.forEach((stand, i) => {
    if (map.boxes.some((box) => isInsideBox(stand, box))) {
      problems.push(`flag stand ${i} is inside a box`)
    }
  })

  if (map.boxes.some((box) => map.deathY >= box.max.y)) {
    problems.push('deathY is not below all box tops')
  }

  if (!reachableFromAll(map)) {
    problems.push('not every waypoint is reachable from every other waypoint')
  }

  return problems
}
