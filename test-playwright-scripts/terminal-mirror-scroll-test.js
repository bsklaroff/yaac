/*
 * Verifies the webapp's terminals against a real server
 * (docs/terminal-mirror.md):
 *  1. The agent pane (claude, fullscreen) is restored from its snapshot on
 *     the alternate screen with mouse tracking on, and the wheel over it
 *     sends mouse reports to the app.
 *  2. A new shell's output lands in the browser's own scrollback, and the
 *     wheel scrolls that history locally: the view moves within a frame and
 *     no byte goes to the server.
 *  3. Each pane's grid fills its own column, though tiled columns differ.
 *  4. Cmd/Ctrl-click opens a checkout path in the file editor and a URL in a
 *     new tab; a plain click opens neither.
 *  5. After a reload, the shell's history is back, from the snapshot.
 *
 * Needs a running server (see lib.js) with a running claude workspace:
 * WORKSPACE=<id> picks one, else the first running one of PROJECT (a name or
 * id, default yaac). It opens one shell window in it and leaves it open; a fresh
 * HOME's zsh new-user menu is dismissed first.
 * Screenshots: $SCREENSHOT_DIR/mirror-*.png.
 *
 * Run: node test-playwright-scripts/terminal-mirror-scroll-test.js
 */
import path from 'node:path'
import { api, check, finish, origin, requirePlaywright, resolveProject, SHOTS, until } from './lib.js'

const PROJECT = (await resolveProject(process.env.PROJECT ?? 'yaac')).id
const { workspaces } = await api('/workspace/list')
const ws = workspaces.find((w) => w.workspaceId.startsWith(process.env.WORKSPACE ?? '')
  && w.projectId === PROJECT && w.status !== 'stopped')
