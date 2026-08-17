import type { Vec3, WeaponId } from '@riftlane/shared'

/**
 * Every sound RIFTLANE plays, synthesized (oscillators/noise + hand-rolled
 * envelopes/filters). See synth() below for the one-line recipe behind each
 * name.
 *
 * Synthesis is no longer what you hear for weapons: a 700Hz square wave is a
 * beep, not a rifle, and a falling sine chirp is a cartoon laser, not a
 * sniper. Every gun and the explosion now play a generated sample (see
 * WEAPON_SFX / SAMPLE_URLS below) and these recipes are the fallback that
 * covers the first few frames, a 404, or a decode failure.
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
  | 'melee_hit'
  | 'blade_lunge'
  | 'death'
  | 'capture'
  | 'flag_taken'
  | 'teleport'
  | 'launchpad'
  | 'pickup_taken'
  | 'pickup_ready'
  | 'ui_click'
  | 'countdown_tick'
  | 'match_go'
  | 'hit_tick'
  | 'hit_kill'
  | 'headshot'
  | 'damage_taken'
  | 'heartbeat'
  | 'footstep'
  | 'land'
  | 'shield_recharge'
  | 'backsmack'
  | 'flag_dropped'
  | 'flag_returned'
  | 'spree'
  | 'lead_change'

export const ALL_SOUND_NAMES: readonly SoundName[] = [
  'shot_smg',
  'shot_rifle',
  'shot_rail',
  'shot_boom',
  'explosion',
  'shield_hit',
  'shield_break',
  'melee_swing',
  'melee_hit',
  'blade_lunge',
  'death',
  'capture',
  'flag_taken',
  'teleport',
  'launchpad',
  'pickup_taken',
  'pickup_ready',
  'ui_click',
  'countdown_tick',
  'match_go',
  'hit_tick',
  'hit_kill',
  'headshot',
  'damage_taken',
  'heartbeat',
  'footstep',
  'land',
  'shield_recharge',
  'backsmack',
  'flag_dropped',
  'flag_returned',
  'spree',
  'lead_change',
]

/** Background bed: 'menu' behind the main menu, 'match' during a live game,
 * null for silence. See AudioEngine.setAmbient(). */
export type AmbientMode = 'menu' | 'match' | null

export interface PlayOpts {
  /** World-space source position. Omit for a non-positional (UI/global) sound. */
  pos?: Vec3
  /** Local player's ear: pos + yaw. Required alongside `pos` for panning/falloff. */
  listener?: { pos: Vec3; yaw: number }
}

/**
 * Generated one-shot SFX with no synth recipe -- unlike SoundName, this is
 * not an exhaustive switch, because there is nothing to fall back to if the
 * file is missing (see playFileSound()). Kept separate from SoundName so
 * synth() stays exhaustive over the sounds that DO have a synth fallback.
 */
export type FileSoundName = 'match_start_horn' | 'multikill_impact' | 'flag_capture_stinger'

const FILE_SOUND_URLS: Record<FileSoundName, string> = {
  match_start_horn: '/assets/audio/sfx/match_start_horn.mp3',
  multikill_impact: '/assets/audio/sfx/multikill_impact.mp3',
  flag_capture_stinger: '/assets/audio/sfx/flag_capture_stinger.mp3',
}

/**
 * One generated sample per gun, plus the synth recipe that stands in until it
 * loads. Every weapon has its OWN voice now -- the old mapping pushed eleven
 * named Halo guns through four recipes, so the Bulldog, the BR and the
 * Commando were literally the same beep.
 *
 * Mastering (length, level) is baked into the files by
 * scripts/gen-weapon-sfx.sh, which also holds the prompt for each one: the
 * MA40 sample is trimmed to 300ms because it fires every 100ms, and levels
 * are set per weapon there rather than here, since this engine has no
 * per-sound gain.
 */
