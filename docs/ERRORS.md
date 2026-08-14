# Errors

Reusable debugging lessons for RIFTLANE. Newest first, short entries.

## 2026-08-14: Game rendered perfectly and ignored the keyboard completely

**Symptom:** in a live match the scene rendered, bots fought, the HUD updated, and no key or mouse button did anything. It felt like the keyboard was disconnected.

**Root cause:** `InputManager` gates every handler on `this.locked` (pointer lock), and pointer lock is requested from a click on the canvas. There are two nested app divs: the outer `#app` from `index.html`, and an inner `div.app` that `ui/menu.ts` builds inside it. `.app--playing { pointer-events: none }` is toggled on the **inner** div only, while the outer `#app` is `height:100%; position:relative` and paints over the fixed canvas. So the click landed on `#app`, `requestPointerLock()` was never called (no error, it simply never ran), `locked` stayed false, and every input was dropped. Confirmed live: `document.elementFromPoint(cx, cy)` returned `DIV#app` during a match.

**Fix:** `main.ts` now flips `appRoot.style.pointerEvents` alongside the canvas on every phase change, so the whole DOM overlay is click-through while playing.

**Prevention:** nothing about this is visible from reading the code, from tests, or from a screenshot -- the game LOOKS perfect while completely deaf. It survived because every previous check confirmed rendering, never control. Any "is the app working" pass on an interactive surface must drive one real input and confirm one state change caused by it. `elementFromPoint` at the point a user would click is the cheap version of that check.

## 2026-08-14: Deployed client dialed :8080 and could never connect from a browser

**Symptom:** riftlane.onrender.com rendered the menu and reported no connection. The server was healthy: HTTP 200 in 0.13s, and a Node `ws` client got `{"t":"pong"}` back instantly over `wss://riftlane.onrender.com`. Only browsers failed, and they failed every single time. The deploy had never once worked from a browser.

**Root cause:** `main.ts` chose the WebSocket URL with `!location.port || location.port === '5173' ? hostname:8080 : host`. On an https page `location.port` is the **empty string**, because 443 is implicit. The deployed client therefore read "no page port to go on", dialed `wss://riftlane.onrender.com:8080`, and hit a port Render does not expose. Confirmed by evaluating that expression on the live page.

**Fix:** extracted `serverUrl()` into `client/src/net.ts`, exported and unit-tested against the real deployed URL. `location.host` already carries the port when there is one and omits it for 80/443, so the page's own origin is the right answer everywhere except the Vite dev server on :5173.

**Prevention:** local testing structurally could not catch this. Serving on :8123 takes the correct branch, so the bug exists only on default ports, which means only in production. Two rules: origin-derivation logic gets a unit test with the real deployed URL as a case, and a deploy is not verified until a browser has actually loaded the deployed URL and connected. A green local run plus a healthy `/health` proves nothing about the browser path.

## 2026-08-14: Retry budget of 6 seconds against a host with a 60 second cold start

**Symptom:** found while fixing the entry above. Any connection loss became permanent: the client printed "Lost connection to the server. Refresh to try again." and stopped trying. Separately measured against production, an open socket died at 15.2 minutes with close code 1006 even while sending an app-level ping every 25s, then took 21s to come back.

**Root cause:** two defects that only show up against a host that can go away for a while. (1) The client's whole retry budget was 3 attempts on a linear 1s/2s/3s backoff -- about 6 seconds -- while `render.yaml` in the same repo documents a ~60s cold start for the free plan it deploys to. A sleeping instance could not possibly be waited out, so the client always reached its terminal state. (2) Neither end sent any keepalive, and the client holds `hello` back until the player's first click, so a socket opened on the menu carried literally zero bytes in either direction and nothing detected or prevented its death. Measured against production: an idle socket did survive 6 minutes, so the proxy was not the reaper -- the instance sleeping was.

**Fix:** capped exponential backoff that retries for as long as the page is open (`client/src/net.ts`), a 25s app-level `ping`/`pong` both ways plus a 30s server-side liveness sweep that terminates half-open sockets, and a status bar that says "Server is waking up. This can take up to a minute." with a Reconnect button instead of "refresh".

**Prevention:** a client's retry budget is a claim about how long its server can be gone. Check it against the host's documented cold start, not against a number that feels reasonable. Never ship "refresh to try again" as a terminal state when the recovery is something the code can do itself.

## 2026-08-14: Three separate sign-convention inversion bugs (mouse-look yaw, physics strafe, audio pan)

**Symptom:** during v1 implementation, code review independently caught three bugs where "left" and "right" came out reversed: mouse-look yaw direction, `physics.ts`'s `rightVec`/strafe movement, and the audio engine's stereo pan.

**Root cause:** each call site re-derived its own forward/right trig from yaw instead of reading the one canonical convention already defined in `shared/src/physics.ts` (`rightVec = forward x up`). Three independent derivations, three independent chances to flip a sign.

**Fix:** all three sites now compute direction from `physics.ts`'s `rightVec`/`forwardVec`/`viewDir` convention instead of re-deriving trig locally.

**Prevention:** all direction math derives from `physics.ts`'s `rightVec`/`viewDir` -- never re-derive sign conventions locally. Promoted to a hard rule in `docs/DECISIONS.md` ("Sign-convention rule for all direction math").
