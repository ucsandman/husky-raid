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
 */

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

interface Bark {
  text: string
  /** Higher wins when two barks land in the same breath. */
  priority: number
  /** Unset today. Point at a generated VO file to replace the synth voice. */
  src?: string
}

const BARKS: Record<BarkId, Bark> = {
  match_start: { text: 'Fight!', priority: 5 },

  // Multikill ladder -- kills inside MULTIKILL_WINDOW of each other.
  double_kill: { text: 'Double kill', priority: 6 },
  triple_kill: { text: 'Triple kill', priority: 7 },
  overkill: { text: 'Overkill', priority: 8 },
  killtacular: { text: 'Killtacular', priority: 9 },

  // Spree ladder -- kills without dying. Halo's own 5/10/15 thresholds.
  killing_spree: { text: 'Killing spree', priority: 4 },
  killing_frenzy: { text: 'Killing frenzy', priority: 6 },
  running_riot: { text: 'Running riot', priority: 8 },

  backsmack: { text: 'Assassination', priority: 7 },

  flag_taken_by_us: { text: 'Enemy flag taken', priority: 5 },
  flag_taken_by_them: { text: 'Your flag has been taken', priority: 6 },
  flag_dropped_ours: { text: 'Your flag has been dropped', priority: 4 },
  flag_dropped_theirs: { text: 'Enemy flag dropped', priority: 3 },
  flag_returned_ours: { text: 'Your flag has been returned', priority: 4 },
  flag_returned_theirs: { text: 'Enemy flag returned', priority: 3 },

  we_scored: { text: 'Score!', priority: 7 },
  they_scored: { text: 'Enemy scores', priority: 7 },
  lead_taken: { text: 'You have taken the lead', priority: 5 },
  lead_lost: { text: 'You have lost the lead', priority: 5 },

  victory: { text: 'Victory', priority: 10 },
  defeat: { text: 'Defeat', priority: 10 },
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

  /** Must run inside a user gesture, alongside audioEngine.init(). Safe to
   * call repeatedly. Silently does nothing where the API is absent. */
  init(): void {
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
    if (!this.synth || this.volume <= 0) return
    const bark = BARKS[id]
    if (!bark) return

    const now = performance.now() / 1000
    const sinceLast = now - this.lastSpokeAt
    // Inside the gap, only a strictly more important line may interrupt.
    if (sinceLast < MIN_GAP && bark.priority <= this.lastPriority) return
    if (sinceLast < MIN_GAP) this.synth.cancel()

    const utter = new SpeechSynthesisUtterance(bark.text)
    if (this.voice) utter.voice = this.voice
    utter.volume = this.volume
    utter.rate = 1.05
    utter.pitch = 0.8
    this.synth.speak(utter)

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