const WEAPON_SFX: Record<WeaponId, { url: string; fallback: SoundName }> = {
  pulse_smg: { url: '/assets/audio/sfx/weapon_pulse_smg.mp3', fallback: 'shot_smg' },
  sidearm: { url: '/assets/audio/sfx/weapon_sidearm.mp3', fallback: 'shot_smg' },
  triad_rifle: { url: '/assets/audio/sfx/weapon_triad_rifle.mp3', fallback: 'shot_rifle' },
  commando: { url: '/assets/audio/sfx/weapon_commando.mp3', fallback: 'shot_rifle' },
  scattergun: { url: '/assets/audio/sfx/weapon_scattergun.mp3', fallback: 'shot_rifle' },
  swarm_pod: { url: '/assets/audio/sfx/weapon_swarm_pod.mp3', fallback: 'shot_boom' },
  cinderlob: { url: '/assets/audio/sfx/weapon_cinderlob.mp3', fallback: 'shot_boom' },
  railspike: { url: '/assets/audio/sfx/weapon_railspike.mp3', fallback: 'shot_rail' },
  boomtube: { url: '/assets/audio/sfx/weapon_boomtube.mp3', fallback: 'shot_boom' },
  arc_blade: { url: '/assets/audio/sfx/weapon_arc_blade.mp3', fallback: 'blade_lunge' },
  grav_maul: { url: '/assets/audio/sfx/weapon_grav_maul.mp3', fallback: 'melee_swing' },
}

/** Generated samples that REPLACE a synth sound wherever play() is called,
 * with no call-site change. Weapons are not in here -- they route through
 * playWeapon() because they key off WeaponId, not SoundName. */
const SAMPLE_URLS: Partial<Record<SoundName, string>> = {
  explosion: '/assets/audio/sfx/explosion.mp3',
}

/** Beyond this distance a positional sound is inaudible and skipped entirely. */
const MAX_DISTANCE = 40

/** Seconds an ambient bed takes to fade in/out on a setAmbient() switch. */
const AMBIENT_FADE = 1

/** Everything one ambient bed owns, returned by the build*Ambient() methods
 * below. `gain` is this bed's own level (crossfade target) feeding into
 * master; `stopAt(when)` schedules every internal node's native .stop() at
 * an AudioContext time and disconnects the whole bed once the last one
 * actually ends -- no JS timer involved. */
