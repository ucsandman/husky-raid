/**
 * Bot stuck probe: drives real headless matches with real BotBrains and
 * reports every place a bot pressed movement input but did not actually
 * move, grouped by the map boxes it was touching at the time.
 *
 *   npm run bots:probe            # all maps, 180 sim-seconds each
 *   SECONDS=600 npm run bots:probe
 *
 * Why this exists: unit tests assert paths and arrivals, so they cannot see
 * a bot that is technically pathing correctly while physically going
 * nowhere. On 2026-08-14 bots spent 44% of every bastion match and 98% of
 * every hairpin match jammed or vibrating in place, with 185 tests green --
 * two separate Navigator bugs (no arrival state, and an unstick check that
 * measured distance from the path line rather than actual progress). This
 * script is what found both, and what proves they stay fixed.
 */
import { MatchSim, TICK_DT, MAPS, PLAYER_RADIUS, PLAYER_HEIGHT } from '@riftlane/shared'
import type { AABB, Vec3 } from '@riftlane/shared'
import { BotBrain, DEFAULT_DIFFICULTY } from '../server/src/bots/brain.ts'
import { assignRoles, type Role } from '../server/src/bots/roles.ts'

const SIM_SECONDS = Number(process.env.SECONDS ?? 180)
const WINDOW_TICKS = 45 // 1.5s
const STUCK_MOVE_M = 0.6 // moved less than this over the window == stuck
const WANT_MOVE = 0.1 // |forward| above this == bot is pressing to move

type Sample = { pos: Vec3; forward: number; alive: boolean }
type Episode = {
  botId: string
  pos: Vec3
  ticks: number
  contacts: number[]
  role: string
  amplitude: number
  nearestWpDist: number
  standDist: number
  vel: Vec3
  grounded: boolean
  input: { forward: number; strafe: number }
}

function xzDist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** Boxes whose AABB the player's AABB is touching (within eps) right now. */
function contacts(pos: Vec3, boxes: AABB[]): number[] {
  const eps = 0.06
  const min = { x: pos.x - PLAYER_RADIUS - eps, y: pos.y - eps, z: pos.z - PLAYER_RADIUS - eps }
  const max = { x: pos.x + PLAYER_RADIUS + eps, y: pos.y + PLAYER_HEIGHT + eps, z: pos.z + PLAYER_RADIUS + eps }
  const out: number[] = []
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]
    if (min.x < b.max.x && max.x > b.min.x && min.y < b.max.y && max.y > b.min.y && min.z < b.max.z && max.z > b.min.z) {
      out.push(i)
    }
  }
  return out
}

