import { describe, it, expect } from 'vitest'
import { BotBrain, DEFAULT_DIFFICULTY } from '../src/bots/brain'
import { assignRoles, type Role } from '../src/bots/roles'
import { MatchSim, TICK_DT, MATCH_TIME, stepMovement } from '@riftlane/shared'
import type { PlayerState } from '@riftlane/shared'

describe('assignRoles: idle team', () => {
  it('keeps a runner and defender for 4 idle bots, no flags moving', () => {
    const sim = new MatchSim('gutter', 1)
    const team: PlayerState[] = []
    for (let i = 0; i < 4; i++) team.push(sim.addPlayer(`b${i}`, `B${i}`, 0, true))

    const roles = assignRoles(team, sim)
    const values = [...roles.values()]
    expect(values).toContain('runner')
    expect(values).toContain('defender')
    expect(values).not.toContain('hunter')
    expect(values).not.toContain('escort')
  })
})

describe('assignRoles: hunter', () => {
  it('appears when our flag is taken and is assigned to the nearest bot', () => {
    const sim = new MatchSim('gutter', 2)
    const carrier = sim.addPlayer('enemy-1', 'Enemy', 1, true)
    carrier.pos = { x: 0, y: 0, z: 0 }
    sim.flags[0] = { state: 'carried', pos: { ...carrier.pos }, carrierId: carrier.id }

    const near = sim.addPlayer('b-near', 'Near', 0, true)
    near.pos = { x: 0, y: 0, z: -2 }
    const far = sim.addPlayer('b-far', 'Far', 0, true)
    far.pos = { x: 0, y: 0, z: -20 }
    const other = sim.addPlayer('b-other', 'Other', 0, true)
    other.pos = { x: 0, y: 0, z: -25 }

    const roles = assignRoles([near, far, other], sim)
    expect(roles.get('b-near')).toBe('hunter')
    const values = [...roles.values()]
    expect(values).toContain('runner')
    expect(values).toContain('defender')
  })
})

describe('assignRoles: 3 bots + 1 human, both flags out', () => {
  it('assigns hunter and escort, and makes the lone leftover bot a runner (not a defender)', () => {
    const sim = new MatchSim('gutter', 8)

    // Enemy carrier holding OUR flag -- triggers hunter.
    const enemyCarrier = sim.addPlayer('enemy-carrier', 'EnemyCarrier', 1, true)
    enemyCarrier.pos = { x: 0, y: 0, z: -10 }
    sim.flags[0] = { state: 'carried', pos: { ...enemyCarrier.pos }, carrierId: enemyCarrier.id }

    // The team's human -- carrying the enemy flag, triggering escort. Never
    // appears in the pool passed to assignRoles (match.ts only ever scores
    // roles for bots), so this also checks the human doesn't need a role
    // itself to still correctly drive hunter/escort targeting.
    const human = sim.addPlayer('human-1', 'Human', 0, false)
    human.pos = { x: 0, y: 0, z: 20 }
    sim.flags[1] = { state: 'carried', pos: { ...human.pos }, carrierId: human.id }

    const hunterCandidate = sim.addPlayer('b-hunter', 'HunterCandidate', 0, true)
    hunterCandidate.pos = { x: 0, y: 0, z: -9 } // nearest to enemyCarrier
    const escortCandidate = sim.addPlayer('b-escort', 'EscortCandidate', 0, true)
    escortCandidate.pos = { x: 0, y: 0, z: 19 } // nearest to the human carrier
    const leftover = sim.addPlayer('b-leftover', 'Leftover', 0, true)
    leftover.pos = { x: 0, y: 0, z: -26 } // far from both carriers

    const roles = assignRoles([hunterCandidate, escortCandidate, leftover], sim)

    expect(roles.get('b-hunter')).toBe('hunter')
    expect(roles.get('b-escort')).toBe('escort')
    expect(roles.get('b-leftover')).toBe('runner')
    expect(roles.size).toBe(3)
    expect([...roles.values()]).not.toContain('defender')
  })
})

describe('BotBrain: reaction delay', () => {
  it('does not fire before reactionMs, fires after', () => {
    const sim = new MatchSim('gutter', 3)
    const bot = sim.addPlayer('bot-1', 'Bot', 0, true)
    bot.pos = { x: 0, y: 0, z: -10 }
    const enemy = sim.addPlayer('enemy-1', 'Enemy', 1, true)
    enemy.pos = { x: 0, y: 0, z: -5 } // 5m ahead, clear LOS down the open lane

    const brain = new BotBrain('bot-1', DEFAULT_DIFFICULTY, 999)

    let now = 0
    let firedBefore = false
    let firedAfter = false
    while (now < 0.5) {
      const input = brain.think(sim, sim.map, 'hunter', now)
      if (now < 0.349 && input.fire) firedBefore = true
      if (now >= 0.35 && input.fire) firedAfter = true
      now += TICK_DT
    }

    expect(firedBefore).toBe(false)
    expect(firedAfter).toBe(true)
  })
})

