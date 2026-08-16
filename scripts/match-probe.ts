/**
 * Seeded bot-match instrument. Runs a full 8-bot match headlessly and reports
 * what actually happened: kills, captures, flag conversion, and which weapons
 * reached bots' hands.
 *
 * This is a measuring tool, not a test. Unit tests assert "a capture
 * happened"; this answers "why not". It exists because the failure it was
 * built for -- bots pathing correctly while going nowhere -- is invisible to
 * every assertion in the suite.
 *
 *   npx tsx scripts/match-probe.ts [map] [seed]
 *   TRACE=bot-0 T0=200 npx tsx scripts/match-probe.ts bastion 77
 *
 * TRACE/T0 dump one bot's position, velocity and weapons for a 6s window
 * starting at T0 seconds, which is how the teleporter-routing loop below was
 * found.
 */
import { MatchSim, MATCH_TIME, TICK_DT } from '@riftlane/shared'
import { BotBrain, DEFAULT_DIFFICULTY } from '../server/src/bots/brain'
import { assignRoles, type Role } from '../server/src/bots/roles'

const mapName = process.argv[2] ?? 'bastion'
const seed = Number(process.argv[3] ?? 77)
const trace = process.env.TRACE
const traceFrom = Number(process.env.T0 ?? 200)

const sim = new MatchSim(mapName, seed)
const brains = new Map<string, BotBrain>()
for (let i = 0; i < 8; i++) {
  const id = `bot-${i}`
  sim.addPlayer(id, `Bot${i}`, i < 4 ? 0 : 1, true)
  brains.set(id, new BotBrain(id, DEFAULT_DIFFICULTY, seed * 1000 + i + 1))
}

let roles = new Map<string, Role>()
let lastRoleAssignAt = -Infinity
let now = 0
const pickups = new Map<string, number>()
const flagEvents = new Map<string, number>()
let kills = 0
let captures = 0
let firstCaptureAt: number | null = null

const recomputeRoles = (): void => {
  const bots = [...sim.players.values()]
  roles = new Map([
    ...assignRoles(bots.filter((p) => p.team === 0), sim),
    ...assignRoles(bots.filter((p) => p.team === 1), sim),
  ])
}

while (now < MATCH_TIME && sim.phase !== 'ended') {
  now += TICK_DT
  if (now - lastRoleAssignAt >= 2) {
    recomputeRoles()
    lastRoleAssignAt = now
  }
  for (const [id, brain] of brains) {
    sim.setInput(id, brain.think(sim, sim.map, roles.get(id) ?? 'defender', now))
  }
  if (trace && now > traceFrom && now < traceFrom + 6) {
    const p = sim.players.get(trace)
    if (p) {
      console.log(
        `t=${now.toFixed(2)} pos=(${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)}) ` +
          `vel=(${p.vel.x.toFixed(1)},${p.vel.z.toFixed(1)}) alive=${p.alive} ` +
          `w=${p.weapons.join('/')} yaw=${p.yaw.toFixed(2)}`
      )
    }
  }
  for (const e of sim.tick(now)) {
    if (e.type === 'pickup') pickups.set(e.weapon, (pickups.get(e.weapon) ?? 0) + 1)
    if (e.type === 'kill') kills++
    if (e.type === 'capture') {
      captures++
      if (firstCaptureAt === null) firstCaptureAt = now
    }
    if (e.type === 'flag_taken' || e.type === 'flag_dropped' || e.type === 'flag_returned') {
      flagEvents.set(e.type, (flagEvents.get(e.type) ?? 0) + 1)
      recomputeRoles()
      lastRoleAssignAt = now
    }
  }
}

const taken = flagEvents.get('flag_taken') ?? 0
console.log(`\n=== ${mapName} seed ${seed} ===`)
console.log(`ended=${sim.phase === 'ended'}  t=${now.toFixed(1)}s  score=${sim.scores.join('-')}`)
console.log(`captures=${captures} (first at ${firstCaptureAt?.toFixed(1) ?? 'never'})  kills=${kills}`)
console.log(
  `flag conversion: ${captures}/${taken} takes` +
    (taken > 0 ? ` (${((captures / taken) * 100).toFixed(0)}%)` : '')
)
console.log('flag events:', Object.fromEntries(flagEvents))
console.log('pickups by weapon:', Object.fromEntries([...pickups].sort((a, b) => b[1] - a[1])))
