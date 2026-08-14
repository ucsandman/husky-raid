/**
 * mulberry32: small, fast, deterministic PRNG. Same seed -> same infinite
 * sequence of floats in [0, 1). Used for loadout rolls (rollLoadout) so
 * the whole sim stays reproducible from a single seed (Task 6 determinism
 * requirement) — never call Math.random anywhere in shared/.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function (): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