describe('BotBrain: camo visibility', () => {
  it('never targets a camo\'d enemy beyond 4m', () => {
    const sim = new MatchSim('gutter', 4)
    const bot = sim.addPlayer('bot-1', 'Bot', 0, true)
    bot.pos = { x: 0, y: 0, z: -10 }
    const enemy = sim.addPlayer('enemy-1', 'Enemy', 1, true)
    enemy.pos = { x: 0, y: 0, z: -20 } // 10m away
    enemy.camoUntil = 1000

    const brain = new BotBrain('bot-1', DEFAULT_DIFFICULTY, 111)
    let now = 0
    let everFired = false
    while (now < 1) {
      const input = brain.think(sim, sim.map, 'hunter', now)
      if (input.fire) everFired = true
      now += TICK_DT
    }
    expect(everFired).toBe(false)
  })

  it('fires on a non-camo\'d enemy at the same 10m distance (positive control: proves the case above fails on the camo rule, not on blocked LOS)', () => {
    const sim = new MatchSim('gutter', 9)
    const bot = sim.addPlayer('bot-1', 'Bot', 0, true)
    bot.pos = { x: 0, y: 0, z: -10 }
    const enemy = sim.addPlayer('enemy-1', 'Enemy', 1, true)
    enemy.pos = { x: 0, y: 0, z: -20 } // same 10m distance as the camo case above, no camo

    const brain = new BotBrain('bot-1', DEFAULT_DIFFICULTY, 112)
    let now = 0
    let fired = false
    while (now < 1) {
      const input = brain.think(sim, sim.map, 'hunter', now)
      if (input.fire) fired = true
      now += TICK_DT
    }
    expect(fired).toBe(true)
  })

  it('targets a camo\'d enemy within 4m', () => {
    const sim = new MatchSim('gutter', 5)
    const bot = sim.addPlayer('bot-1', 'Bot', 0, true)
    bot.pos = { x: 0, y: 0, z: -10 }
    const enemy = sim.addPlayer('enemy-1', 'Enemy', 1, true)
    enemy.pos = { x: 0, y: 0, z: -7 } // 3m away
    enemy.camoUntil = 1000

    const brain = new BotBrain('bot-1', DEFAULT_DIFFICULTY, 222)
    let now = 0
    let fired = false
    while (now < 1) {
      const input = brain.think(sim, sim.map, 'hunter', now)
      if (input.fire) fired = true
      now += TICK_DT
    }
    expect(fired).toBe(true)
  })
})

describe('BotBrain: weapon choice', () => {
  it('swaps from railspike to scattergun when the enemy closes to 2m', () => {
    const sim = new MatchSim('gutter', 6)
    const bot = sim.addPlayer('bot-1', 'Bot', 0, true)
    bot.pos = { x: 0, y: 0, z: 0 }
    bot.weapons = ['railspike', 'scattergun']
    bot.activeWeapon = 0
    const enemy = sim.addPlayer('enemy-1', 'Enemy', 1, true)
    enemy.pos = { x: 0, y: 0, z: 2 }

    const brain = new BotBrain('bot-1', DEFAULT_DIFFICULTY, 333)
    const input = brain.think(sim, sim.map, 'hunter', 0)
    expect(input.swap).toBe(true)
  })
})

describe('BotBrain: neutral input omits sprint/slideRequest (pins bot pacing)', () => {
  it('a bot-generated input with no sprint/slideRequest fields steps movement identically to the same input with them explicitly false', () => {
    const sim = new MatchSim('gutter', 50)
    const bot = sim.addPlayer('bot-1', 'Bot', 0, true)
    const brain = new BotBrain('bot-1', DEFAULT_DIFFICULTY, 500)

    // BotBrain.think() never sets sprint/slideRequest -- its return object
    // (brain.ts) only populates the pre-sprint-era PlayerInput fields.
    // These are optional (types.ts), so an absent field and an explicit
    // `false` must produce identical stepMovement results -- otherwise a
    // later pass that starts defaulting them to something other than
    // `=== true` would silently change bot pacing.
    const botInput = brain.think(sim, sim.map, 'defender', 0)
    expect(botInput).not.toHaveProperty('sprint')
    expect(botInput).not.toHaveProperty('slideRequest')

    const preSprintEraInput = { ...botInput, sprint: false, slideRequest: false }

    const stateA: PlayerState = { ...bot, pos: { ...bot.pos }, vel: { ...bot.vel } }
    const stateB: PlayerState = { ...bot, pos: { ...bot.pos }, vel: { ...bot.vel } }

    stepMovement(stateA, botInput, sim.map, TICK_DT)
    stepMovement(stateB, preSprintEraInput, sim.map, TICK_DT)

    expect(stateA.pos).toEqual(stateB.pos)
    expect(stateA.vel).toEqual(stateB.vel)
    expect(stateA.grounded).toEqual(stateB.grounded)
    expect(stateA.sprinting).toEqual(stateB.sprinting)
    expect(stateA.sliding).toEqual(stateB.sliding)
  })
})

