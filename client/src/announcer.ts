/**
 * Announcer: the spoken layer over the match.
 *
 * Runs on the Web Speech API, which is free, needs no assets and no server
 * round-trip. That is also its ceiling: the voice is whatever the machine
 * ships, it cannot be routed through the WebAudio graph, and Firefox's
 * support is patchy. So every call site treats speech as optional garnish --
 * `speak()` is a no-op when the API is missing and nothing else changes.
 *
 * SWAPPING IN REAL VO: every line lives in the BARKS table below with an
 * optional `src`. Fill those in with generated audio paths and teach
 * `speak()` to prefer `src` over `speechSynthesis`; no call site changes.
 * That is the whole reason the vocabulary is a data table and not a pile of
 * string literals at the point of use.
 *
 * Every bark below now has a generated `src`, played through audioEngine's
 * WebAudio graph (playUrl) so it's volume/mute-linked the same way as every
 * other sound. speechSynthesis is the fallback for whichever bark's file
 * hasn't finished loading yet (or failed to load) at the moment it fires --
 * never a hard requirement.
 */
import { audioEngine, type FileSoundName } from './audio'

export type BarkId =
  | 'match_start'
  | 'double_kill'
  | 'triple_kill'
  | 'overkill'
  | 'killtacular'
  | 'killing_spree'
  | 'killing_frenzy'
  | 'running_riot'
  | 'backsmack'
  | 'flag_taken_by_us'
  | 'flag_taken_by_them'
  | 'flag_dropped_ours'
  | 'flag_dropped_theirs'
  | 'flag_returned_ours'
  | 'flag_returned_theirs'
  | 'we_scored'
  | 'they_scored'
  | 'lead_taken'
  | 'lead_lost'
  | 'victory'
  | 'defeat'
  | 'power_weapon_ready'

interface Bark {
  text: string
  /** Higher wins when two barks land in the same breath. */
  priority: number
  /** Generated VO file, preferred over speechSynthesis when loaded (see speak()). */
  src?: string
}

const BARKS: Record<BarkId, Bark> = {
  // Also the line for the sim's 'match_go' event (warmup countdown hits
  // zero) -- same "Fight!" call, one bark id, no duplicate needed.
  match_start: { text: 'Fight!', priority: 5, src: '/assets/audio/voice/match_start.mp3' },

  // Multikill ladder -- kills inside MULTIKILL_WINDOW of each other.
  double_kill: { text: 'Double kill', priority: 6, src: '/assets/audio/voice/double_kill.mp3' },
  triple_kill: { text: 'Triple kill', priority: 7, src: '/assets/audio/voice/triple_kill.mp3' },
  overkill: { text: 'Overkill', priority: 8, src: '/assets/audio/voice/overkill.mp3' },
  killtacular: { text: 'Killtacular', priority: 9, src: '/assets/audio/voice/killtacular.mp3' },

  // Spree ladder -- kills without dying. Halo's own 5/10/15 thresholds.
  killing_spree: { text: 'Killing spree', priority: 4, src: '/assets/audio/voice/killing_spree.mp3' },
  killing_frenzy: { text: 'Killing frenzy', priority: 6, src: '/assets/audio/voice/killing_frenzy.mp3' },
  running_riot: { text: 'Running riot', priority: 8, src: '/assets/audio/voice/running_riot.mp3' },

  backsmack: { text: 'Assassination', priority: 7, src: '/assets/audio/voice/backsmack.mp3' },

  flag_taken_by_us: { text: 'Enemy flag taken', priority: 5, src: '/assets/audio/voice/flag_taken_by_us.mp3' },
  flag_taken_by_them: {
    text: 'Your flag has been taken',
    priority: 6,
    src: '/assets/audio/voice/flag_taken_by_them.mp3',
  },
  flag_dropped_ours: {
    text: 'Your flag has been dropped',
    priority: 4,
    src: '/assets/audio/voice/flag_dropped_ours.mp3',
  },
  flag_dropped_theirs: { text: 'Enemy flag dropped', priority: 3, src: '/assets/audio/voice/flag_dropped_theirs.mp3' },
  flag_returned_ours: {
    text: 'Your flag has been returned',
    priority: 4,
    src: '/assets/audio/voice/flag_returned_ours.mp3',
  },
  flag_returned_theirs: {
    text: 'Enemy flag returned',
    priority: 3,
    src: '/assets/audio/voice/flag_returned_theirs.mp3',
  },

  we_scored: { text: 'Score!', priority: 7, src: '/assets/audio/voice/we_scored.mp3' },
  they_scored: { text: 'Enemy scores', priority: 7, src: '/assets/audio/voice/they_scored.mp3' },
  lead_taken: { text: 'You have taken the lead', priority: 5, src: '/assets/audio/voice/lead_taken.mp3' },
  lead_lost: { text: 'You have lost the lead', priority: 5, src: '/assets/audio/voice/lead_lost.mp3' },

  // Power weapon pickup pad respawned -- an environmental cue, not a
  // personal reward, so its priority sits with the flag-state barks rather
  // than the kill ladder.
  power_weapon_ready: { text: 'Power weapon up', priority: 4, src: '/assets/audio/voice/power_weapon_ready.mp3' },

  victory: { text: 'Victory', priority: 10, src: '/assets/audio/voice/victory.mp3' },
  defeat: { text: 'Defeat', priority: 10, src: '/assets/audio/voice/defeat.mp3' },
}

