# Errors

Reusable debugging lessons for RIFTLANE. Newest first, short entries.

## 2026-08-14: Three separate sign-convention inversion bugs (mouse-look yaw, physics strafe, audio pan)

**Symptom:** during v1 implementation, code review independently caught three bugs where "left" and "right" came out reversed: mouse-look yaw direction, `physics.ts`'s `rightVec`/strafe movement, and the audio engine's stereo pan.

**Root cause:** each call site re-derived its own forward/right trig from yaw instead of reading the one canonical convention already defined in `shared/src/physics.ts` (`rightVec = forward x up`). Three independent derivations, three independent chances to flip a sign.

**Fix:** all three sites now compute direction from `physics.ts`'s `rightVec`/`forwardVec`/`viewDir` convention instead of re-deriving trig locally.

**Prevention:** all direction math derives from `physics.ts`'s `rightVec`/`viewDir` -- never re-derive sign conventions locally. Promoted to a hard rule in `docs/DECISIONS.md` ("Sign-convention rule for all direction math").
