/**
 * Playtest smoke test: drives a REAL match in a real browser and checks the
 * things unit tests structurally cannot see -- that keys and mouse buttons
 * actually reach the server, that the gun actually fires, that scoping works,
 * and that losing pointer lock tells the player instead of silently killing
 * every input.
 *
 * Why this exists: on 2026-08-14 the game shipped with the first trigger pull
 * of every match swallowed and with all keyboard input gated behind pointer
 * lock. 121 unit tests were green the whole time, because none of them cross
 * the browser boundary. This script is that missing check.
 *
 *   npm run start            # in another terminal (or set RIFTLANE_URL)
 *   node scripts/playtest-smoke.mjs
 *
 * Requires Playwright's Chromium: npx playwright install chromium
 * Set HEADED=0 to hide the window. Exits non-zero if any check fails.
 */
import { chromium } from 'playwright'

const URL = process.env.RIFTLANE_URL || 'http://localhost:8123'
const HEADED = process.env.HEADED !== '0'

const checks = []
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const browser = await chromium.launch({ headless: !HEADED })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })

// Tap the socket so every assertion is about what the SERVER actually saw,
// not about what the client believes it sent.
await ctx.addInitScript(() => {
  window.__probe = { sent: [], snaps: [], myId: null, lockErrors: 0 }
  const Orig = window.WebSocket
  const Wrapped = function (...args) {
    const ws = new Orig(...args)
    const origSend = ws.send.bind(ws)
    ws.send = (data) => {
      try {
        const m = JSON.parse(data)
        if (m && m.t === 'input') window.__probe.sent.push(m.input)
      } catch {}
      return origSend(data)
    }
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data)
        if (m.t === 'match_start') window.__probe.myId = m.yourId
        if (m.t === 'snapshot' && window.__probe.myId) {
          window.__probe.phase = m.phase ?? 'playing'
          const me = m.players.find((p) => p.id === window.__probe.myId)
          if (me) window.__probe.snaps.push({ pos: me.pos, vel: me.vel, yaw: me.yaw, ammo: me.ammo, alive: me.alive })
        }
      } catch {}
    })
    return ws
  }
  Wrapped.prototype = Orig.prototype
  Object.assign(Wrapped, Orig)
  window.WebSocket = Wrapped
  document.addEventListener('pointerlockerror', () => { window.__probe.lockErrors++ })
})

const page = await ctx.newPage()
const reset = () => page.evaluate(() => { window.__probe.sent.length = 0; window.__probe.snaps.length = 0 })

/**
 * Blocks until the local player is alive, then lets one more snapshot land.
 *
 * Without this the suite was flaky in exactly one way: the movement check
 * walks the player out into the open with W+D, bots shoot them, and the fire
 * and scope checks then run against a CORPSE. A dead player consumes no ammo
 * and cannot scope, so both checks failed together -- measured 2 of 3 runs
 * failing on unmodified main, with `alive:false, shield:0` at check time.
 * That looked exactly like a real input regression, which is worse than a
 * plain flake: it accuses working code.
 */
const waitAlive = async () => {
  await page.waitForFunction(() => window.__probe.snaps.at(-1)?.alive === true, null, { timeout: 20000 })
  await page.waitForTimeout(120)
}

