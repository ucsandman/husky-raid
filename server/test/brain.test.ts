import { describe, it, expect } from 'vitest'
import { BotBrain, DEFAULT_DIFFICULTY } from '../src/bots/brain'
import { assignRoles, type Role } from '../src/bots/roles'
import { MatchSim, TICK_DT } from '@riftlane/shared'
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

describe('BotBrain: full 8-bot match', () => {
  it('produces at least one capture within 5 sim-minutes, no exceptions', () => {
    const sim = new MatchSim('gutter', 42)
    const brains = new Map<string, BotBrain>()
    for (let i = 0; i < 8; i++) {
      const id = `bot-${i}`
      const team = i < 4 ? 0 : 1
      sim.addPlayer(id, `Bot${i}`, team, true)
      brains.set(id, new BotBrain(id, DEFAULT_DIFFICULTY, 42000 + i + 1))
    }

    // Drive MatchSim + BotBrains directly, mirroring HostedMatch's per-tick
    // wiring (assign roles every 2s / on flag events, think() before tick()),
    // without any real setInterval -- a fast headless loop capped at 5
    // sim-minutes even though MATCH_TIME (480s) is longer.
    let roles = new Map<string, Role>()
    let lastRoleAssignAt = -Infinity
    let now = 0
    let captured = false
    const maxTime = 300

    const recomputeRoles = () => {
      const bots = [...sim.players.values()]
      const team0 = bots.filter((p) => p.team === 0)
      const team1 = bots.filter((p) => p.team === 1)
      roles = new Map([...assignRoles(team0, sim), ...assignRoles(team1, sim)])
    }

    while (now < maxTime && sim.phase === 'playing') {
      now += TICK_DT
      if (now - lastRoleAssignAt >= 2) {
        recomputeRoles()
        lastRoleAssignAt = now
      }
      for (const [id, brain] of brains) {
        const role = roles.get(id) ?? 'defender'
        const input = brain.think(sim, sim.map, role, now)
        sim.setInput(id, input)
      }
      const events = sim.tick(now)
      if (events.some((e) => e.type === 'capture')) captured = true
      if (events.some((e) => e.type === 'flag_taken' || e.type === 'flag_dropped' || e.type === 'flag_returned')) {
        recomputeRoles()
        lastRoleAssignAt = now
      }
    }

    expect(captured).toBe(true)
    // Guards against a silent regression to "one capture right before the
    // clock runs out": the match must actually reach a decisive conclusion
    // (a team hitting CAPTURES_TO_WIN) within the 5-minute cap, not merely
    // produce a single capture event somewhere in a near-300s match.
    // sim.phase only becomes 'ended' here via CAPTURES_TO_WIN -- timeLeft
    // (seeded from MATCH_TIME=480) can't reach 0 within our 300s loop, so
    // this is unambiguous. Empirically the seeded match reaches a 3-0
    // sweep by ~t=89s, comfortably inside the window.
    expect(sim.phase).toBe('ended')
    expect(now).toBeLessThan(maxTime)
  })
})
