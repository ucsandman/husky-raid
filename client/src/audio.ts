import type { Vec3 } from '@riftlane/shared'

/**
 * Every sound RIFTLANE plays, synthesized (oscillators/noise + hand-rolled
 * envelopes/filters), never loaded from a file. See synth() below for the
 * one-line recipe behind each name.
 */
export type SoundName =
  | 'shot_smg'
  | 'shot_rifle'
  | 'shot_rail'
  | 'shot_boom'
  | 'explosion'
  | 'shield_hit'
  | 'shield_break'
  | 'melee_swing'
  | 'blade_lunge'
  | 'death'
  | 'capture'
  | 'flag_taken'
  | 'teleport'
  | 'launchpad'
  | 'ui_click'

export const ALL_SOUND_NAMES: readonly SoundName[] = [
  'shot_smg',
  'shot_rifle',
  'shot_rail',
  'shot_boom',
  'explosion',
  'shield_hit',
  'shield_break',
  'melee_swing',
  'blade_lunge',
  'death',
  'capture',
  'flag_taken',
  'teleport',
  'launchpad',
  'ui_click',
]

export interface PlayOpts {
  /** World-space source position. Omit for a non-positional (UI/global) sound. */
  pos?: Vec3
  /** Local player's ear: pos + yaw. Required alongside `pos` for panning/falloff. */
  listener?: { pos: Vec3; yaw: number }
}

/** Beyond this distance a positional sound is inaudible and skipped entirely. */
const MAX_DISTANCE = 40

/**
 * Owns the WebAudio graph and every precomputed sound buffer for one match
 * (or the whole client session -- it's safe to reuse across rematches, see
 * dispose() below). init() must run inside a user-gesture handler; browsers
 * refuse to start an AudioContext otherwise. Everything else (play(),
 * setVolume(), dispose()) is a no-op until init() has actually run.
 *
 * SANCTIONED Math.random: the rest of this codebase uses the seeded
 * mulberry32 RNG (shared/src/rng.ts) so simulation stays deterministic and
 * replayable. Audio is client-only cosmetic and never touches sim state, so
 * this file is the one place Math.random is allowed -- for noise-texture
 * synthesis (shot_smg/explosion/shield_break/melee_swing/launchpad/ui_click)
 * and for per-play pitch jitter (+/-5%, see play() below) so repeated
 * gunfire doesn't phase together into one flat drone.
 */
class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private readonly buffers = new Map<SoundName, AudioBuffer>()
  private volume = 1

  /** Idempotent: safe to call from every click handler that might be the
   * first user gesture. Resumes an already-suspended context (e.g. after
   * dispose()) instead of rebuilding the 15 precomputed buffers. */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }

    const ctx = new AudioContext()
    this.ctx = ctx

    const master = ctx.createGain()
    master.gain.value = this.volume
    const compressor = ctx.createDynamicsCompressor() // soft-limits 8 players firing at once
    master.connect(compressor)
    compressor.connect(ctx.destination)
    this.master = master

    for (const name of ALL_SOUND_NAMES) this.buffers.set(name, synth(ctx, name))
  }

  /** Wired to settings.volume (state.ts, persisted to localStorage). */
  setVolume(v: number): void {
    this.volume = v
    if (this.master) this.master.gain.value = v
  }

  play(name: SoundName, opts?: PlayOpts): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    if (ctx.state === 'suspended') void ctx.resume()
    const buffer = this.buffers.get(name)
    if (!buffer) return

    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * 0.05

    let gain: GainNode | undefined
    let panner: StereoPannerNode | undefined

    if (opts?.pos && opts.listener) {
      const { pos, listener } = opts
      const dx = pos.x - listener.pos.x
      const dz = pos.z - listener.pos.z
      const dist = Math.hypot(dx, dz, pos.y - listener.pos.y)
      if (dist > MAX_DISTANCE) return

      gain = ctx.createGain()
      gain.gain.value = Math.max(0, 1 - dist / MAX_DISTANCE)
      panner = ctx.createStereoPanner()
      const horizDist = Math.hypot(dx, dz)
      // physics.ts's rightVec (forward x up, right-handed, up=+y) for
      // yaw psi is (-cos psi, 0, sin psi) -- NOT forward rotated -90 (that
      // was wrong; forward rotated -90 is +cos psi, -sin psi, the mirror
      // image, which inverted every pan). Project the listener-relative
      // offset (dx, dz) onto that exact vector: pan = dot((dx,dz),
      // (-cos psi, sin psi)) / horizDist.
      // Sanity check: yaw=0 (facing +z), source at dx=+5, dz=0 ->
      // pan = (5*-1 + 0*0) / 5 = -1 = hard left. Correct: facing +z with
      // up=+y, +x is to your left (right-handed frame puts "right" at -x).
      panner.pan.value =
        horizDist > 0.001
          ? clamp((dx * -Math.cos(listener.yaw) + dz * Math.sin(listener.yaw)) / horizDist, -1, 1)
          : 0

      src.connect(gain)
      gain.connect(panner)
      panner.connect(master)
    } else {
      src.connect(master)
    }

    // Explicit lifecycle: disconnect every node this play() created the
    // moment playback finishes, instead of relying on the spec's implicit
    // "an unreachable, silent AudioNode is eventually GC'd" behavior --
    // cheap, and it means a leak here is a bug, not just delayed GC.
    src.onended = () => {
      src.disconnect()
      gain?.disconnect()
      panner?.disconnect()
    }

    src.start()
  }

  /** Suspends the context (does NOT close it) -- reuse across matches is
   * intentional, so a rematch doesn't need to resynthesize all 15 buffers.
   * play()/init() both resume a suspended context on their own. */
  dispose(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend()
  }
}