interface AmbientBed {
  gain: GainNode
  targetGain: number
  stopAt: (when: number) => void
}

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

  /** URL-keyed cache for fetched/decoded file assets (VO lines owned by
   * announcer.ts + the FileSoundName SFX above). Absent from both `loaded`
   * and `failed` = never attempted or still in flight. Kept separate from
   * `buffers` (the always-present synth set, sized to ALL_SOUND_NAMES) so a
   * missing or slow-loading file never blocks or replaces the synth
   * fallback -- playUrl() just returns false and the caller keeps using
   * whatever it already had. */
  private readonly urlBuffers = new Map<string, AudioBuffer>()
  private readonly urlFailed = new Set<string>()
  private readonly urlLoading = new Set<string>()

  /** Currently active (or fading-in) ambient bed, if any -- see
   * setAmbient(). Null whenever ambientMode is null or no bed has been
   * built yet (before init()). */
  private ambientMode: AmbientMode = null
  private ambientGain: GainNode | null = null
  private ambientStopAt: ((when: number) => void) | null = null

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

    // Warm the cache for the three generated SFX that have no synth
    // fallback, so they're likely ready by the time a call site actually
    // needs one (match start, a multikill, a flag capture).
    for (const url of Object.values(FILE_SOUND_URLS)) this.loadUrl(url)
    // Same for the weapon samples: ~170KB total, and the first trigger pull
    // usually lands within a second of the gesture that ran init().
    for (const sfx of Object.values(WEAPON_SFX)) this.loadUrl(sfx.url)
    for (const url of Object.values(SAMPLE_URLS)) this.loadUrl(url)
  }

  /** Wired to settings.volume (state.ts, persisted to localStorage). Live:
   * ambient beds connect through master too, so this reaches them without
   * any extra plumbing. */
  setVolume(v: number): void {
    this.volume = v
    if (this.master) this.master.gain.value = v
  }

  /**
   * Switches the background ambient bed. No-op before init() has run (same
   * "everything is a no-op until the user-gesture unlock" rule as
   * play()/setVolume()) and a no-op if `mode` already matches the live bed.
   * Otherwise the old bed (if any) ramps its own gain to 0 over
   * AMBIENT_FADE seconds and has its nodes' native .stop() scheduled for
   * exactly that moment, while the new bed (if any) ramps in from 0 over
   * the same window -- a genuine overlap crossfade, not a fade-out-then-in.
   * setAmbient(null) just runs the fade-out half.
   */
  setAmbient(mode: AmbientMode): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    if (mode === this.ambientMode) return
    this.ambientMode = mode

    const now = ctx.currentTime

    if (this.ambientGain && this.ambientStopAt) {
      const oldGain = this.ambientGain
      oldGain.gain.cancelScheduledValues(now)
      oldGain.gain.setValueAtTime(oldGain.gain.value, now)
      oldGain.gain.linearRampToValueAtTime(0, now + AMBIENT_FADE)
      this.ambientStopAt(now + AMBIENT_FADE)
      this.ambientGain = null
      this.ambientStopAt = null
    }

    if (mode === null) return

    const bed = mode === 'menu' ? this.buildMenuAmbient(ctx) : this.buildMatchAmbient(ctx)
    bed.gain.gain.setValueAtTime(0, now)
    bed.gain.gain.linearRampToValueAtTime(bed.targetGain, now + AMBIENT_FADE)
    bed.gain.connect(master)
    this.ambientGain = bed.gain
    this.ambientStopAt = bed.stopAt
  }

  /** Menu bed: a very quiet slow-moving synth pad, four sine-oscillator
   * triads (Am-F-C-G) crossfading into each other every `chordDur` seconds
   * through a lowpass, so the menu never sits on a static drone. Chord
   * timing is pre-scheduled AudioParam ramps (native WebAudio automation),
   * not a JS interval, for a generous ~53 minutes before it would need
   * re-arming -- far past any real menu session. */
  private buildMenuAmbient(ctx: AudioContext): AmbientBed {
    const gain = ctx.createGain()
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 700
    filter.connect(gain)

    const CHORDS: readonly (readonly number[])[] = [
      [220, 261.63, 329.63], // Am (A3 C4 E4)
      [174.61, 220, 261.63], // F
      [130.81, 164.81, 196], // C
      [196, 246.94, 293.66], // G
    ]
    const chordDur = 4
    const cycle = chordDur * CHORDS.length
    const reps = 200 // ~200 * 16s = ~53 minutes
    const start = ctx.currentTime
    const oscillators: OscillatorNode[] = []

    CHORDS.forEach((chord, ci) => {
      for (const freq of chord) {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = freq
        const og = ctx.createGain()
        og.gain.value = 0
        osc.connect(og)
        og.connect(filter)
        for (let rep = 0; rep < reps; rep++) {
          const t0 = start + rep * cycle + ci * chordDur
          og.gain.linearRampToValueAtTime(0, t0)
          og.gain.linearRampToValueAtTime(0.22, t0 + 1.2)
          og.gain.linearRampToValueAtTime(0.22, t0 + chordDur - 1.2)
          og.gain.linearRampToValueAtTime(0, t0 + chordDur)
        }
        osc.start()
        oscillators.push(osc)
      }
    })

    const stopAt = (when: number) => {
      for (const osc of oscillators) osc.stop(when)
      oscillators[0].onended = () => {
        for (const osc of oscillators) osc.disconnect()
        filter.disconnect()
        gain.disconnect()
      }
    }

    return { gain, targetGain: 0.06, stopAt }
  }

  /** Match bed: filtered brown noise "wind" (a looped buffer -- an actual
   * looped node, not a JS interval) plus a sparse low sine pulse every
   * `pulsePeriod` seconds, pre-scheduled the same bounded way as the menu
   * chords. Near-subliminal: both parts sit well under the SFX layer. */
  private buildMatchAmbient(ctx: AudioContext): AmbientBed {
    const gain = ctx.createGain()

    const windSeconds = 8
    const windBuffer = makeBuffer(ctx, windSeconds, (data, sr) => {
      let last = 0
      for (let i = 0; i < data.length; i++) {
        last = (last + (Math.random() * 2 - 1) * 0.02) / 1.02
        data[i] = last
      }
      let peak = 0
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
      if (peak > 0) for (let i = 0; i < data.length; i++) data[i] /= peak
      applyLowpass(data, sr, () => 450)
    })
    const windSrc = ctx.createBufferSource()
    windSrc.buffer = windBuffer
    windSrc.loop = true
    const windGain = ctx.createGain()
    windGain.gain.value = 0.5
    windSrc.connect(windGain)
    windGain.connect(gain)
    windSrc.start()

    const pulseOsc = ctx.createOscillator()
    pulseOsc.type = 'sine'
    pulseOsc.frequency.value = 55
    const pulseGain = ctx.createGain()
    pulseGain.gain.value = 0
    pulseOsc.connect(pulseGain)
    pulseGain.connect(gain)
    pulseOsc.start()

    const pulsePeriod = 9
    const reps = 220 // ~220 * 9s = ~33 minutes
    const start = ctx.currentTime
    for (let i = 0; i < reps; i++) {
      const t0 = start + i * pulsePeriod
      pulseGain.gain.linearRampToValueAtTime(0, t0)
      pulseGain.gain.linearRampToValueAtTime(0.45, t0 + 1.5)
      pulseGain.gain.linearRampToValueAtTime(0, t0 + 3.5)
    }

    const stopAt = (when: number) => {
      windSrc.stop(when)
      pulseOsc.stop(when)
      windSrc.onended = () => {
        windSrc.disconnect()
        windGain.disconnect()
        pulseOsc.disconnect()
        pulseGain.disconnect()
        gain.disconnect()
      }
    }

    return { gain, targetGain: 0.05, stopAt }
  }

  play(name: SoundName, opts?: PlayOpts): void {
    const url = SAMPLE_URLS[name]
    if (url && this.playUrl(url, opts)) return
    const buffer = this.buffers.get(name)
    if (!buffer) return
    this.playBuffer(buffer, opts)
  }

  /** Fires `weapon`'s generated sample, dropping to its synth recipe while
   * the file is still loading (or forever, if it never loads). */
  playWeapon(weapon: WeaponId, opts?: PlayOpts): void {
    const sfx = WEAPON_SFX[weapon]
    if (!this.playUrl(sfx.url, opts)) this.play(sfx.fallback, opts)
  }

  /** Fetch+decode `url` in the background if it hasn't been tried yet
   * (idempotent -- safe to call every frame). Never throws, never logs: a
   * missing or corrupt file just leaves playUrl() returning false forever,
   * which is the entire fallback contract. No-ops before init() has run. */
  private loadUrl(url: string): void {
    const ctx = this.ctx
    if (!ctx || this.urlBuffers.has(url) || this.urlFailed.has(url) || this.urlLoading.has(url)) return
    this.urlLoading.add(url)
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => {
        this.urlBuffers.set(url, buffer)
      })
      .catch(() => {
        this.urlFailed.add(url)
      })
      .finally(() => {
        this.urlLoading.delete(url)
      })
  }

  /** Public entry point to warm the cache for a file this engine doesn't
   * otherwise know about (announcer.ts's VO lines) without playing it.
   * Called once per bark from announcer.init(). */
  preloadUrl(url: string): void {
    this.loadUrl(url)
  }

  /**
   * Plays `url`'s buffer and returns true if it was already loaded.
   * Otherwise kicks off (or leaves running) a background load for next
   * time and returns false -- callers use the return value to decide
   * whether to fall back to their own synth sound or speech synthesis.
   */
  playUrl(url: string, opts?: PlayOpts): boolean {
    const buffer = this.urlBuffers.get(url)
    if (!buffer) {
      this.loadUrl(url)
      return false
    }
    this.playBuffer(buffer, opts)
    return true
  }

  /** Generated SFX with no synth recipe (see FileSoundName above). Silently
   * does nothing if the file hasn't finished loading yet or failed to load
   * -- there is no fallback sound to drop to for these three. */
  playFileSound(name: FileSoundName, opts?: PlayOpts): void {
    this.playUrl(FILE_SOUND_URLS[name], opts)
  }

  private playBuffer(buffer: AudioBuffer, opts?: PlayOpts): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    if (ctx.state === 'suspended') void ctx.resume()

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

    // Melee impact: low sine "knock" (120Hz->70Hz) plus a lowpassed noise
    // thud on top -- the landed half of melee_swing's whoosh, duller and
    // punchier than land/damage_taken so a connected swing reads distinctly.
    case 'melee_hit':
      return makeBuffer(ctx, 0.09, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, () => 700)
        let phase = 0
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const freq = 120 - 50 * Math.min(1, t / 0.05)
          phase += freq / sr
          const knock = Math.sin(2 * Math.PI * phase) * Math.exp(-t * 26)
          const thud = n[i] * Math.exp(-t * 40) * 0.5
          data[i] = (knock * 0.8 + thud) * Math.min(1, t / 0.003)
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

    // Power pickup taken: two-note rising bell (E5->A5), each note a
    // two-partial chime -- richer than flag_returned's plain sine arpeggio
    // so a weapon pickup doesn't get mistaken for a flag event.
    case 'pickup_taken':
      return makeBuffer(ctx, 0.24, (data, sr) => {
        const notes: [number, number][] = [
          [0, 659.25],
          [0.1, 880],
        ]
        for (const [start, freq] of notes) {
          const startI = Math.round(start * sr)
          for (let i = 0; i < data.length - startI; i++) {
            const t = i / sr
            const env = Math.exp(-t * 12) * Math.min(1, t / 0.004)
            data[startI + i] +=
              (Math.sin(2 * Math.PI * freq * t) * 0.6 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.25) * env
          }
        }
      })

    // Pickup pad ready: a soft, heavily lowpassed square-wave blip -- reads
    // as a distant klaxon rather than an alert, so it doesn't compete with
    // combat cues while signalling a power weapon just respawned.
    case 'pickup_ready':
      return makeBuffer(ctx, 0.16, (data, sr) => {
        const raw = new Float32Array(data.length)
        for (let i = 0; i < raw.length; i++) {
          const t = i / sr
          const freq = 340 + Math.sin(2 * Math.PI * 8 * t) * 20
          raw[i] = ((freq * t) % 1) < 0.5 ? 1 : -1
        }
        applyLowpass(raw, sr, () => 900)
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          data[i] = raw[i] * Math.exp(-t * 16) * Math.min(1, t / 0.02) * 0.35
        }
      })

    // Tiny lowpassed noise tick, ~15ms.
    case 'ui_click':
      return makeBuffer(ctx, 0.02, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, () => 6000)
        for (let i = 0; i < data.length; i++) data[i] = n[i] * Math.exp(-(i / sr) * 260) * 0.5
      })

    // Countdown tick: a dry, low-cutoff noise tick -- pitched darker and
    // shorter than ui_click so the warmup countdown doesn't sound like menu
    // navigation.
    case 'countdown_tick':
      return makeBuffer(ctx, 0.018, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, () => 2200)
        for (let i = 0; i < data.length; i++) data[i] = n[i] * Math.exp(-(i / sr) * 320) * 0.45
      })

    // Match go: a bright open bell stacked over a low boom -- the "fight!"
    // moment needs to read as unmistakably GO even under a wall of gunfire.
    case 'match_go':
      return makeBuffer(ctx, 0.4, (data, sr) => {
        let boomPhase = 0
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const bellEnv = Math.exp(-t * 6) * Math.min(1, t / 0.004)
          const bell = (Math.sin(2 * Math.PI * 1568 * t) * 0.5 + Math.sin(2 * Math.PI * 2093 * t) * 0.35) * bellEnv
          const boomFreq = 85 - 35 * Math.min(1, t / 0.2)
          boomPhase += boomFreq / sr
          const boom = Math.sin(2 * Math.PI * boomPhase) * Math.exp(-t * 7) * Math.min(1, t / 0.01) * 0.7
          data[i] = bell + boom
        }
      })

    // Hit marker: two-partial high sine tick (2400Hz + 3200Hz), ~40ms decay --
    // brighter/shorter than shield_hit so it reads as a confirmation ping
    // rather than the victim's own positional shield sound.
    case 'hit_tick':
      return makeBuffer(ctx, 0.05, (data, sr) => {
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const env = Math.exp(-t * 70) * Math.min(1, t / 0.002)
          data[i] = (Math.sin(2 * Math.PI * 2400 * t) * 0.6 + Math.sin(2 * Math.PI * 3200 * t) * 0.4) * env
        }
      })

    // Kill confirmation: same two-partial ping as hit_tick plus a lower
    // third partial and a longer decay, so a kill reads as unmistakably
    // stronger than a chip-damage hit.
    case 'hit_kill':
      return makeBuffer(ctx, 0.13, (data, sr) => {
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const env = Math.exp(-t * 22) * Math.min(1, t / 0.002)
          data[i] =
            (Math.sin(2 * Math.PI * 1400 * t) * 0.35 +
              Math.sin(2 * Math.PI * 2400 * t) * 0.5 +
              Math.sin(2 * Math.PI * 3200 * t) * 0.35) *
            env
        }
      })

    // Headshot ding: two-partial bright sine ping (2600Hz + 3800Hz), above
    // hit_kill's register so a headshot reads as brighter/sharper than a
    // regular kill confirmation, ~90ms decay.
    case 'headshot':
      return makeBuffer(ctx, 0.09, (data, sr) => {
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const env = Math.exp(-t * 30) * Math.min(1, t / 0.002)
          data[i] = (Math.sin(2 * Math.PI * 2600 * t) * 0.5 + Math.sin(2 * Math.PI * 3800 * t) * 0.5) * env
        }
      })

    // Damage taken: low lowpassed noise thud, ~90ms decay -- a body-hit
    // impact distinct from shield_hit's high "ping" (which only fires while
    // shield absorbs; this fires whenever the local player's own combined
    // health+shield drops, shield or no shield).
    case 'damage_taken':
      return makeBuffer(ctx, 0.1, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, () => 900)
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          data[i] = n[i] * Math.exp(-t * 26) * Math.min(1, t / 0.004) * 0.8
        }
      })

    // Low-health cue: two soft low sine thumps ("lub-dub"), ~260ms total --
    // played on a repeating timer while health stays under 25%.
    case 'heartbeat':
      return makeBuffer(ctx, 0.26, (data, sr) => {
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const beat1 = Math.exp(-Math.pow((t - 0.02) / 0.03, 2))
          const beat2 = Math.exp(-Math.pow((t - 0.13) / 0.035, 2)) * 0.75
          data[i] = Math.sin(2 * Math.PI * 60 * t) * (beat1 + beat2) * 0.9
        }
      })

    // Lowpassed noise tick, ~35ms decay.
    case 'footstep':
      return makeBuffer(ctx, 0.035, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, () => 1800)
        for (let i = 0; i < data.length; i++) data[i] = n[i] * Math.exp(-(i / sr) * 70) * 0.35
      })

    // Dull thud, sine 90Hz->60Hz over 60ms -- deliberately duller than
    // damage_taken so it doesn't read as a hit.
    case 'land':
      return makeBuffer(ctx, 0.06, (data, sr) => {
        let phase = 0
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const freq = 90 - (90 - 60) * Math.min(1, t / 0.06)
          phase += freq / sr
          data[i] = Math.sin(2 * Math.PI * phase) * Math.exp(-t * 30) * 0.5
        }
      })

    // The recovery half of the shield pair. Deliberately the inverse of
    // shield_break: that one is noise-led and falling, this is pure-tone and
    // rising, so "I am exposed" and "I am safe again" never sound alike.
    case 'shield_recharge':
      return makeBuffer(ctx, 0.22, (data, sr) => {
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const k = Math.min(1, t / 0.22)
          // Rise 1500->2400Hz with a soft bell envelope (no hard attack --
          // this is a reassurance, not an alert).
          const f = 1500 + 900 * k
          const env = Math.sin(Math.PI * k) * 0.5
          data[i] = (Math.sin(2 * Math.PI * f * t) * 0.7 + Math.sin(2 * Math.PI * f * 1.5 * t) * 0.3) * env
        }
      })

    // Backsmack: low body thud plus a bright crack on top, so an assassination
    // is audibly not a normal beatdown for either player.
    case 'backsmack':
      return makeBuffer(ctx, 0.3, (data, sr) => {
        const n = noise(data.length)
        applyLowpass(n, sr, () => 2600)
        let phase = 0
        for (let i = 0; i < data.length; i++) {
          const t = i / sr
          const freq = 140 - 80 * Math.min(1, t / 0.12)
          phase += freq / sr
          const body = Math.sin(2 * Math.PI * phase) * Math.exp(-t * 12)
          const crack = n[i] * Math.exp(-t * 38) * 0.55
          data[i] = (body + crack) * 0.9
        }
      })

    // Flag chain, pitched against flag_taken's A5-E5 alarm: dropped falls,
    // returned rises, so the three states are distinguishable without looking.
    case 'flag_dropped':
      return makeArpeggio(ctx, [659.25, 440], 0.1, 0.03, 'square')

    case 'flag_returned':
      return makeArpeggio(ctx, [523.25, 783.99], 0.1, 0.02, 'sine')

    // Spree: 3-note ascending square fanfare, above capture's sine arpeggio
    // so a personal streak reads as sharper than a team score.
    case 'spree':
      return makeArpeggio(ctx, [659.25, 880, 1046.5], 0.08, 0.015, 'square')

    // Lead change: two-note fall-then-rise, deliberately quiet and wide --
    // it fires for both teams, so it must not read as a reward.
    case 'lead_change':
      return makeArpeggio(ctx, [392, 587.33], 0.14, 0.03, 'sine')

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
