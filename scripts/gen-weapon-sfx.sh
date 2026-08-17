#!/usr/bin/env bash
# Generates the weapon/explosion SFX the client loads at runtime, replacing the
# synthesized oscillator sounds in client/src/audio.ts (a 700Hz square wave for
# every rifle, a falling sine chirp for the sniper -- i.e. "pew").
#
#   bash scripts/gen-weapon-sfx.sh            # only generates missing files
#   FORCE=1 bash scripts/gen-weapon-sfx.sh    # regenerates everything
#   FORCE=1 ONLY=weapon_railspike bash scripts/gen-weapon-sfx.sh   # one file
#
# Needs ELEVENLABS_API_KEY in .env (never printed) and ffmpeg on PATH.
# Raw generations are kept in assets/audio-raw/ and committed (~200KB total) so
# the mix can be re-tuned offline: delete a file under client/public and re-run
# to re-master it from the raw without spending API credits. Only a missing raw
# (or FORCE=1) calls the API.
#
# Each row is: name | prompt | generated seconds | kept seconds | mix gain dB
# "kept seconds" matters: the MA40 fires every 100ms, so a 0.8s sample would
# stack eight deep and turn into mud. "mix gain" is applied AFTER peak
# normalizing to -1 dBFS, so the table is the actual weapon mix -- a pistol
# must not be as loud as a rocket.
set -euo pipefail

cd "$(dirname "$0")/.."
SKILL="$HOME/.claude/skills/threejs-audio-generator/scripts/threejs_audio_asset.py"
RAW=assets/audio-raw
OUT=client/public/assets/audio/sfx
mkdir -p "$RAW" "$OUT"

set -a
# shellcheck disable=SC1091
. ./.env
set +a

ROWS=(
  "weapon_pulse_smg|single gunshot from a modern assault rifle, close mic, dry hard mechanical crack with bolt snap and low chest thump, indoor concrete room, very short tail, no music, no voice|0.8|0.30|-7"
  "weapon_sidearm|loud pistol gunshot recorded close up, sharp dry snap with metallic slide clack, tight small room, minimal tail, no music, no voice|0.8|0.32|-7"
  "weapon_triad_rifle|three round burst from a military battle rifle, rapid tight triple crack, dry mechanical bolt, short room slap, no music, no voice|1.0|0.50|-7"
  "weapon_commando|single shot from a heavy automatic battle rifle, deep percussive thud with metallic bolt clank, dry mid sized room, short tail, no music, no voice|0.9|0.34|-6"
  "weapon_scattergun|12 gauge pump shotgun blast starting instantly, deep punchy boom, shell rattle, short room slap tail, no lead in silence, no music, no voice|0.9|0.60|-4"
  "weapon_swarm_pod|single crystalline needle shard launched from a science fiction weapon, instant glassy metallic tick with quick resonant ring, no build up, no music, no voice|0.6|0.20|-8"
  "weapon_cinderlob|science fiction grenade launcher firing a plasma bolt, hollow low thump with charged energy whoosh departing, short, no music, no voice|1.0|0.55|-5"
  "weapon_railspike|single shot from a high powered sniper rifle outdoors, enormous sharp crack, deep boom body, long decaying crack across open ground, no music, no voice|1.8|1.20|-2"
  "weapon_boomtube|shoulder fired rocket launcher firing, hard ignition whoosh, deep pressurized blast, rocket motor roar receding into the distance, no music, no voice|1.8|1.40|-1"
  "weapon_arc_blade|science fiction plasma energy sword swung fast, searing electric hum sweeping past the microphone, crackling arc discharge, no music, no voice|1.0|0.60|-6"
  "weapon_grav_maul|enormous science fiction gravity hammer slamming into the ground, heavy metal impact, deep gravitational whump, debris scatter, no music, no voice|1.4|0.95|-2"
  "explosion|close rocket explosion, hard punch transient, deep low body, debris and shrapnel scatter, tight tail, outdoors, no music, no voice|2.0|1.50|-1"
)

for row in "${ROWS[@]}"; do
  IFS='|' read -r name prompt dur keep gain <<<"$row"
  if [ -n "${ONLY:-}" ] && [ "$ONLY" != "$name" ]; then continue; fi
  if [ -f "$OUT/$name.mp3" ] && [ -z "${FORCE:-}" ]; then
    echo "skip $name (exists)"
    continue
  fi

  if [ ! -f "$RAW/$name.mp3" ] || [ -n "${FORCE:-}" ]; then
    echo "generate $name (${dur}s)"
    python "$SKILL" sfx --prompt "$prompt" --duration "$dur" --prompt-influence 0.75 --out "$RAW/$name.mp3" >/dev/null
  fi

  # silenceremove first: several generations open with up to 100ms of dead air
  # (the shotgun's bang landed at 0.10s), and a trigger pull that answers late
  # feels broken no matter how good the sample is. Then peak normalize to
  # -1 dBFS and apply this weapon's mix gain.
  peak=$(ffmpeg -i "$RAW/$name.mp3" -af volumedetect -f null - 2>&1 | sed -n 's/.*max_volume: \(-*[0-9.]*\) dB.*/\1/p')
  adjust=$(python -c "print(f'{-1 - $peak + $gain:.2f}')")
  fade=$(python -c "print(f'{max(0.0, $keep - 0.06):.3f}')")
  ffmpeg -y -v error -i "$RAW/$name.mp3" -t "$keep" \
    -af "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0,volume=${adjust}dB,afade=t=out:st=${fade}:d=0.06" \
    -ac 1 -ar 44100 -b:a 128k "$OUT/$name.mp3"
  echo "  -> $OUT/$name.mp3  keep=${keep}s peak=${peak}dB gain=${gain}dB"
done