export const audioEngine = new AudioEngine()

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// ---- synthesis --------------------------------------------------------------

function makeBuffer(
  ctx: AudioContext,
  seconds: number,
  fill: (data: Float32Array, sampleRate: number) => void
): AudioBuffer {
  const sampleRate = ctx.sampleRate
  const length = Math.max(1, Math.round(seconds * sampleRate))
  const buffer = ctx.createBuffer(1, length, sampleRate)
  const data = buffer.getChannelData(0)
  fill(data, sampleRate)
  return buffer
}

function noise(n: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.random() * 2 - 1
  return out
}

/** One-pole lowpass, in place. `cutoffAt(t)` lets the cutoff sweep over the
 * buffer's duration (explosion boom, launchpad whoosh). */
function applyLowpass(data: Float32Array, sampleRate: number, cutoffAt: (t: number) => number): void {
  let y = 0
  for (let i = 0; i < data.length; i++) {
    const fc = Math.max(20, cutoffAt(i / sampleRate))
    const alpha = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate)
    y += alpha * (data[i] - y)
    data[i] = y
  }
}

/** One-pole highpass, in place -- paired with applyLowpass for a crude
 * bandpass (shield_break's "glassy" mid-high noise). */
function applyHighpass(data: Float32Array, sampleRate: number, cutoffHz: number): void {
  const rc = 1 / (2 * Math.PI * cutoffHz)
  const dt = 1 / sampleRate
  const alpha = rc / (rc + dt)
  let prevIn = 0
  let prevOut = 0
  for (let i = 0; i < data.length; i++) {
    const out = alpha * (prevOut + data[i] - prevIn)
    prevIn = data[i]
    prevOut = out
    data[i] = out
  }
}

/**
 * Builds one sound's AudioBuffer. Each case is a one-line recipe (see the
 * comment on it) -- exhaustive switch over SoundName so a new sound name
 * added to the union without a case here is a compile error, not a silent
 * missing buffer.
 */
