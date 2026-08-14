import { describe, it, expect } from 'vitest'
import { MatchSim } from '../src/sim'
import { mulberry32 } from '../src/rng'
import { rollLoadout } from '../src/weapons'
import { MAPS } from '../src/maps'
import {
  TICK_DT,
  RESPAWN_DELAY,
  FLAG_RETURN_TIME,
  CAPTURES_TO_WIN,
  MAX_SHIELD,
  MAX_HEALTH,
  CAMO_DURATION,
} from '../src/constants'
import { makeInput } from './helpers'

function runTicks(sim: MatchSim, n: number, startNow: number) {
  const events = []
  let now = startNow
  for (let i = 0; i < n; i++) {
    now += TICK_DT
    events.push(...sim.tick(now))
  }
  return { events, now }
}

describe('MatchSim: full capture loop', () => {
  it('touching the enemy flag then walking it home scores a capture', () => {
    const sim = new MatchSim('gutter', 1)
    const a = sim.addPlayer('a', 'A', 0, false)
    sim.addPlayer('b', 'B', 1, false)

    // Teleport A onto the enemy (team 1) flag stand.
    a.pos = { ...MAPS.gutter.flagStands[1] }
    let events = sim.tick(1)
    expect(events.some((e) => e.type === 'flag_taken' && e.team === 1 && e.playerId === 'a')).toBe(true)
    expect(sim.flags[1].state).toBe('carried')
    expect(sim.flags[1].carrierId).toBe('a')

    // Walk it home to A's own (team 0) stand.
    a.pos = { ...MAPS.gutter.flagStands[0] }
    events = sim.tick(2)
    expect(events.some((e) => e.type === 'capture' && e.team === 0 && e.playerId === 'a')).toBe(true)
    expect(sim.scores).toEqual([1, 0])
    expect(sim.flags[1].state).toBe('stand')
    expect(sim.flags[1].pos).toEqual(MAPS.gutter.flagStands[1])
    expect(a.carryingFlag).toBe(null)
  })
})

describe('MatchSim: flag drops on death, returns after 15s', () => {
  it('drops the carried flag on death and auto-returns after FLAG_RETURN_TIME', () => {
    const sim = new MatchSim('gutter', 2)
    const a = sim.addPlayer('a', 'A', 0, false)
    sim.addPlayer('b', 'B', 1, false)

    a.pos = { ...MAPS.gutter.flagStands[1] }
    sim.tick(1)
    expect(sim.flags[1].state).toBe('carried')

    const killEvents = sim.damage('a', 1000)
    expect(killEvents.some((e) => e.type === 'flag_dropped' && e.team === 1)).toBe(true)
    expect(sim.flags[1].state).toBe('dropped')
    expect(a.alive).toBe(false)

    // Advance well past FLAG_RETURN_TIME (15s) of ticks.
    const ticks = Math.ceil((FLAG_RETURN_TIME + 1) / TICK_DT)
    const { events } = runTicks(sim, ticks, 1)
    expect(events.some((e) => e.type === 'flag_returned' && e.team === 1)).toBe(true)
    expect(sim.flags[1].state).toBe('stand')
  })
})

describe('MatchSim: defender touch-return', () => {
  it('instantly returns a dropped flag when its own team touches it', () => {
    const sim = new MatchSim('gutter', 3)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)

    a.pos = { ...MAPS.gutter.flagStands[1] }
    sim.tick(1)
    expect(sim.flags[1].state).toBe('carried')

    sim.damage('a', 1000)
    expect(sim.flags[1].state).toBe('dropped')
    const dropPos = { ...sim.flags[1].pos }

    // B is on team 1 -- the flag's own team -- and touches the dropped flag.
    b.pos = { ...dropPos }
    const events = sim.tick(1 + TICK_DT)
    expect(events.some((e) => e.type === 'flag_returned' && e.team === 1 && e.playerId === 'b')).toBe(true)
    expect(sim.flags[1].state).toBe('stand')
    expect(sim.flags[1].pos).toEqual(MAPS.gutter.flagStands[1])
  })
})

describe('MatchSim: respawn re-rolls loadout', () => {
  it('revives the player with full shield after RESPAWN_DELAY, per the seeded rng sequence', () => {
    const seed = 42
    const sim = new MatchSim('gutter', seed)
    const a = sim.addPlayer('a', 'A', 0, false)
    sim.addPlayer('b', 'B', 1, false)

    // Independently replay the same rng sequence the sim consumes:
    // addPlayer(a), addPlayer(b), then respawnPlayer(a) on revival.
    const rand = mulberry32(seed)
    rollLoadout(rand) // consumed by addPlayer('a')
    rollLoadout(rand) // consumed by addPlayer('b')
    const expectedRespawnLoadout = rollLoadout(rand) // consumed by a's respawn

    sim.damage('a', 1000)
    expect(a.alive).toBe(false)

    const ticksToRespawn = Math.ceil((RESPAWN_DELAY + 0.5) / TICK_DT)
    runTicks(sim, ticksToRespawn, 1)

    expect(a.alive).toBe(true)
    expect(a.shield).toBe(MAX_SHIELD)
    expect(a.weapons).toEqual(expectedRespawnLoadout.weapons)
  })
})

