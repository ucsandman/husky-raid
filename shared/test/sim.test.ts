import { describe, it, expect } from 'vitest'
import { MatchSim, type SimEvent } from '../src/sim'
import { mulberry32 } from '../src/rng'
import { rollLoadout, WEAPONS } from '../src/weapons'
import { toSnapPlayer } from '../src/protocol'
import { MAPS } from '../src/maps'
import type { WeaponId } from '../src/types'
import {
  TICK_DT,
  RESPAWN_DELAY,
  FLAG_RETURN_TIME,
  CAPTURES_TO_WIN,
  MAX_SHIELD,
  MAX_HEALTH,
  CAMO_DURATION,
  MELEE_LUNGE_SPEED,
  RELOAD_TIME,
  SWAP_COOLDOWN,
  WARMUP_SEC,
  MATCH_TIME,
  EYE_HEIGHT,
  PLAYER_BODY_CENTER_Y,
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

describe('MatchSim: deathY safety net (not reachable by normal play)', () => {
  it('a player who ends up below the map still scores a death but no kill credit', () => {
    const sim = new MatchSim('gutter', 5)
    const a = sim.addPlayer('a', 'A', 0, false)
    sim.addPlayer('b', 'B', 1, false)

    // The gutter's floor is one continuous surface now -- there is no
    // in-bounds position a player can walk, strafe, or get launched into
    // that falls through it (x=-3.5, the old death-pit gap, is solid floor
    // -- see gutter.ts and physics.test.ts's 'former gutter gap' test).
    // This simulates the one case deathY still exists for: a player who
    // somehow ends up below the map entirely, which must still resolve to
    // a self-kill with no credit, not a stuck or frozen player.
    a.pos = { x: 0, y: MAPS.gutter.deathY - 5, z: 0 }
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
    expect((fellEvent as { head: boolean }).head).toBe(false)
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

describe('MatchSim: an empty magazine reads as empty', () => {
  it('holds ammo at 0 for the whole reload lockout and refills when it ends', () => {
    const sim = new MatchSim('gutter', 10)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.weapons = ['sidearm', 'sidearm'] // rof 4, magSize 12
    a.ammo = [1, 12]
    a.activeWeapon = 0
    b.pos = { x: 1000, y: 0, z: 1000 } // out of range so no stray hits

    // The shot that empties the mag still fires...
    sim.setInput('a', makeInput({ yaw: a.yaw, fire: true }))
    let now = TICK_DT
    let events = sim.tick(now)
    expect(events.some((e) => e.type === 'shot' && e.playerId === 'a')).toBe(true)
    // ...and leaves the magazine visibly empty, rather than showing a full mag
    // on a weapon that will refuse to fire for the next RELOAD_TIME seconds.
    expect(a.ammo[0]).toBe(0)
    expect(a.cooldownUntil).toBeCloseTo(now + RELOAD_TIME, 5)

    // Still empty and still locked out partway through the reload.
    now += RELOAD_TIME / 2
    sim.setInput('a', makeInput({ yaw: a.yaw, fire: true }))
    events = sim.tick(now)
    expect(events.some((e) => e.type === 'shot' && e.playerId === 'a')).toBe(false)
    expect(a.ammo[0]).toBe(0)

    // Once the lockout expires the magazine is back, without needing input.
    now += RELOAD_TIME
    sim.setInput('a', makeInput({ yaw: a.yaw }))
    sim.tick(now)
    expect(a.ammo[0]).toBe(WEAPONS.sidearm.magSize)
  })

  it('leaves melee available during the reload lockout', () => {
    const sim = new MatchSim('gutter', 11)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.weapons = ['sidearm', 'sidearm']
    a.ammo = [1, 12]
    a.activeWeapon = 0
    // Put B in melee range, directly in front of A (yaw 0 faces +z).
    a.pos = { x: 0, y: 0, z: -15 }
    b.pos = { x: 0, y: 0, z: -14 }
    a.yaw = 0

    sim.setInput('a', makeInput({ yaw: 0, fire: true }))
    let now = TICK_DT
    sim.tick(now)
    expect(a.ammo[0]).toBe(0) // dry, and locked out of firing

    // Mid-reload the gun is dead, but a melee must still land -- being unable
    // to do anything at all for RELOAD_TIME is what made an empty mag feel
    // like a broken character rather than a reload.
    const shieldBefore = b.shield
    now += RELOAD_TIME / 2
    sim.setInput('a', makeInput({ yaw: 0, melee: true }))
    sim.tick(now)
    expect(b.shield).toBeLessThan(shieldBefore)
    expect(a.meleeCooldownUntil).toBeGreaterThan(now)
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

    // melee still works (rate-limited via its own meleeCooldownUntil) while carrying
    sim.setInput('a', makeInput({ yaw: a.yaw, melee: true }))
    now += TICK_DT
    sim.tick(now)
    expect(a.meleeCooldownUntil).toBeGreaterThan(now)

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

describe('MatchSim: swapping weapons drops the outgoing gun\'s lockout', () => {
  it('lets the incoming weapon fire on the swap cooldown alone, not the outgoing rof', () => {
    // Regression: cooldownUntil is a single per-player field shared by both
    // slots, so swapping used to inherit the weapon you just put away. Fire a
    // railspike (rof 0.75 -> 1.33s lockout), swap to a sidearm, and the
    // sidearm must be live SWAP_COOLDOWN later, deep inside that 1.33s.
    const sim = new MatchSim('gutter', 30)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.weapons = ['railspike', 'sidearm']
    a.ammo = [5, 12]
    a.activeWeapon = 0
    b.pos = { x: 1000, y: 0, z: 1000 } // out of range so no stray hits

    sim.setInput('a', makeInput({ yaw: a.yaw, fire: true }))
    let now = TICK_DT
    let events = sim.tick(now)
    expect(events.some((e) => e.type === 'shot' && e.weapon === 'railspike')).toBe(true)
    const railspikeLockout = a.cooldownUntil
    expect(railspikeLockout).toBeGreaterThan(now + SWAP_COOLDOWN)

    sim.setInput('a', makeInput({ yaw: a.yaw, swap: true }))
    now += TICK_DT
    sim.tick(now)
    expect(a.activeWeapon).toBe(1)

    // Idle out the swap cooldown -- still well inside the railspike's lockout.
    sim.setInput('a', makeInput({ yaw: a.yaw }))
    const idle = runTicks(sim, Math.ceil(SWAP_COOLDOWN / TICK_DT) + 1, now)
    now = idle.now
    expect(now).toBeGreaterThan(a.swapCooldownUntil)
    expect(now).toBeLessThan(railspikeLockout)

    sim.setInput('a', makeInput({ yaw: a.yaw, fire: true }))
    now += TICK_DT
    events = sim.tick(now)
    expect(events.some((e) => e.type === 'shot' && e.weapon === 'sidearm')).toBe(true)
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

describe('MatchSim: melee lunge (task 6)', () => {
  it('a grounded melee hit lunges the attacker toward the target, horizontal only', () => {
    const sim = new MatchSim('gutter', 40)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    // Pure flat center-lane ground (same spot physics.test.ts's 'walks
    // forward on flat ground' uses), clear of the launch pads at x=-1/1,
    // z=0 (radius 1) so this player stays genuinely grounded.
    a.pos = { x: 0, y: 0, z: -15 }
    a.yaw = 0 // forward = +z
    a.vel = { x: 0, y: 0, z: 0 }
    b.pos = { x: 0, y: 0, z: -13.5 } // within MELEE_RANGE (2), dead ahead

    sim.setInput('a', makeInput({ yaw: 0, melee: true }))
    sim.tick(TICK_DT)

    expect(Math.hypot(a.vel.x, a.vel.z)).toBeCloseTo(MELEE_LUNGE_SPEED, 1)
    expect(a.vel.y).toBe(0)
  })
})

describe('MatchSim: kill event head flag (task 7)', () => {
  it('a railspike headshot kill emits head:true', () => {
    const sim = new MatchSim('gutter', 41)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.weapons = ['railspike', 'railspike']
    a.ammo = [5, 5]
    a.activeWeapon = 0
    // Both at pos.y=0: eye height (1.6) sits just above the body sphere's
    // top (0.9+0.58=1.48) but inside the head sphere (1.55 +/- 0.3), so a
    // flat (pitch=0) shot is a clean headshot by construction.
    a.pos = { x: 0, y: 0, z: -20 }
    a.yaw = 0
    a.pitch = 0
    b.pos = { x: 0, y: 0, z: -15 }
    // Shield stripped first, same as the body-shot sibling below. Since
    // headshots became shield-gated, a headshot into a full shield does
    // 70 (not 140) and no longer kills -- so a full-shield target would
    // emit no kill event at all and this test would be asserting the
    // one-tap, not the head flag it is named for.
    b.shield = 0

    sim.setInput('a', makeInput({ yaw: 0, pitch: 0, fire: true }))
    const events = sim.tick(TICK_DT)
    const kill = events.find((e) => e.type === 'kill' && e.victimId === 'b')
    expect(kill).toBeDefined()
    expect((kill as { head: boolean }).head).toBe(true)
  })

  it('a railspike body-shot kill emits head:false', () => {
    const sim = new MatchSim('gutter', 42)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.weapons = ['railspike', 'railspike']
    a.ammo = [5, 5]
    a.activeWeapon = 0
    a.pos = { x: 0, y: 0, z: -20 }
    a.yaw = 0
    // Pitch aimed at the body sphere's center (0, 0.9, -15) from the eye
    // (0, 1.6, -20): dy=-0.7 over dz=5, well clear of the head sphere.
    a.pitch = Math.atan2(-0.7, 5)
    b.pos = { x: 0, y: 0, z: -15 }
    b.shield = 0
    b.health = 1 // one more railspike body hit (70) overkills -> a kill, not just a shield_break

    sim.setInput('a', makeInput({ yaw: 0, pitch: a.pitch, fire: true }))
    const events = sim.tick(TICK_DT)
    const kill = events.find((e) => e.type === 'kill' && e.victimId === 'b')
    expect(kill).toBeDefined()
    expect((kill as { head: boolean }).head).toBe(false)
  })
})

describe('Halo pass 2: per-life kill streak on the kill event', () => {
  it('counts up per kill and resets when the killer themselves dies', () => {
    const sim = new MatchSim('gutter', 801)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    const events: SimEvent[] = []

    sim.killPlayer(b, 1, 'a', 'test', { ...b.pos }, events)
    b.alive = true
    sim.killPlayer(b, 2, 'a', 'test', { ...b.pos }, events)

    expect(events[0].type === 'kill' && events[0].streak).toBe(1)
    expect(events[1].type === 'kill' && events[1].streak).toBe(2)

    // a dies, so a's spree is over.
    sim.killPlayer(a, 3, 'b', 'test', { ...a.pos }, events)
    a.alive = true
    b.alive = true
    sim.killPlayer(b, 4, 'a', 'test', { ...b.pos }, events)

    expect(events[3].type === 'kill' && events[3].streak).toBe(1)
  })

  it('does not credit a spree for a self-kill', () => {
    const sim = new MatchSim('gutter', 802)
    const a = sim.addPlayer('a', 'A', 0, false)
    const events: SimEvent[] = []

    sim.killPlayer(a, 1, null, 'fall', { ...a.pos }, events)

    expect(events[0].type === 'kill' && events[0].streak).toBe(0)
  })
})

describe('MatchSim: warmup', () => {
  it('holds combat inert for the countdown, then opens the match with match_go', () => {
    const sim = new MatchSim('gutter', 40)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    sim.beginWarmup(WARMUP_SEC)
    expect(sim.phase).toBe('warmup')
    expect(sim.timeLeft).toBe(WARMUP_SEC)

    a.weapons = ['sidearm', 'sidearm']
    a.ammo = [12, 12]
    a.activeWeapon = 0
    a.grenades = { frag: 2, mag: 0 }
    a.pos = { x: 0, y: 0, z: -15 }
    a.yaw = 0
    b.pos = { x: 0, y: 0, z: -13.5 } // inside A's melee cone and hitscan line

    const startZ = a.pos.z
    sim.setInput('a', makeInput({ yaw: 0, forward: 1, jump: true, fire: true, grenade: true }))
    let now = TICK_DT
    let events = sim.tick(now)

    // Running and jumping are live during warmup...
    expect(a.pos.z).toBeGreaterThan(startZ)
    expect(a.vel.y).toBeGreaterThan(0)
    // ...and nothing that deals damage is.
    expect(events.some((e) => e.type === 'shot')).toBe(false)
    expect(a.ammo[0]).toBe(12)
    expect(a.grenades.frag).toBe(2)
    expect(sim.projectiles).toHaveLength(0)

    sim.setInput('a', makeInput({ yaw: 0, melee: true }))
    now += TICK_DT
    events = sim.tick(now)
    expect(events.some((e) => e.type === 'melee_swing')).toBe(false)
    expect(b.shield).toBe(MAX_SHIELD)

    // Flags cannot be taken either -- no warmup land-grab on the enemy flag.
    a.pos = { ...MAPS.gutter.flagStands[1] }
    sim.setInput('a', makeInput({ yaw: 0 }))
    now += TICK_DT
    events = sim.tick(now)
    expect(events.some((e) => e.type === 'flag_taken')).toBe(false)
    expect(sim.flags[1].state).toBe('stand')
    expect(a.carryingFlag).toBe(null)

    // timeLeft carries the warmup remainder, so the HUD counts 3-2-1 off the
    // one timer field it already reads.
    expect(sim.timeLeft).toBeCloseTo(WARMUP_SEC - 3 * TICK_DT, 5)

    // Run the countdown out: exactly one match_go, then the real match clock.
    a.pos = { x: 0, y: 0, z: -15 }
    const rest = runTicks(sim, Math.ceil(WARMUP_SEC / TICK_DT) + 2, now)
    expect(rest.events.filter((e) => e.type === 'match_go')).toHaveLength(1)
    expect(sim.phase).toBe('playing')
    expect(sim.timeLeft).toBeGreaterThan(MATCH_TIME - 1)

    // Combat is live from here.
    sim.setInput('a', makeInput({ yaw: 0, fire: true }))
    events = sim.tick(rest.now + TICK_DT)
    expect(events.some((e) => e.type === 'shot')).toBe(true)
  })

  it('starts playing immediately when beginWarmup is never called', () => {
    const sim = new MatchSim('gutter', 41)
    expect(sim.phase).toBe('playing')
    expect(sim.timeLeft).toBe(MATCH_TIME)
    const events = sim.tick(TICK_DT)
    expect(events.some((e) => e.type === 'match_go')).toBe(false)
  })
})

describe('MatchSim: respawn protection', () => {
  it('absorbs damage after a respawn, flags prot on the wire, and drops on the first shot', () => {
    const sim = new MatchSim('gutter', 42)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    b.pos = { x: 1000, y: 0, z: 1000 } // out of range so no stray hits

    // The initial spawn happens before anyone can shoot, so it needs none.
    expect(toSnapPlayer(a, 0).prot).toBeUndefined()

    sim.damage('a', 1000)
    expect(a.alive).toBe(false)

    const { now } = runTicks(sim, Math.ceil(RESPAWN_DELAY / TICK_DT) + 1, 0)
    expect(a.alive).toBe(true)
    expect(a.spawnProtectedUntil).toBeGreaterThan(now)
    expect(toSnapPlayer(a, now).prot).toBe(true)

    // Damage bounces off for the whole window.
    sim.damage('a', 1000)
    expect(a.alive).toBe(true)
    expect(a.shield).toBe(MAX_SHIELD)
    expect(a.health).toBe(MAX_HEALTH)

    // Firing gives the protection up -- it is a head start, not a bunker.
    a.weapons = ['sidearm', 'sidearm']
    a.ammo = [12, 12]
    a.activeWeapon = 0
    a.cooldownUntil = 0
    sim.setInput('a', makeInput({ yaw: a.yaw, fire: true }))
    const shotNow = now + TICK_DT
    const events = sim.tick(shotNow)
    expect(events.some((e) => e.type === 'shot' && e.playerId === 'a')).toBe(true)
    expect(a.spawnProtectedUntil).toBe(0)
    expect(toSnapPlayer(a, shotNow).prot).toBeUndefined()

    sim.damage('a', 10)
    expect(a.shield).toBeLessThan(MAX_SHIELD)
  })
})

describe('MatchSim: power weapon pads', () => {
  const pad = { pos: { x: 0, y: 0, z: -15 }, weapon: 'boomtube' as WeaponId, respawnSec: 30 }

  /** A sim whose map carries one pad. Copies the map rather than mutating the
   * shared MAPS entry every other test reads. */
  function simWithPad(seed: number) {
    const sim = new MatchSim('gutter', seed)
    sim.map = { ...sim.map, powerPickups: [pad] }
    return sim
  }

  it('replaces the active slot on touch, refills it, and takes the pad down', () => {
    const sim = simWithPad(43)
    const a = sim.addPlayer('a', 'A', 0, false)
    a.weapons = ['sidearm', 'pulse_smg']
    a.ammo = [3, 30]
    a.activeWeapon = 0
    a.cooldownUntil = 99 // a live rate-of-fire lockout the pad must clear
    a.pos = { x: 0, y: 0, z: -20 } // 5m off the pad

    sim.setInput('a', makeInput({ yaw: a.yaw }))
    let now = TICK_DT
    sim.tick(now)
    expect(sim.pickupsUp()).toEqual([true])
    expect(a.weapons[0]).toBe('sidearm')

    a.pos = { x: pad.pos.x + 1, y: pad.pos.y, z: pad.pos.z } // 1m < PICKUP_RADIUS
    now += TICK_DT
    let events = sim.tick(now)
    expect(
      events.some((e) => e.type === 'pickup' && e.playerId === 'a' && e.weapon === 'boomtube')
    ).toBe(true)
    expect(a.weapons).toEqual(['boomtube', 'pulse_smg'])
    expect(a.ammo[0]).toBe(WEAPONS.boomtube.magSize)
    expect(a.cooldownUntil).toBe(0)
    expect(sim.pickupsUp()).toEqual([false])

    // Standing on a downed pad gives nothing until it respawns.
    now += TICK_DT
    events = sim.tick(now)
    expect(events.some((e) => e.type === 'pickup')).toBe(false)
  })

  it('walks past a pad holding a weapon it already carries in either slot', () => {
    const sim = simWithPad(44)
    const a = sim.addPlayer('a', 'A', 0, false)
    a.weapons = ['sidearm', 'boomtube']
    a.ammo = [3, 1]
    a.activeWeapon = 0
    a.pos = { ...pad.pos }

    sim.setInput('a', makeInput({ yaw: a.yaw }))
    const events = sim.tick(TICK_DT)
    expect(events.some((e) => e.type === 'pickup')).toBe(false)
    expect(a.weapons).toEqual(['sidearm', 'boomtube'])
    expect(sim.pickupsUp()).toEqual([true]) // pad never consumed
  })

  it('is inert during warmup', () => {
    const sim = simWithPad(45)
    const a = sim.addPlayer('a', 'A', 0, false)
    sim.beginWarmup(WARMUP_SEC)
    a.weapons = ['sidearm', 'pulse_smg']
    a.pos = { ...pad.pos }

    sim.setInput('a', makeInput({ yaw: a.yaw }))
    const events = sim.tick(TICK_DT)
    expect(events.some((e) => e.type === 'pickup')).toBe(false)
    expect(sim.pickupsUp()).toEqual([true])
  })
})

describe('MatchSim: melee swings are never silent', () => {
  it('emits melee_swing for a bash and for a power melee, but not for a cooled-down press', () => {
    const sim = new MatchSim('gutter', 46)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    a.pos = { x: 0, y: 0, z: -15 }
    a.yaw = 0
    b.pos = { x: 1000, y: 0, z: 1000 } // nothing in range: a whiff is still heard

    sim.setInput('a', makeInput({ yaw: 0, melee: true }))
    let now = TICK_DT
    let events = sim.tick(now)
    expect(events.filter((e) => e.type === 'melee_swing')).toEqual([
      { type: 'melee_swing', playerId: 'a', weapon: null },
    ])

    // Held through the melee cooldown, the blocked press emits nothing.
    now += TICK_DT
    events = sim.tick(now)
    expect(events.some((e) => e.type === 'melee_swing')).toBe(false)

    // Power melee emits BOTH the swing (carrying the weapon id, which is how
    // the client knows to suppress the tracer) and the usual shot event.
    a.weapons = ['arc_blade', 'sidearm']
    a.ammo = [1, 12]
    a.activeWeapon = 0
    a.cooldownUntil = 0
    sim.setInput('a', makeInput({ yaw: 0, fire: true }))
    now += TICK_DT
    events = sim.tick(now)
    expect(events.some((e) => e.type === 'melee_swing' && e.weapon === 'arc_blade')).toBe(true)
    expect(events.some((e) => e.type === 'shot' && e.weapon === 'arc_blade')).toBe(true)
  })
})

describe('MatchSim: shot events carry the impact point', () => {
  it('sets hit to the first ray impact when it connects and omits it on a clean miss', () => {
    const sim = new MatchSim('gutter', 47)
    const a = sim.addPlayer('a', 'A', 0, false)
    const b = sim.addPlayer('b', 'B', 1, false)
    // Strip the geometry so the only thing the ray can reach is B.
    sim.map = { ...sim.map, boxes: [] }
    a.weapons = ['railspike', 'railspike'] // one pellet, spread 0.004
    a.ammo = [5, 5]
    a.activeWeapon = 0
    a.pos = { x: 0, y: 0, z: -15 }
    a.yaw = 0
    a.pitch = 0
    // B's body sphere sits on A's boresight 6m ahead (eye height cancels).
    b.pos = { x: 0, y: EYE_HEIGHT - PLAYER_BODY_CENTER_Y, z: -9 }

    sim.setInput('a', makeInput({ yaw: 0, fire: true }))
    let events = sim.tick(TICK_DT)
    const shot = events.find((e): e is Extract<SimEvent, { type: 'shot' }> => e.type === 'shot')
    expect(shot).toBeDefined()
    expect(shot!.hit).toBeDefined()
    // Impact on the near face of B's body sphere, not at B's center.
    expect(shot!.hit!.z).toBeGreaterThan(-10)
    expect(shot!.hit!.z).toBeLessThan(-9)
    expect(Math.abs(shot!.hit!.x)).toBeLessThan(0.2)

    // A ray that reaches nothing leaves hit off entirely.
    b.pos = { x: 1000, y: 0, z: 1000 }
    a.cooldownUntil = 0
    sim.setInput('a', makeInput({ yaw: 0, fire: true }))
    events = sim.tick(2 * TICK_DT)
    const miss = events.find((e): e is Extract<SimEvent, { type: 'shot' }> => e.type === 'shot')
    expect(miss).toBeDefined()
    expect(miss!.hit).toBeUndefined()
  })
})