function synth(ctx: AudioContext, name: SoundName): AudioBuffer {
  switch (name) {
    // Short lowpassed noise burst, ~45ms exponential decay.
    case 'shot_smg':
      return makeBuffer(ctx, 0.07, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, () => 4000)
        for (let i = 0; i < data.length; i++) data[i] = n[i] * Math.exp(-(i / sr) * 40)
      })

    // 700Hz square wave, ~55ms decay.
    case 'shot_rifle':
      return makeBuffer(ctx, 0.06, (data, sr) => {
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const sq = ((700 * t) % 1) < 0.5 ? 1 : -1
          data[i] = sq * Math.exp(-t * 55) * 0.9
        }
      })

    // Sine chirp 1200Hz->300Hz over 130ms, plus a 15ms noise "crack" at onset.
    case 'shot_rail':
      return makeBuffer(ctx, 0.16, (data, sr) => {
        let phase = 0
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const freq = 1200 - (1200 - 300) * Math.min(1, t / 0.13)
          phase += freq / sr
          const sine = Math.sin(2 * Math.PI * phase)
          const crack = t < 0.015 ? (Math.random() * 2 - 1) * (1 - t / 0.015) : 0
          data[i] = sine * Math.exp(-t * 14) * 0.6 + crack * 0.8
        }
      })

    // Low sine 90Hz->50Hz thump, fast attack, ~150ms decay.
    case 'shot_boom':
      return makeBuffer(ctx, 0.18, (data, sr) => {
        let phase = 0
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const freq = 90 - (90 - 50) * Math.min(1, t / 0.15)
          phase += freq / sr
          data[i] = Math.sin(2 * Math.PI * phase) * Math.exp(-t * 10) * Math.min(1, t / 0.005)
        }
      })

    // Noise lowpass-swept 2200Hz->150Hz over 500ms -- the classic "boom" filter sweep.
    case 'explosion':
      return makeBuffer(ctx, 0.55, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, (t) => 2200 - (2200 - 150) * Math.min(1, t / 0.5))
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          data[i] = n[i] * Math.exp(-t * 4.2) * Math.min(1, t / 0.01)
        }
      })

    // Two-partial high sine ping (1800Hz + 2600Hz), ~90ms decay.
    case 'shield_hit':
      return makeBuffer(ctx, 0.09, (data, sr) => {
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const env = Math.exp(-t * 45)
          data[i] = (Math.sin(2 * Math.PI * 1800 * t) * 0.7 + Math.sin(2 * Math.PI * 2600 * t) * 0.3) * env
        }
      })

    // Bandpassed noise (900Hz-3200Hz) + two high sine "sparkle" partials, ~180ms decay.
    case 'shield_break':
      return makeBuffer(ctx, 0.18, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, () => 3200)
        applyHighpass(n, sr, 900)
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const env = Math.exp(-t * 22)
          const sparkle = Math.sin(2 * Math.PI * 3100 * t) * 0.25 + Math.sin(2 * Math.PI * 4200 * t) * 0.2
          data[i] = (n[i] * 0.8 + sparkle) * env
        }
      })

    // Noise swept 600Hz<->1800Hz with a rise/fall amplitude envelope -- a "whoosh".
    case 'melee_swing':
      return makeBuffer(ctx, 0.2, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, (t) => 600 + 1200 * Math.sin(Math.PI * Math.min(1, t / 0.2)))
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          data[i] = n[i] * Math.sin(Math.PI * Math.min(1, t / 0.2)) * 0.9
        }
      })

    // Rising sawtooth chirp 200Hz->900Hz over 180ms.
    case 'blade_lunge':
      return makeBuffer(ctx, 0.18, (data, sr) => {
        let phase = 0
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const freq = 200 + (900 - 200) * Math.min(1, t / 0.18)
          phase += freq / sr
          const saw = 2 * (phase % 1) - 1
          data[i] = saw * Math.min(1, t / 0.02) * Math.exp(-Math.max(0, t - 0.1) * 15) * 0.7
        }
      })

    // Descending sine 400Hz->80Hz over 500ms, quiet.
    case 'death':
      return makeBuffer(ctx, 0.5, (data, sr) => {
        let phase = 0
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const freq = 400 - (400 - 80) * Math.min(1, t / 0.45)
          phase += freq / sr
          data[i] = Math.sin(2 * Math.PI * phase) * Math.exp(-t * 3) * 0.6
        }
      })

    // 3-note ascending sine arpeggio (C5-E5-G5), each ~110ms.
    case 'capture':
      return makeArpeggio(ctx, [523.25, 659.25, 783.99], 0.11, 0.02, 'sine')

    // 2-note alternating square "alarm" (A5-E5), each ~90ms.
    case 'flag_taken':
      return makeArpeggio(ctx, [880, 659.25], 0.09, 0.03, 'square')

    // Sine carrier FM-warbled by a 22Hz LFO over 300ms.
    case 'teleport':
      return makeBuffer(ctx, 0.3, (data, sr) => {
        let phase = 0
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const freq = 500 + Math.sin(2 * Math.PI * 22 * t) * 220
          phase += freq / sr
          data[i] = Math.sin(2 * Math.PI * phase) * Math.sin(Math.PI * Math.min(1, t / 0.3)) * 0.7
        }
      })

    // Noise lowpass-swept 300Hz->2800Hz (rising, opposite of melee_swing) over 250ms.
    case 'launchpad':
      return makeBuffer(ctx, 0.25, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, (t) => 300 + 2500 * Math.min(1, t / 0.25))
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          data[i] = n[i] * Math.min(1, t / 0.05) * (1 - Math.min(1, t / 0.25)) * 0.8
        }
      })

    // Tiny lowpassed noise tick, ~15ms.
    case 'ui_click':
      return makeBuffer(ctx, 0.02, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, () => 6000)
        for (let i = 0; i < data.length; i++) data[i] = n[i] * Math.exp(-(i / sr) * 260) * 0.5
      })

    default: {
      const exhaustive: never = name
      throw new Error(`audio: no synth recipe for ${String(exhaustive)}`)
    }
  }
}

/** Shared by capture/flag_taken: N short notes back to back, each with a
 * fast-attack exponential-decay envelope. */
function makeArpeggio(
  ctx: AudioContext,
  freqs: number[],
  noteDur: number,
  gap: number,
  wave: 'sine' | 'square'
): AudioBuffer {
  const step = noteDur + gap
  return makeBuffer(ctx, freqs.length * step, (data, sr) => {
    freqs.forEach((freq, idx) => {
      const startI = Math.round(idx * step * sr)
      const len = Math.round(noteDur * sr)
      for (let i = 0; i < len && startI + i < data.length; i++) {
        const t = i / sr
        const env = Math.exp(-t * (wave === 'sine' ? 10 : 18)) * Math.min(1, t / 0.005)
        const s = wave === 'sine' ? Math.sin(2 * Math.PI * freq * t) : Math.sign(Math.sin(2 * Math.PI * freq * t))
        data[startI + i] += s * env * (wave === 'sine' ? 0.8 : 0.5)
      }
    })
  })
}