/** Bark ids that also layer a one-shot SFX (no synth recipe -- see
 * audio.ts's FileSoundName) on top of their VO line. match_start has no
 * existing synth cue at all; we_scored/they_scored already get game.ts's
 * 'capture' chime, so this is a bigger payoff stacked on top of it, not a
 * replacement. */
const BARK_SFX: Partial<Record<BarkId, FileSoundName>> = {
  match_start: 'match_start_horn',
  we_scored: 'flag_capture_stinger',
  they_scored: 'flag_capture_stinger',
}

/** Minimum gap between two spoken lines. Without it a double kill that also
 * crosses a spree threshold talks over itself. */
const MIN_GAP = 0.9

const SPREE_BARKS: [number, BarkId][] = [
  [15, 'running_riot'],
  [10, 'killing_frenzy'],
  [5, 'killing_spree'],
]

const MULTIKILL_BARKS: [number, BarkId][] = [
  [5, 'killtacular'],
  [4, 'overkill'],
  [3, 'triple_kill'],
  [2, 'double_kill'],
]

class Announcer {
  private synth: SpeechSynthesis | null = null
  private voice: SpeechSynthesisVoice | null = null
  private volume = 1
  private unlocked = false

  /** Seconds (performance.now based) of the last spoken line. */
  private lastSpokeAt = -Infinity
  private lastPriority = 0

  /** Guards the VO preload below so it only ever runs once, independent of
   * `unlocked` (which tracks speechSynthesis specifically and can stay
   * false forever on a browser without it). */
  private voPreloaded = false

  /** Must run inside a user gesture, alongside audioEngine.init() (which it
   * assumes has already run -- main.ts calls them back to back on the same
   * gesture). Safe to call repeatedly. Silently does nothing where the
   * speechSynthesis API is absent; VO preload doesn't need it. */
  init(): void {
    if (!this.voPreloaded) {
      this.voPreloaded = true
      for (const bark of Object.values(BARKS)) {
        if (bark.src) audioEngine.preloadUrl(bark.src)
      }
    }

    if (this.unlocked) return
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    this.synth = window.speechSynthesis
    this.unlocked = true
    this.pickVoice()
    // Voice lists load asynchronously in Chrome; re-pick when they arrive.
    if ('onvoiceschanged' in this.synth) {
      this.synth.addEventListener('voiceschanged', () => this.pickVoice())
    }
  }

  /** Prefers a deep, clearly-enunciated en-US voice, which is the closest
   * this API gets to a military announcer. Falls back to the default. */
  private pickVoice(): void {
    if (!this.synth) return
    const voices = this.synth.getVoices()
    if (!voices.length) return
    const preferred = ['Google US English', 'Microsoft David', 'Daniel', 'Alex']
    for (const want of preferred) {
      const found = voices.find((v) => v.name.includes(want))
      if (found) {
        this.voice = found
        return
      }
    }
    this.voice = voices.find((v) => v.lang.startsWith('en')) ?? voices[0]
  }

  /** Wired to the same settings.volume the audio engine uses, so muting the
   * game mutes the announcer too. */
  setVolume(v: number): void {
    this.volume = v
  }

  /** Clears per-life and per-match state. Call on match start. */
  reset(): void {
    this.lastSpokeAt = -Infinity
    this.lastPriority = 0
    this.synth?.cancel()
  }

  speak(id: BarkId): void {
    if (this.volume <= 0) return
    const bark = BARKS[id]
    if (!bark) return

    const now = performance.now() / 1000
    const sinceLast = now - this.lastSpokeAt
    // Inside the gap, only a strictly more important line may interrupt.
    if (sinceLast < MIN_GAP && bark.priority <= this.lastPriority) return
    if (sinceLast < MIN_GAP) this.synth?.cancel()

    // Prefer the generated VO file; speechSynthesis is the fallback for
    // whichever bark hasn't finished loading (or failed to load) yet.
    const playedFile = bark.src ? audioEngine.playUrl(bark.src) : false
    if (!playedFile && this.synth) {
      const utter = new SpeechSynthesisUtterance(bark.text)
      if (this.voice) utter.voice = this.voice
      utter.volume = this.volume
      utter.rate = 1.05
      utter.pitch = 0.8
      this.synth.speak(utter)
    }

    const sfx = BARK_SFX[id]
    if (sfx) audioEngine.playFileSound(sfx)

    this.lastSpokeAt = now
    this.lastPriority = bark.priority
  }

  /**
   * A spree threshold, off the SERVER's kills-since-death count on the kill
   * event. Not a client tally: prediction never fabricates a kill event, but
   * a locally-counted streak would drift on any dropped snapshot.
   *
   * Fires only on the exact threshold, so 6..9 kills stay quiet. Returns the
   * bark it chose (or null) so the caller can play a matching sting without
   * duplicating the ladder.
   */
  onLocalKill(streak: number | undefined): BarkId | null {
    const spree = SPREE_BARKS.find(([n]) => streak === n)
    if (!spree) return null
    this.speak(spree[1])
    return spree[1]
  }

  /**
   * A multikill, counted by the HUD rather than here. The HUD already runs
   * this exact window for its on-screen banner (KILL_STREAK_WINDOW), and two
   * independent counters would eventually disagree about the same kill --
   * so the banner is the single source of truth and the voice follows it.
   */
  multikill(count: number): BarkId | null {
    const multi = MULTIKILL_BARKS.find(([n]) => count >= n)
    if (!multi) return null
    this.speak(multi[1])
    return multi[1]
  }
}

export const announcer = new Announcer()
