# Design

Visual system for RIFTLANE's DOM UI (menu screens and in-match HUD). Source of truth for tokens is `client/src/ui/style.css`; this document describes the system those tokens implement.

## Theme

Dark only, by intent: the UI frames a 3D arena rendered against a night sky, and matches are played in a pointer-locked fullscreen canvas. Deep blue-black ground (`#0a0d14`) with a faint 32px horizontal grid line pattern and two soft radial glows (cobalt top-left, ember bottom-right) that echo the team colors.

## Color Tokens

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#0a0d14` | Page background |
| `--bg-grid` | `#0d1220` | Background grid lines |
| `--panel` | `#131826` | Card / panel surface |
| `--panel-2` | `#1a2133` | Inputs, nested surfaces |
| `--border` | `#26304a` | All borders, tag backgrounds |
| `--text` | `#e7ecf7` | Primary text |
| `--text-dim` | `#8592b0` | Secondary text (AA on panel at body sizes) |
| `--cobalt` | `#3366ff` | Team 0 identity, primary actions, focus rings |
| `--ember` | `#ff7733` | Team 1 identity |
| `--ok` | `#35d07f` | Positive status (connected, flag secured) |
| `--warn` | `#ffb23f` | Caution status (reconnecting, flag dropped, streaks) |
| `--danger` | `#ff4d5e` | Negative status (disconnected, damage, eliminated) |

Rules: cobalt/ember mean team identity, ok/warn/danger mean state. Never repurpose one band for the other.

## Typography

- `--sans` (`Segoe UI`, system-ui): body copy, buttons, inputs.
- `--mono` (`Consolas`, ui-monospace): the brand voice. Titles, field labels, room codes, tags, the entire in-match HUD.
- Labels and headings are short, uppercase, letter-spaced (0.06-0.3em). Body copy is sentence case.
- Scale: 0.65rem tags → 0.75rem labels → 0.95rem body → 2rem screen titles → 2.5rem room code → 3rem respawn countdown.

## Components

- **Card**: `--panel` surface, 1px `--border`, 12px radius, 2rem padding, deep drop shadow. Max width 380px (520px for `--wide`). One card per screen, centered.
- **Buttons**: `.btn` (panel-2 surface), `.btn--primary` (solid cobalt), `.btn--ghost` (transparent), `.btn--small`. All have hover, active (1px press), disabled, and `:focus-visible` ring states.
- **Inputs**: `.text-input` on panel-2; `.text-input--code` variant is mono, tracked, uppercase for 4-letter room codes. Range inputs use cobalt accent.
- **Status bar**: top strip, mono, with a glowing status dot (ok/warn/danger) and an error message slot; polite ARIA live region.
- **Roster rows / tags**: panel-2 rows with a team swatch dot; `BOT` tag in mono on `--border` background.
- **HUD** (`hud.css`): fixed, `pointer-events: none`, mono. Crosshair with recoil kick, hit markers (danger) and kill markers (warn), shield bar (cobalt) + 6 health pips (ok), weapon rows with active highlight, grenade/equipment chips, kill feed (top right), score strip (top center), flag banners (state colors), respawn overlay, Tab scoreboard.
- **Motion tracker** (`.hud-tracker`): 132px dial, bottom center — clear of the vitals cluster (bottom-left) and loadout (bottom-right), and well below the crosshair. Ring + crosshairs on `--border`, a `--text` chevron for the player (up is where you face), and pooled blips carrying **team identity**: `--cobalt` for allies, `--ember` for enemies. Never state colors.
- **Callout banner** (`.hud-callout`): transient single line at 22% height for the flag chain and lead changes. `--ok` when it is good news for you, `--danger` when it is not, plain `--text` otherwise. 2.2s fade, opacity-only under `prefers-reduced-motion`.
- **Death card** (`.hud-death-card`): one dim mono line under the respawn countdown — killer, weapon, distance. Clears on revival.
- **Medals** (`.medal`, `.medal-strip`, `style.css`): post-match only. Two-character mono glyphs on `--border`, with the full medal name in `title` and `aria-label` since a glyph alone is not self-explanatory.

## Motion

- Menu transitions 150ms ease; button press 50ms translate.
- HUD feedback: kill banner pop (1.4s, scale 0.75 → 1.08 → 1), kill feed 4s hold-then-fade, damage vignette 100ms pulse, directional damage arrow 450ms fade.
- `prefers-reduced-motion`: spinner stops, button transitions drop, kill banner switches to an opacity-only fade. Opacity-only fades stay.

## Layout

- Menu screens: single centered card over the gradient/grid background, flex column with a status bar on top.
- HUD: edge-anchored clusters (vitals bottom-left, loadout bottom-right, feed top-right, score top-center) leaving the center clear except for the crosshair and momentary banners.