describe('MatchSim: match ends at 3 captures', () => {
  it('ends the match, reports the winner, and stops emitting events after', () => {
    const sim = new MatchSim('gutter', 4)
    const a = sim.addPlayer('a', 'A', 0, false)
    sim.addPlayer('b', 'B', 1, false)

    let now = 0
    for (let cap = 0; cap < CAPTURES_TO_WIN; cap++) {
      a.pos = { ...MAPS.gutter.flagStands[1] }
      now += TICK_DT
      sim.tick(now)
      a.pos = { ...MAPS.gutter.flagStands[0] }
      now += TICK_DT
      const events = sim.tick(now)
      if (cap === CAPTURES_TO_WIN - 1) {
        expect(events.some((e) => e.type === 'match_end' && e.winner === 0)).toBe(true)
      }
    }

    expect(sim.phase).toBe('ended')
    expect(sim.scores[0]).toBe(CAPTURES_TO_WIN)

    now += TICK_DT
    const noEvents = sim.tick(now)
    expect(noEvents).toEqual([])
  })
})

describe('MatchSim: suicide in pit', () => {
  it('scores a death but no kill credit', () => {
    const sim = new MatchSim('gutter', 5)
    const a = sim.addPlayer('a', 'A', 0, false)
    sim.addPlayer('b', 'B', 1, false)

    // x = -3.5 sits in the gutter's death-pit gap (no floor box between the
    // center lane at x=[-3,3] and the left rail at x=[-6,-4]) and is well
    // clear of both launch pads (at x=-1 and x=1, radius 1), so the player
    // falls straight through to deathY instead of getting relaunched.
    a.pos = { x: -3.5, y: 5, z: 0 }
    a.vel = { x: 0, y: 0, z: 0 }
    a.grounded = false

    let now = 0
    let fellEvent: unknown
    for (let i = 0; i < 60 && !fellEvent; i++) {
      now += TICK_DT
      const events = sim.tick(now)
      fellEvent = events.find((e) => e.type === 'kill' && e.victimId === 'a')
    }

    expect(fellEvent).toBeDefined()
    expect((fellEvent as { killerId: string }).killerId).toBe('a')
    expect(a.deaths).toBe(1)
    expect(a.kills).toBe(0)
  })
})

describe('MatchSim: determinism', () => {
  it('two sims with the same seed and same scripted inputs end up identical after 300 ticks', () => {
    function buildAndRun(): unknown {
      const sim = new MatchSim('gutter', 99)
      sim.addPlayer('a', 'A', 0, false)
      sim.addPlayer('b', 'B', 1, false)

      let now = 0
      for (let i = 0; i < 300; i++) {
        now += TICK_DT
        sim.setInput('a', makeInput({ yaw: 0.3, forward: 1, strafe: i % 7 === 0 ? 1 : 0, jump: i % 20 === 0 }))
        sim.setInput('b', makeInput({ yaw: Math.PI, forward: 1, fire: i % 5 === 0 }))
        sim.tick(now)
      }

      return [...sim.players.values()].map((p) => ({
        id: p.id,
        pos: p.pos,
        vel: p.vel,
        alive: p.alive,
      }))
    }

    const runA = buildAndRun()
    const runB = buildAndRun()
    expect(runA).toEqual(runB)
  })
})

describe('MatchSim: flag carrier cannot shoot (fix 1)', () => {
  it('blocks fire while carrying a flag, but melee still works and is rate-limited; non-carrier unaffected', () => {
    const sim = new MatchSim('gutter', 10)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.weapons = ['pulse_smg', 'pulse_smg']
    a.ammo = [30, 30]
    a.activeWeapon = 0
    a.carryingFlag = 1
    b.pos = { x: 1000, y: 0, z: 1000 } // out of range so no stray hits

    sim.setInput('a', makeInput({ yaw: a.yaw, fire: true }))
    let now = TICK_DT
    let events = sim.tick(now)
    expect(events.some((e) => e.type === 'shot' && e.playerId === 'a')).toBe(false)
    expect(a.ammo[0]).toBe(30)

    // melee still works (rate-limited via cooldownUntil) while carrying
    sim.setInput('a', makeInput({ yaw: a.yaw, melee: true }))
    now += TICK_DT
    sim.tick(now)
    expect(a.cooldownUntil).toBeGreaterThan(now)

    // non-carrier fires normally
    b.pos = { ...a.pos }
    b.weapons = ['pulse_smg', 'pulse_smg']
    b.ammo = [30, 30]
    b.activeWeapon = 0
    b.carryingFlag = null
    sim.setInput('a', makeInput({ yaw: a.yaw }))
    sim.setInput('b', makeInput({ yaw: b.yaw, fire: true }))
    now += TICK_DT
    events = sim.tick(now)
    expect(events.some((e) => e.type === 'shot' && e.playerId === 'b')).toBe(true)
  })
})

