# Errors

Reusable debugging lessons for RIFTLANE. Newest first, short entries.

## 2026-08-14: Deployed game showed "Lost connection to the server. Refresh to try again." and never recovered

**Symptom:** riftlane.onrender.com sat on the menu with a red `disconnected` dot and a dead-end error asking the player to refresh. The server was healthy the whole time (HTTP 200 in 0.15s, `/health` fine).

**Root cause:** two defects that only show up against a host that can go away for a while. (1) The client's whole retry budget was 3 attempts on a linear 1s/2s/3s backoff -- about 6 seconds -- while `render.yaml` in the same repo documents a ~60s cold start for the free plan it deploys to. A sleeping instance could not possibly be waited out, so the client always reached its terminal state. (2) Neither end sent any keepalive, and the client holds `hello` back until the player's first click, so a socket opened on the menu carried literally zero bytes in either direction and nothing detected or prevented its death. Measured against production: an idle socket did survive 6 minutes, so the proxy was not the reaper -- the instance sleeping was.

**Fix:** capped exponential backoff that retries for as long as the page is open (`client/src/net.ts`), a 25s app-level `ping`/`pong` both ways plus a 30s server-side liveness sweep that terminates half-open sockets, and a status bar that says "Server is waking up. This can take up to a minute." with a Reconnect button instead of "refresh".

**Prevention:** a client's retry budget is a claim about how long its server can be gone. Check it against the host's documented cold start, not against a number that feels reasonable. Never ship "refresh to try again" as a terminal state when the recovery is something the code can do itself.

## 2026-08-14: Three separate sign-convention inversion bugs (mouse-look yaw, physics strafe, audio pan)

**Symptom:** during v1 implementation, code review independently caught three bugs where "left" and "right" came out reversed: mouse-look yaw direction, `physics.ts`'s `rightVec`/strafe movement, and the audio engine's stereo pan.

**Root cause:** each call site re-derived its own forward/right trig from yaw instead of reading the one canonical convention already defined in `shared/src/physics.ts` (`rightVec = forward x up`). Three independent derivations, three independent chances to flip a sign.

**Fix:** all three sites now compute direction from `physics.ts`'s `rightVec`/`forwardVec`/`viewDir` convention instead of re-deriving trig locally.

**Prevention:** all direction math derives from `physics.ts`'s `rightVec`/`viewDir` -- never re-derive sign conventions locally. Promoted to a hard rule in `docs/DECISIONS.md` ("Sign-convention rule for all direction math").