/**
 * Drives MatchSim + BotBrains directly for a full MATCH_TIME, mirroring
 * HostedMatch's per-tick wiring (assign roles every 2s / on flag events,
 * think() before tick()) without any real setInterval.
 *
 * Runs a WHOLE MATCH per call, so the canaries below spend seeds carefully.
 */
function runBotMatch(
  mapName: 'gutter' | 'bastion',
  seed: number,
): { captures: number; takes: number; decisive: boolean } {
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
  let captures = 0
  let takes = 0
  const recomputeRoles = () => {
    const bots = [...sim.players.values()]
    roles = new Map([
      ...assignRoles(
        bots.filter((p) => p.team === 0),
        sim,
      ),
      ...assignRoles(
        bots.filter((p) => p.team === 1),
        sim,
      ),
    ])
  }

  // Loop on "not ended" rather than "=== 'playing'": MatchSim.phase also has
  // a 'warmup' value, so a phase that starts in warmup must not end this loop
  // before a single tick runs.
  while (now < MATCH_TIME && sim.phase !== 'ended') {
    now += TICK_DT
    if (now - lastRoleAssignAt >= 2) {
      recomputeRoles()
      lastRoleAssignAt = now
    }
    for (const [id, brain] of brains) {
      sim.setInput(id, brain.think(sim, sim.map, roles.get(id) ?? 'defender', now))
    }
    const events = sim.tick(now)
    for (const e of events) {
      if (e.type === 'capture') captures++
      if (e.type === 'flag_taken') takes++
    }
    if (events.some((e) => e.type === 'flag_taken' || e.type === 'flag_dropped' || e.type === 'flag_returned')) {
      recomputeRoles()
      lastRoleAssignAt = now
    }
  }

  // `now < MATCH_TIME` is what "decisive" means, NOT the phase: sim.ts sets
  // phase='ended' on `scores >= CAPTURES_TO_WIN || timeLeft <= 0`, so a match
  // that merely runs out the clock also lands on 'ended'.
  return { captures, takes, decisive: sim.phase === 'ended' && now < MATCH_TIME }
}

/**
 * Both canaries below assert PER-SEED what a single match reliably shows (a
 * runner reaches the enemy flag at all, which is the nav property) and only
 * AGGREGATE what one match cannot (scoring). One seeded match is no longer a
 * fair sample of offense: every life now rolls two random weapons out of the
 * whole roster, so lethality per match swings hard -- measured on gutter seed
 * 42, kills went 153 -> 309 and the decisive finish went from t=296s to not
 * at all, while seeds 1 and 3 still finish decisively. Pinning one seed here
 * would be measuring the seed, not the bots. Seeds are 1..3 (a contiguous
 * range, not hand-picked outcomes).
 */
const CANARY_SEEDS = [1, 2, 3]

describe('BotBrain: full 8-bot match', () => {
  it('takes flags on every seed and finishes at least one match decisively', () => {
    const runs = CANARY_SEEDS.map((seed) => ({ seed, ...runBotMatch('gutter', seed) }))

    for (const r of runs) {
      expect(r.takes, `gutter seed ${r.seed} never took a flag`).toBeGreaterThan(0)
      expect(r.captures, `gutter seed ${r.seed} never scored`).toBeGreaterThan(0)
    }
    // Guards the regression fdcafc3 caused: bot offense collapsing into "no
    // match ever reaches CAPTURES_TO_WIN before the clock".
    expect(runs.some((r) => r.decisive), `no gutter seed reached a decisive score: ${JSON.stringify(runs)}`).toBe(true)
  })
})

describe('BotBrain: full 8-bot match on bastion', () => {
  it('takes flags on every seed and captures at least once across them', () => {
    // Map-side acceptance test for bastion: ~3x gutter's area, three separate
    // routes, six doorway crossings, and bots are point-seeking walkers with
    // no obstacle avoidance -- so any waypoint edge that clips a wall or a
    // cover box strands a runner. A stranded runner shows up as takes === 0.
    const runs = CANARY_SEEDS.map((seed) => ({ seed, ...runBotMatch('bastion', seed) }))

    for (const r of runs) {
      expect(r.takes, `bastion seed ${r.seed} never took a flag`).toBeGreaterThan(0)
    }
    const total = runs.reduce((n, r) => n + r.captures, 0)
    expect(total, `bastion never scored across seeds: ${JSON.stringify(runs)}`).toBeGreaterThan(0)
  })
})