if (!ws) {
  console.log(`no running workspace in ${PROJECT}`)
  process.exit(1)
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  // The URL the link test opens, served here so it loads without a network.
  await page.context().route('https://example.com/**', (r) => r.fulfill({ body: 'example' }))
  // Count binary frames (terminal input) the page sends.
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send
    window.__binarySends = 0
    WebSocket.prototype.send = function (data) {
      if (typeof data !== 'string') window.__binarySends++
      return send.call(this, data)
    }
  })
  await page.goto(`${origin}/?project=${ws.projectId}&workspace=${ws.workspaceId}`)

  // 1. The agent pane: fullscreen claude, restored with its modes.
  await until(page, () => [...(window.__xterms ?? [])].some((t) => t.buffer.active.type === 'alternate'))
  const agent = await page.evaluate(() => {
    const t = [...window.__xterms].find((x) => x.buffer.active.type === 'alternate')
    return { mouse: t.modes.mouseTrackingMode, rows: t.rows, cols: t.cols }
  })
  check('agent pane is on the alternate screen with mouse tracking', agent.mouse !== 'none', JSON.stringify(agent))
  const agentBox = await page.locator('.xterm').first().boundingBox()
  await page.mouse.move(agentBox.x + agentBox.width / 2, agentBox.y + agentBox.height / 2)
  const sentBefore = await page.evaluate(() => window.__binarySends)
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -100)
  await page.waitForTimeout(300)
  const reports = await page.evaluate(() => window.__binarySends) - sentBefore
  check('the wheel over the agent sends reports to the app', reports > 0, `${reports} frames`)
  await page.screenshot({ path: path.join(SHOTS, 'mirror-agent.png') })

  // 2. A shell with 3000 lines of history.
  await page.evaluate(() => { window.__before = new Set(window.__xterms) })
  await page.getByTitle('New shell').click()
  await until(page, () => [...window.__xterms].some((t) => !window.__before.has(t)))
  await page.evaluate(() => { window.__shell = [...window.__xterms].find((t) => !window.__before.has(t)) })
  await page.waitForTimeout(1500)
  // A fresh HOME opens zsh's new-user menu; `q` leaves it.
  const newUserMenu = await page.evaluate(() => [...window.__xterms].some((t) => {
    const b = t.buffer.active
    for (let i = 0; i < b.length; i++) if (b.getLine(i)?.translateToString(true).includes('Type one of the keys')) return true
    return false
  }))
  if (newUserMenu) {
    await page.keyboard.type('q')
    await page.waitForTimeout(1000)
  }
  await page.keyboard.type('seq 1 3000\n')
  await until(page, () => {
    const b = window.__shell.buffer.normal
    for (let i = Math.max(0, b.length - 60); i < b.length; i++) {
      if (b.getLine(i)?.translateToString(true).trim() === '3000') return true
    }
    return false
  })
  const shellState = () => {
    const t = window.__shell
    const b = t.buffer.active
    const lines = []
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true).trim())
    return { length: b.length, viewportY: b.viewportY, baseY: b.baseY, has1: lines.includes('1'), has3000: lines.includes('3000'), mouse: t.modes.mouseTrackingMode }
  }
  const before = await page.evaluate(shellState)
  check('the shell history is in the browser\'s scrollback', before?.has1 && before.has3000 && before.length > 3000,
    JSON.stringify(before))
  check('the shell does not track the mouse', before?.mouse === 'none')

  // The wheel over the shell scrolls locally, sending nothing.
  const shellBox = await page.evaluate(() => {
    const r = window.__shell.element.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  await page.mouse.move(shellBox.x + shellBox.width / 2, shellBox.y + shellBox.height / 2)
  const sent = await page.evaluate(() => window.__binarySends)
  const t0 = Date.now()
  await page.mouse.wheel(0, -2000)
  await until(page, (y0) => window.__shell.buffer.active.viewportY < y0, before.viewportY, 5000)
  const scrolledIn = Date.now() - t0
  const after = await page.evaluate(shellState)
  const sentDuring = await page.evaluate(() => window.__binarySends) - sent
  check('the wheel scrolls the shell history locally', after.viewportY < before.viewportY,
    `viewportY ${before.viewportY} -> ${after.viewportY} in ${scrolledIn}ms`)
  check('scrolling sent nothing to the server', sentDuring === 0, `${sentDuring} frames`)
  await page.screenshot({ path: path.join(SHOTS, 'mirror-shell-scrolled.png') })

  // Each pane is sized for its own column: tiled panes differ in size, so a
  // pane sized after another's would leave its grid short of, or past, its
  // column.
  const fill = await page.evaluate(() => [...window.__xterms].map((t) => {
    const screen = t.element.querySelector('.xterm-screen')
    return Math.round((screen.getBoundingClientRect().width / t.element.clientWidth) * 100) / 100
  }))
  check('every pane\'s grid fills its own column', fill.every((f) => f > 0.85 && f <= 1.01), fill.join(', '))

  // Links: Cmd/Ctrl-click opens a checkout file in the editor and a URL in a
  // new tab; a plain click opens neither.
  await page.evaluate(() => window.__shell.scrollToBottom())
  await page.keyboard.type('echo see README.md and https://example.com/x\n')
  await until(page, () => {
    const b = window.__shell.buffer.active
    for (let i = 0; i < b.length; i++) if (b.getLine(i)?.translateToString(true).startsWith('see README.md')) return true
    return false
  })
  const at = (word) => page.evaluate((w) => {
    const t = window.__shell
    const b = t.buffer.active
    // The line may wrap, so join a row with its continuation rows.
    for (let i = b.length - 1; i >= 0; i--) {
      if (b.getLine(i)?.isWrapped) continue
      let text = ''
      for (let j = i; j < b.length && (j === i || b.getLine(j)?.isWrapped); j++) text += b.getLine(j)?.translateToString(false) ?? ''
      const col = text.indexOf(w)
      if (text.startsWith('see ') && col !== -1) {
        const cell = t._core._renderService.dimensions.css.cell
        const r = t._core.screenElement.getBoundingClientRect()
        const row = i + Math.floor(col / t.cols)
        return { x: r.x + ((col % t.cols) + 1.5) * cell.width, y: r.y + (row - b.viewportY + 0.5) * cell.height }
      }
    }
    return null
  }, word)
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  // The URL first: opening a file adds a column, which rewraps the shell.
  const url = await at('https://example.com/x')
  if (url) {
    await page.mouse.move(url.x, url.y)
    await page.waitForTimeout(300)
    // A noopener tab has no opener, so it shows as a new page of the context.
    const popup = page.context().waitForEvent('page', { timeout: 5000 })
      .then(async (p) => { await p.waitForLoadState('commit').catch(() => {}); return p.url() }, () => null)
    await page.keyboard.down(modifier)
    await page.mouse.click(url.x, url.y)
    await page.keyboard.up(modifier)
    const opened = await popup
    check('Ctrl/Cmd-click on a URL opens it in a new tab', opened?.startsWith('https://example.com/x') ?? false, String(opened))
  } else {
    check('the URL is on screen', false)
  }

  const fileTabs = () => page.getByText('README.md', { exact: true }).count()
  const tabsBefore = await fileTabs()
  const readme = await at('README.md')
  await page.mouse.move(readme.x, readme.y)
  await page.waitForTimeout(300)
  await page.mouse.click(readme.x, readme.y)
  await page.waitForTimeout(700)
  check('a plain click on a path opens nothing', await fileTabs() === tabsBefore)
  await page.mouse.move(readme.x + 2, readme.y)
  await page.waitForTimeout(300)
  await page.keyboard.down(modifier)
  await page.mouse.click(readme.x, readme.y)
  await page.keyboard.up(modifier)
  await until(page, () => true)
  await page.waitForTimeout(1500)
  check('Ctrl/Cmd-click on a checkout path opens it in the editor', await fileTabs() > tabsBefore,
    `${tabsBefore} -> ${await fileTabs()}`)
  await page.screenshot({ path: path.join(SHOTS, 'mirror-file-link.png') })
  // 3. A reload restores the history from the snapshot.
  await page.reload()
  await until(page, () => [...(window.__xterms ?? [])].some((t) => {
    const b = t.buffer.normal
    for (let i = 0; i < b.length; i++) if (b.getLine(i)?.translateToString(true).trim() === '1500') return true
    return false
  }), undefined, 30_000)
  check('after a reload the shell history is back', true)
  await page.screenshot({ path: path.join(SHOTS, 'mirror-reloaded.png') })
} catch (err) {
  check(`no step failed: ${String(err)}`, false)
  await browser.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(SHOTS, 'mirror-failed.png') })
} finally {
  await browser.close()
}
finish()