try {
  await page.goto(URL)
  await page.getByText('Quick Play').click()
  // Solo quick play waits ~10s before filling with bots.
  await page.waitForFunction(() => window.__probe.myId && window.__probe.snaps.length > 5, null, { timeout: 90000 })
  // The pause panel now covers screen center while input is paused, so a
  // canvas-center click gets intercepted. Clicking its Resume button is the
  // real player path and doubles as a check that the new panel works.
  await page.getByRole('button', { name: 'Resume' }).click()
  await page.waitForTimeout(500)

  // --- keyboard reaches the server -------------------------------------
  await reset()
  await page.keyboard.down('w')
  await page.keyboard.down('d')
  await page.waitForTimeout(600)
  const moved = await page.evaluate(() => {
    const s = window.__probe.sent
    return { count: s.length, last: s.length ? { forward: s.at(-1).forward, strafe: s.at(-1).strafe } : null }
  })
  await page.keyboard.up('w')
  await page.keyboard.up('d')
  check('keyboard reaches the server', moved.count > 5 && moved.last?.forward === 1 && moved.last?.strafe === 1,
    `${moved.count} inputs, last=${JSON.stringify(moved.last)}`)

  // A settled diagonal must travel at ~45 degrees, not ~10. Measured in the
  // player's own frame from server snapshots, over walking-speed samples
  // only (launch pads and teleporters would otherwise dominate). Reported
  // rather than asserted: the reading is only meaningful in open lane, and
  // shared/test/physics.test.ts pins the movement model itself.
  const heading = await page.evaluate(() => {
    const hs = window.__probe.snaps
      .filter((s) => s.alive)
      .map((s) => ({ sp: Math.hypot(s.vel.x, s.vel.z), s }))
      .filter((o) => o.sp > 4 && o.sp < 10)
      .map(({ s }) => {
        const f = s.vel.x * Math.sin(s.yaw) + s.vel.z * Math.cos(s.yaw)
        const r = s.vel.x * -Math.cos(s.yaw) + s.vel.z * Math.sin(s.yaw)
        return (Math.atan2(r, f) * 180) / Math.PI
      })
      .sort((a, b) => a - b)
    return hs.length ? +hs[Math.floor(hs.length / 2)].toFixed(1) : null
  })
  console.log(`INFO  W+D heading ${heading}deg (expect ~45 in open lane; 0 means blocked by a wall)`)

  // --- the gun actually fires ------------------------------------------
  // Alive-gated: see waitAlive. reset() clears the snapshot buffer, so the
  // wait has to come first or .at(-1) reads an empty array.
  // Retried: waitAlive only guarantees the player is alive at the START, and
  // dying mid-burst resets the magazine, which reads as "the gun never
  // fired". `survived` distinguishes a real input failure from a death.
  // Matches now open with a WARMUP_SEC countdown during which firing is
  // inert by design -- wait for the sim to go live before testing the gun.
  await page.waitForFunction(() => window.__probe.phase === 'playing', null, { timeout: 20000 })

  let fired = null
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitAlive()
    await reset()
    await page.waitForTimeout(400)
    const ammoBefore = await page.evaluate(() => window.__probe.snaps.at(-1)?.ammo?.[0] ?? null)
    await page.mouse.down()
    await page.waitForTimeout(900)
    await page.mouse.up()
    await page.waitForTimeout(300)
    fired = await page.evaluate((before) => ({
      before,
      after: window.__probe.snaps.at(-1)?.ammo?.[0] ?? null,
      onWire: window.__probe.sent.some((i) => i.fire === true),
      survived: window.__probe.snaps.every((s) => s.alive),
    }), ammoBefore)
    if (fired.survived) break
  }
  check('holding fire consumes ammo', fired.onWire && fired.after !== null && fired.before !== null && fired.after < fired.before,
    `ammo ${fired.before} -> ${fired.after}`)

  // --- aim down sights --------------------------------------------------
  // Same 3-attempt survival retry as the fire check above, and for the same
  // reason: a corpse cannot scope, so a bot killing the player inside the
  // 500ms hold reads as a broken right mouse button. Measured 1 of 3 runs
  // failing on unmodified main without this loop.
  let ads = null
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitAlive()
    await reset()
    await page.waitForTimeout(150)
    await page.mouse.down({ button: 'right' })
    await page.waitForTimeout(500)
    ads = await page.evaluate(() => ({
      onWire: window.__probe.sent.some((i) => i.ads === true),
      scope: !!document.querySelector('.hud-scope--show'),
      crosshairHidden: !!document.querySelector('.hud-crosshair--hidden'),
      survived: window.__probe.snaps.every((s) => s.alive),
    }))
    await page.mouse.up({ button: 'right' })
    if (ads.survived) break
  }
  check('right mouse scopes in', ads.onWire && ads.scope && ads.crosshairHidden,
    `wire=${ads.onWire} scope=${ads.scope} crosshairHidden=${ads.crosshairHidden}`)

  // --- losing pointer lock must be visible ------------------------------
  await page.evaluate(() => document.exitPointerLock())
  await page.waitForTimeout(400)
  const paused = await page.evaluate(() => !!document.querySelector('.hud-input-paused--show'))
  check('losing pointer lock shows the resume prompt', paused)

  // --- and keys must still register after lock is gone ------------------
  await reset()
  await page.keyboard.down('w')
  await page.waitForTimeout(400)
  const afterUnlock = await page.evaluate(() => window.__probe.sent.filter((i) => i.forward === 1).length)
  await page.keyboard.up('w')
  check('keyboard still registers with pointer lock released', afterUnlock > 3, `${afterUnlock} forward inputs`)
} finally {
  await browser.close()
}

const failed = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
