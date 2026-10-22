/*
 * Verifies the desktop app's half of a hidden preview's lifecycle
 * (docs/preview-lifecycle.md) in real Electron: the preload bridge, the
 * main process's IPC checks, and what they do to a real <webview> guest.
 * The preview pane's timers, which decide when to call these, are
 * unit-tested in packages/frontend/test/session-preview.test.tsx.
 *
 *  1. A hidden webview is throttled by Chromium itself: its timers drop to
 *     about one run a second.
 *  2. setPreviewFrozen(id, true) freezes the guest (no timer runs, a
 *     `freeze` event fires), and setPreviewFrozen(id, false) resumes it.
 *  3. canDiscardPreview is true for an untouched page, false once the user
 *     types into it, and true again after it navigates.
 *  4. Neither call acts on a webContents id that is not a webview guest of
 *     the asking window.
 *  5. onMemoryPressure subscribes and unsubscribes through the bridge, and
 *     a machine with memory to spare raises no signal over a few checks.
 *     Critical pressure itself is unit-tested in
 *     packages/desktop/test/memory-pressure.test.ts.
 *
 * The script serves its own guest page on loopback, adds a webview to the
 * SPA's window by hand, and needs no workspace. It launches Electron itself
 * and talks to it over a raw DevTools connection rather than through
 * Playwright, whose Electron launcher turns background throttling off and
 * keeps its own sessions on every page. Needs the desktop bundle
 * (`pnpm --filter @yaac/desktop build`), the Electron binary
 * (`node packages/desktop/node_modules/electron/install.js`), a running
 * server for the shell to land on (see lib.js), an X display, and xdotool
 * to type into the page, e.g.
 *   Xvfb :99 &
 *   DISPLAY=:99 node test-playwright-scripts/desktop-preview-lifecycle.js
 */
import { execSync, spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish } from './lib.js'

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/desktop')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The guest records every 20ms timer run and its lifecycle events.
const GUEST = `<input id=field autofocus><script>
  window.ticks = []; window.events = []
  setInterval(() => ticks.push(Date.now()), 20)
  for (const e of ['freeze', 'resume']) document.addEventListener(e, () => events.push([e, Date.now()]))
</script>`
const site = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(GUEST))
  .listen(0, '127.0.0.1')
await new Promise((r) => site.once('listening', r))
const guestUrl = `http://127.0.0.1:${site.address().port}/`

const electron = spawn(path.join(desktopDir, 'node_modules/electron/dist/electron'),
  ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', '.'],
  { cwd: desktopDir, stdio: ['ignore', 'ignore', 'pipe'] })
const devtools = await new Promise((resolve, reject) => {
  let err = ''
  electron.stderr.on('data', (d) => {
    err += d
    const m = /DevTools listening on ws:\/\/([^/]+)\//.exec(err)
    if (m) resolve(`http://${m[1]}`)
  })
  electron.once('exit', () => reject(new Error(`electron exited:\n${err}`)))
})

/** A DevTools session on one target, by a predicate on /json/list. */
async function session(match, timeout = 60_000) {
  const until = Date.now() + timeout
  for (;;) {
    const target = (await (await fetch(`${devtools}/json/list`)).json()).find(match)
    if (target) {
      const ws = new WebSocket(target.webSocketDebuggerUrl)
      await new Promise((r) => ws.addEventListener('open', r, { once: true }))
      let next = 0
      const pending = new Map()
      ws.addEventListener('message', (e) => {
        const msg = JSON.parse(e.data)
        pending.get(msg.id)?.(msg)
        pending.delete(msg.id)
      })
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++next
        pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
        ws.send(JSON.stringify({ id, method, params }))
      })
      const evaluate = async (expression) => {
        const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
        return result.value
      }
      return { send, evaluate, close: () => ws.close() }
    }
    if (Date.now() > until) throw new Error('no such DevTools target')
    await sleep(250)
  }
}