function runMap(mapName: string) {
  const sim = new MatchSim(mapName, 12345)
  const brains = new Map<string, BotBrain>()
  for (let i = 0; i < 8; i++) {
    const id = `bot-${i}`
    const team = i % 2 === 0 ? 0 : 1
    sim.addPlayer(id, id, team as 0 | 1, true)
    brains.set(id, new BotBrain(id, DEFAULT_DIFFICULTY, 12345 * 1000 + i + 1))
  }

  let roles = new Map<string, Role>()
  let lastRoleAt = -Infinity
  let now = 0
  const history = new Map<string, Sample[]>()
  const episodes: Episode[] = []
  const open = new Map<string, Episode>()

  let liveTicks = 0
  const ticks = Math.floor(SIM_SECONDS / TICK_DT)
  for (let t = 0; t < ticks; t++) {
    now += TICK_DT
    if (now - lastRoleAt >= 2) {
      const bots = [...sim.players.values()].filter((p) => p.bot)
      roles = new Map([
        ...assignRoles(bots.filter((p) => p.team === 0), sim),
        ...assignRoles(bots.filter((p) => p.team === 1), sim),
      ])
      lastRoleAt = now
    }
    const inputs = new Map<string, number>()
    const rawInputs = new Map<string, { forward: number; strafe: number }>()
    for (const [id, brain] of brains) {
      if (!sim.players.has(id)) continue
      const input = brain.think(sim, sim.map, roles.get(id) ?? 'defender', now)
      inputs.set(id, Math.hypot(input.forward, input.strafe))
      rawInputs.set(id, { forward: input.forward, strafe: input.strafe })
      sim.setInput(id, input)
    }
    sim.tick(now)
    // tick() is a no-op once phase === 'ended' -- players freeze while brains
    // keep thinking, which would score every bot as jammed for the rest of
    // the run. Only 'playing' ticks are real evidence.
    if (sim.phase !== 'playing') {
      history.clear()
      open.clear()
      liveTicks = liveTicks
      continue
    }
    liveTicks++

    for (const [id] of brains) {
      const p = sim.players.get(id)
      if (!p) continue
      let h = history.get(id)
      if (!h) {
        h = []
        history.set(id, h)
      }
      h.push({ pos: { ...p.pos }, forward: inputs.get(id) ?? 0, alive: p.alive })
      if (h.length > WINDOW_TICKS) h.shift()
      if (h.length < WINDOW_TICKS) continue

      const aliveThroughout = h.every((s) => s.alive)
      const pressing = h.filter((s) => s.forward > WANT_MOVE).length >= WINDOW_TICKS * 0.8
      let maxMove = 0
      for (const s of h) maxMove = Math.max(maxMove, xzDist(s.pos, h[0].pos))
      const stuck = aliveThroughout && pressing && maxMove < STUCK_MOVE_M

      const cur = open.get(id)
      if (stuck) {
        if (cur) cur.ticks++
        else {
          let nearestWpDist = Infinity
          for (const wp of sim.map.waypoints) nearestWpDist = Math.min(nearestWpDist, xzDist(wp.pos, p.pos))
          const ep: Episode = {
            botId: id,
            pos: { ...p.pos },
            ticks: WINDOW_TICKS,
            contacts: contacts(p.pos, sim.map.boxes),
            role: roles.get(id) ?? '?',
            amplitude: maxMove,
            nearestWpDist,
            standDist: xzDist(sim.map.flagStands[p.team], p.pos),
            vel: { ...p.vel },
            grounded: p.grounded,
            input: { forward: rawInputs.get(id)?.forward ?? 0, strafe: rawInputs.get(id)?.strafe ?? 0 },
          }
          open.set(id, ep)
          episodes.push(ep)
        }
      } else if (cur) {
        open.delete(id)
      }
    }
  }

  return { episodes, liveSec: liveTicks * TICK_DT }
}

for (const mapName of Object.keys(MAPS)) {
  const { episodes: eps, liveSec } = runMap(mapName)
  const totalTicks = eps.reduce((a, e) => a + e.ticks, 0)
  console.log(
    `\n=== ${mapName} === ${eps.length} stuck episodes, ${(totalTicks * TICK_DT).toFixed(1)}s stuck ` +
      `of ${(liveSec * 8).toFixed(0)}s live bot-time`
  )
  const byContact = new Map<string, { n: number; secs: number; example: Episode }>()
  for (const e of eps) {
    const key = e.contacts.join(',') || 'none'
    const row = byContact.get(key)
    if (row) {
      row.n++
      row.secs += e.ticks * TICK_DT
    } else byContact.set(key, { n: 1, secs: e.ticks * TICK_DT, example: e })
  }
  for (const [key, row] of [...byContact.entries()].sort((a, b) => b[1].secs - a[1].secs)) {
    const e = row.example
    console.log(
      `  boxes[${key}]  x${row.n}  ${row.secs.toFixed(1)}s  e.g. ${e.botId}(${e.role}) at ` +
        `(${e.pos.x.toFixed(2)}, ${e.pos.y.toFixed(2)}, ${e.pos.z.toFixed(2)})  ` +
        `amp=${e.amplitude.toFixed(2)}m  nearestWp=${e.nearestWpDist.toFixed(2)}m  ownStand=${e.standDist.toFixed(2)}m  ` +
        `vel=(${e.vel.x.toFixed(2)},${e.vel.y.toFixed(2)},${e.vel.z.toFixed(2)}) grounded=${e.grounded} in=(f${e.input.forward.toFixed(2)},s${e.input.strafe.toFixed(2)})`
    )
  }
}
