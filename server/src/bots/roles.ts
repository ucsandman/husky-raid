import type { MatchSim, PlayerState, Vec3 } from '@riftlane/shared'
import { distSq } from '@riftlane/shared'

export type Role = 'runner' | 'escort' | 'hunter' | 'defender'

function nearestTo(pool: PlayerState[], pos: Vec3): PlayerState | undefined {
  let best: PlayerState | undefined
  let bestDistSq = Infinity
  for (const p of pool) {
    const d = distSq(p.pos, pos)
    if (d < bestDistSq) {
      bestDistSq = d
      best = p
    }
  }
  return best
}

/**
 * Assigns each bot on `team` a Role for this scoring pass. Caller re-runs
 * this every 2s and on flag events (flag_taken/flag_dropped/flag_returned) --
 * that scheduling lives in the caller (match.ts), not here.
 *
 * hunter exists iff the enemy is currently carrying our flag (assigned to
 * whichever teammate is nearest the enemy carrier). escort exists iff we
 * are currently carrying the enemy flag (assigned to whichever teammate is
 * nearest our own carrier). Both consume a player from the pool before the
 * remaining players are scored for runner/defender, so with the standard
 * 4-player team, hunter+escort (up to 2 slots) still leaves >=2 players to
 * cover the always-on runner/defender minimum.
 *
 * Remaining players are scored by "runner lean" = distSq(to own flag) -
 * distSq(to enemy flag): positive means closer to the enemy flag (runner
 * territory), negative means closer to home (defender territory). The most
 * runner-leaning player becomes runner, the most defender-leaning becomes
 * defender (guaranteeing >=1 of each whenever >=2 players remain), and any
 * players in between are assigned by the sign of their own lean.
 */
export function assignRoles(team: PlayerState[], sim: MatchSim): Map<string, Role> {
  const roles = new Map<string, Role>()
  if (team.length === 0) return roles

  const ourTeam = team[0].team
  const enemyTeam = ourTeam === 0 ? 1 : 0
  const ourFlag = sim.flags[ourTeam]
  const enemyFlag = sim.flags[enemyTeam]

  let pool = team

  if (ourFlag.state === 'carried' && ourFlag.carrierId) {
    const carrier = sim.players.get(ourFlag.carrierId)
    if (carrier) {
      const hunter = nearestTo(pool, carrier.pos)
      if (hunter) {
        roles.set(hunter.id, 'hunter')
        pool = pool.filter((p) => p.id !== hunter.id)
      }
    }
  }

  if (enemyFlag.state === 'carried' && enemyFlag.carrierId) {
    const carrier = sim.players.get(enemyFlag.carrierId)
    if (carrier) {
      const escort = nearestTo(pool, carrier.pos)
      if (escort) {
        roles.set(escort.id, 'escort')
        pool = pool.filter((p) => p.id !== escort.id)
      }
    }
  }

  if (pool.length === 0) return roles

  // "Lean" only decides WHICH remaining bots go on offense vs defense, not
  // how many of each -- at spawn every bot sits right on top of its own
  // flag, so a pure distance-lean split would starve offense down to a
  // single runner against a full defensive wall. Splitting the (sorted)
  // pool in half keeps the invariant (>=1 of each whenever pool.length>=2)
  // while staying balanced enough to actually contest the enemy flag.
  const scored = pool
    .map((p) => ({ p, runnerLean: distSq(p.pos, ourFlag.pos) - distSq(p.pos, enemyFlag.pos) }))
    .sort((a, b) => b.runnerLean - a.runnerLean)

  const n = scored.length
  // n=1: ruled a runner, not a defender -- offense biases toward captures,
  // and a solo bot patrolling an empty base helps nobody. n>=2: explicit
  // min() clamp (rather than relying on ceil(n/2) staying < n, which it
  // always does, but not obviously so on a read) guarantees >=1 defender
  // even if this formula changes later.
  const numRunners = n === 1 ? 1 : Math.min(Math.ceil(n / 2), n - 1)
  scored.forEach(({ p }, i) => roles.set(p.id, i < numRunners ? 'runner' : 'defender'))

  return roles
}