try {
  const win = await session((t) => t.type === 'page' && /^http/.test(t.url))
  for (let i = 0; !(await win.evaluate('window.yaacWindow?.setPreviewFrozen !== undefined')); i++) {
    if (i > 240) throw new Error('the preload bridge has no setPreviewFrozen')
    await sleep(250)
  }
  const id = await win.evaluate(`(async () => {
    const wv = document.createElement('webview')
    wv.id = 'probe'
    wv.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;z-index:9999'
    wv.setAttribute('src', ${JSON.stringify(guestUrl)})
    document.body.appendChild(wv)
    await new Promise((r) => wv.addEventListener('did-finish-load', r, { once: true }))
    return wv.getWebContentsId()
  })()`)
  const guest = await session((t) => t.type === 'webview' && t.url === guestUrl)
  const ticksOver = async (ms) => {
    const before = await guest.evaluate('ticks.length')
    await sleep(ms)
    return (await guest.evaluate('ticks.length')) - before
  }
  const bridge = (method, ...args) => win.evaluate(`window.yaacWindow.${method}(...${JSON.stringify(args)})`)
  const setVisibility = (v) => win.evaluate(`document.getElementById('probe').style.visibility = '${v}'`)

  // (1)
  check('a shown webview runs its timers', await ticksOver(1000) > 20)
  await setVisibility('hidden')
  await sleep(500)
  const hidden = await ticksOver(3000)
  check('a hidden webview is throttled to about one run a second', hidden <= 5, `${hidden} runs in 3s`)

  // (2)
  check('freezing is accepted', await bridge('setPreviewFrozen', id, true) === true)
  await sleep(3000)
  check('thawing is accepted', await bridge('setPreviewFrozen', id, false) === true)
  const events = await guest.evaluate('events')
  check('the page saw freeze then resume', events.map(([e]) => e).join() === 'freeze,resume')
  const [[, frozeAt], [, resumedAt]] = events
  const whileFrozen = await guest.evaluate(`ticks.filter((t) => t > ${frozeAt} && t < ${resumedAt}).length`)
  check('no timer ran while frozen', whileFrozen === 0 && resumedAt - frozeAt >= 2900,
    `${whileFrozen} runs in ${resumedAt - frozeAt}ms`)
  check('freezing kept the page', (await guest.evaluate('location.href')) === guestUrl)
  await setVisibility('visible')
  await sleep(500)
  check('a shown, thawed page runs again', await ticksOver(1000) > 20)

  // (3)
  check('an untouched page may be discarded', await bridge('canDiscardPreview', id) === true)
  await win.evaluate(`document.getElementById('probe').focus()`)
  await guest.evaluate('document.getElementById("field").focus()')
  // A real keystroke: one sent over DevTools skips before-input-event.
  execSync('for w in $(xdotool search --onlyvisible --class electron); do xdotool windowfocus $w; done; xdotool type a')
  await sleep(300)
  check('typing reaches the page', (await guest.evaluate('document.getElementById("field").value')) === 'a')
  check('a typed-into page is kept', await bridge('canDiscardPreview', id) === false)
  await guest.evaluate('location.reload()')
  await sleep(1500)
  check('a reload clears that', await bridge('canDiscardPreview', id) === true)

  // (4)
  // Every webContents made before the guest (the window's own among them),
  // and an id nothing has.
  for (const n of [...Array.from({ length: id - 1 }, (_, i) => i + 1), 99999]) {
    check(`id ${n} is not a preview guest`, await bridge('canDiscardPreview', n) === false
      && await bridge('setPreviewFrozen', n, true) === false)
  }

  // (5)
  await win.evaluate('window.pressureSignals = 0; window.stopPressure = window.yaacWindow.onMemoryPressure(() => window.pressureSignals++)')
  await sleep(11_000)
  check('a machine with memory to spare raises no pressure signal', await win.evaluate('window.pressureSignals') === 0)
  check('unsubscribing works', await win.evaluate('window.stopPressure(), true'))
  guest.close()
  win.close()
} finally {
  electron.kill()
  site.close()
}
finish()