describe('MatchSim: homing wiring (fix 2)', () => {
  it('a swarm dart fired ~15deg off-axis homes onto and hits an enemy in the forward cone', () => {
    const sim = new MatchSim('gutter', 20)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.weapons = ['swarm_pod', 'swarm_pod']
    a.ammo = [12, 12]
    a.activeWeapon = 0
    a.pos = { x: 0, y: 1, z: 0 }
    a.yaw = 0 // forward = +z
    a.pitch = 0

    const angle = Math.PI / 12 // 15 degrees off boresight
    const dist = 10
    b.pos = { x: Math.sin(angle) * dist, y: 1, z: Math.cos(angle) * dist }

    sim.setInput('a', makeInput({ yaw: 0, pitch: 0, fire: true }))
    sim.tick(TICK_DT)
    expect(sim.projectiles.length).toBe(1)
    expect(sim.projectiles[0].homingTargetId).toBe('b')

    let now = TICK_DT
    let hit = false
    for (let i = 0; i < 90 && !hit; i++) {
      now += TICK_DT
      const events = sim.tick(now)
      hit = events.some((e) => e.type === 'explosion')
    }
    expect(hit).toBe(true)
    expect(b.health + b.shield).toBeLessThan(MAX_SHIELD + MAX_HEALTH)
  })

  it('a dart with no enemy in the forward cone flies straight (no homing target)', () => {
    const sim = new MatchSim('gutter', 21)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.weapons = ['swarm_pod', 'swarm_pod']
    a.ammo = [12, 12]
    a.activeWeapon = 0
    a.pos = { x: 0, y: 1, z: 0 }
    a.yaw = 0
    a.pitch = 0
    b.pos = { x: 0, y: 1, z: -10 } // directly behind -- well outside the forward cone

    sim.setInput('a', makeInput({ yaw: 0, pitch: 0, fire: true }))
    sim.tick(TICK_DT)
    expect(sim.projectiles.length).toBe(1)
    expect(sim.projectiles[0].homingTargetId).toBeUndefined()
  })
})

describe('MatchSim: camo one charge per life (fix 4)', () => {
  it('activates once per life; a second press during the same life does nothing', () => {
    const sim = new MatchSim('gutter', 30)
    const a = sim.addPlayer('a', 'A', 0, false)
    a.equipment = 'camo'
    a.equipmentCharges = 1
    a.equipmentCooldownUntil = 0

    let now = TICK_DT
    sim.setInput('a', makeInput({ yaw: a.yaw, equipment: true }))
    sim.tick(now)
    expect(a.camoUntil).toBeGreaterThan(now)
    expect(a.equipmentCharges).toBe(0)
    const firstCamoUntil = a.camoUntil

    // Second press right away: charges are exhausted, so nothing changes.
    now += TICK_DT
    sim.setInput('a', makeInput({ yaw: a.yaw, equipment: true }))
    sim.tick(now)
    expect(a.camoUntil).toBe(firstCamoUntil)
    expect(a.equipmentCharges).toBe(0)
  })
})

describe('MatchSim: camo breaks on shooting (fix 5)', () => {
  it("firing a weapon while camo'd zeroes camoUntil; staying quiet keeps camo", () => {
    const sim = new MatchSim('gutter', 31)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.weapons = ['pulse_smg', 'pulse_smg']
    a.ammo = [30, 30]
    a.activeWeapon = 0
    b.pos = { x: 1000, y: 0, z: 1000 }

    let now = TICK_DT
    a.camoUntil = now + CAMO_DURATION

    sim.setInput('a', makeInput({ yaw: a.yaw, fire: true }))
    sim.tick(now)
    expect(a.camoUntil).toBe(0)

    // A camo'd player who does NOT fire keeps camo.
    const sim2 = new MatchSim('gutter', 32)
    const c = sim2.addPlayer('c', 'C', 0, false)
    now = TICK_DT
    c.camoUntil = now + CAMO_DURATION
    sim2.setInput('c', makeInput({ yaw: c.yaw }))
    sim2.tick(now)
    expect(c.camoUntil).toBe(now + CAMO_DURATION)
  })
})
