/*
 * Verifies how the header's Preview control shows a forwarded port, in
 * Chromium posing as the desktop app (an "Electron" user agent plus a stub
 * `window.yaacWindow` bridge whose `onForwardRemaps` the script drives):
 *
 *  1. With no remap the button reads `Preview :<port>` with no arrow; once
 *     the bridge reports a remap it reads `:<port>→:<local>`, the pane tab
 *     follows, and both go back when the remap clears.
 *  2. At a wide width, the label and the mono port share a text baseline,
 *     measured two ways: a zero-height inline-block probe at the end of
 *     each run, and each text Range's top plus its font's ascent. The same
 *     is measured with the run split into two flex items, for contrast. The
 *     button's height must stay within half a pixel of the split layout's.
 *  3. Below 1024px the button drops the word "Preview" and the port shows
 *     whole. A long remap (`:<port>→:30001`) fits the header at a narrow
 *     desktop width, truncating if it must. On a phone (iPhone bridge,
 *     390px) the ⋯ menu's Preview rows fit the popup and carry no arrow,
 *     since the phone holds its own port only while its preview is open.
 *     With two or more ports, the desktop port menu and the pane's port
 *     select carry the arrow.
 *
 * Zoomed screenshots (deviceScaleFactor 4) go to $SCREENSHOT_DIR (default
 * /tmp/yaac-shots), as preview-label-*.png.
 *
 * Needs a running tui workspace in PROJECT forwarding at least one port.
 * Under containerless that is any listener in its process tree, e.g. run
 * `python3 -m http.server 3000 --bind 127.0.0.1` in a workspace shell (the
 * server's port sweep uses lsof). Start a second listener to cover the
 * several-port cases. The first such workspace is used; set WORKSPACE=<id>
 * to pick another.
 *
 * Run: PROJECT=<name or id> node test-playwright-scripts/preview-port-label.js
 */
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

if (!process.env.PROJECT) throw new Error('set PROJECT=<name or id>')
const PROJECT = (await resolveProject(process.env.PROJECT)).id
const { workspaces } = await api(`/workspace/list?project=${PROJECT}`)
const ws = workspaces.find((w) => process.env.WORKSPACE
  ? w.workspaceId.startsWith(process.env.WORKSPACE)
  : w.forwardedPorts.length > 0 && w.agentSessions?.[0]?.mode === 'tui')
if (!ws) throw new Error(`no running tui workspace in ${PROJECT} forwarding a port`)
const ports = ws.forwardedPorts
const [first] = ports
const ARROW = '→'
const url = `${origin}/?project=${PROJECT}&workspace=${ws.workspaceId}`
const ELECTRON_UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Electron/33.0.0'

/* A bridge whose remap table the page can set with `window.__setRemaps`. */
function installBridge({ iphone }) {
  const subs = new Set()
  window.__remaps = []
  window.__previews = []
  window.__setRemaps = (r) => { window.__remaps = r; subs.forEach((cb) => cb(r)) }
  window.yaacWindow = {
    openExternal: () => {},
    onForwardRemaps: (cb) => { subs.add(cb); cb(window.__remaps); return () => subs.delete(cb) },
    ...(iphone ? { openPreview: (id, p) => window.__previews.push(p) } : {}),
  }
}

const remapTo = (local) => [{ workspaceId: ws.workspaceId, ...first, localPort: local }]

/*
 * Baselines of the label text and the mono port inside the Preview button.
 * `split` lays the run out as two flex items for comparison.
 */
function measure(split) {
  const btn = document.querySelector('button[aria-label="Open preview"]')
  const run = btn.querySelector(':scope > span')
  const mono = run.querySelector('.font-mono')
  run.style.display = split ? 'contents' : ''
  const ascent = (el) => {
    const cs = getComputedStyle(el)
    const ctx = document.createElement('canvas').getContext('2d')
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    return ctx.measureText('Hg').fontBoundingBoxAscent
  }
  const rangeBaseline = (textNode, el) => {
    const r = document.createRange()
    r.selectNodeContents(textNode)
    return r.getBoundingClientRect().top + ascent(el)
  }
  const out = {
    label: rangeBaseline(run.firstChild, run),
    port: rangeBaseline(mono.firstChild, mono),
    height: btn.getBoundingClientRect().height,
    lineHeights: [getComputedStyle(run).lineHeight, getComputedStyle(mono).lineHeight],
  }
  if (!split) {
    const probe = () => {
      const p = document.createElement('span')
      p.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
      return p
    }
    const a = probe()
    const b = probe()
    run.firstChild.after(a)
    mono.append(b)
    out.probeLabel = a.getBoundingClientRect().bottom
    out.probePort = b.getBoundingClientRect().bottom
    a.remove()
    b.remove()
  }
  run.style.display = ''
  return out
}

/* Whether the Preview button's label is shown untruncated. */
function portWhole() {
  const run = document.querySelector('button[aria-label="Open preview"] > span')
  return run.scrollWidth <= run.clientWidth
}

/* Whether everything in the header's bar fits it. */
function headerFits() {
  const btn = document.querySelector('button[aria-label="Open preview"]')
  let bar = btn.parentElement
  while (bar && !bar.className.includes('h-8')) bar = bar.parentElement
  const b = bar.getBoundingClientRect()
  const r = btn.getBoundingClientRect()
  return { fits: r.right <= b.right + 0.5 && bar.scrollWidth <= bar.clientWidth, right: r.right, bar: b.right }
}

async function shotButton(page, name) {
  const box = await page.getByRole('button', { name: 'Open preview' }).boundingBox()
  await page.screenshot({
    path: `${SHOTS}/preview-label-${name}.png`,
    clip: { x: box.x - 6, y: box.y - 6, width: box.width + 30, height: box.height + 12 },
  })
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  // (1)-(3) Desktop, one inline Preview button: needs exactly one port.
  if (ports.length === 1) {
    for (const width of [1400, 800, 768]) {
      // Below lg (1024px) the button drops its word, as its neighbors do.
      const wide = width >= 1024
      const ctx = await browser.newContext({ viewport: { width, height: 700 }, deviceScaleFactor: 4, userAgent: ELECTRON_UA })
      await ctx.addInitScript(installBridge, { iphone: false })
      const page = await ctx.newPage()
      page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
      await page.goto(url)
      const button = page.getByRole('button', { name: 'Open preview' })
      await button.waitFor({ timeout: 20_000 })
      const text = () => button.textContent()

      check(`${width}px: unremapped reads Preview :${first.containerPort}`,
        await text() === `Preview :${first.containerPort}`, await text())
      check(`${width}px: the unremapped port shows whole`, await page.evaluate(portWhole))
      if (wide) {
        const plain = await page.evaluate(measure, false)
        const split = await page.evaluate(measure, true)
        console.log(`  ${width}px inline run: ${JSON.stringify(plain)}`)
        console.log(`  ${width}px split flex items: ${JSON.stringify(split)}`)
        check(`${width}px: label and port share a baseline (probe)`,
          Math.abs(plain.probeLabel - plain.probePort) < 0.01, `${plain.probeLabel} vs ${plain.probePort}`)
        check(`${width}px: label and port share a baseline (range + ascent)`,
          Math.abs(plain.label - plain.port) < 0.5, `${plain.label.toFixed(2)} vs ${plain.port.toFixed(2)}`)
        // Within half a CSS pixel: how the two fonts share one line box
        // varies with the fonts installed.
        check(`${width}px: button height unchanged by the inline run`,
          Math.abs(plain.height - split.height) < 0.5, `${plain.height} vs ${split.height}`)
      }
      await shotButton(page, `${width}-plain`)

      await page.evaluate((r) => window.__setRemaps(r), remapTo(30001))
      const long = `Preview :${first.containerPort}${ARROW}:30001`
      await page.getByText(long).first().waitFor({ timeout: 5000 })
      check(`${width}px: a remap reads ${long}`, await text() === long, await text())
      if (wide) {
        const remapped = await page.evaluate(measure, false)
        check(`${width}px: remapped label still shares a baseline`,
          Math.abs(remapped.probeLabel - remapped.probePort) < 0.01, `${remapped.probeLabel} vs ${remapped.probePort}`)
      }
      const fit = await page.evaluate(headerFits)
      check(`${width}px: the long label fits the header, truncated if need be`, fit.fits, JSON.stringify(fit))
      console.log(`  ${width}px remapped port shows whole: ${await page.evaluate(portWhole)}`)
      await shotButton(page, `${width}-remapped`)
      await page.screenshot({ path: `${SHOTS}/preview-label-${width}-header.png`, clip: { x: 0, y: 0, width, height: 40 } })

      await button.click()
      const tab = page.getByText(long, { exact: true })
      await tab.first().waitFor({ timeout: 5000 })
      check(`${width}px: the pane tab reads ${long}`, await tab.count() >= 1)

      await page.evaluate(() => window.__setRemaps([]))
      await page.waitForTimeout(300)
      check(`${width}px: clearing the remap drops the arrow`,
        await text() === `Preview :${first.containerPort}`
          && await page.getByText(new RegExp(ARROW)).count() === 0, await text())
      await ctx.close()
    }
  } else {
    // Several ports: the desktop menu and the pane's select.
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 700 }, deviceScaleFactor: 2, userAgent: ELECTRON_UA })
    await ctx.addInitScript(installBridge, { iphone: false })
    const page = await ctx.newPage()
    await page.goto(url)
    const button = page.getByRole('button', { name: 'Open preview' })
    await button.waitFor({ timeout: 20_000 })
    await page.evaluate((r) => window.__setRemaps(r), remapTo(30001))
    await button.click()
    const items = page.getByRole('menuitem')
    await items.first().waitFor()
    const labels = await items.allTextContents()
    check('the port menu shows the remap', labels[0] === `:${first.containerPort}${ARROW}:30001`
      && labels.slice(1).every((l) => !l.includes(ARROW)), labels.join(' '))
    await page.screenshot({ path: `${SHOTS}/preview-label-menu.png`, clip: { x: 900, y: 0, width: 500, height: 160 } })
    await items.first().click()
    const options = await page.locator('select option').allTextContents()
    check('the pane port select shows the remap', options.includes(`:${first.containerPort}${ARROW}:30001`), options.join(' '))
    await ctx.close()
  }

  // Phone, iPhone bridge: the ⋯ menu's Preview rows.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  await ctx.addInitScript(installBridge, { iphone: true })
  const page = await ctx.newPage()
  await page.goto(url)
  const more = page.getByRole('button', { name: 'More pane actions' })
  await more.waitFor({ timeout: 20_000 })
  await page.evaluate((r) => window.__setRemaps(r), remapTo(30001))
  await more.click()
  const rows = page.getByRole('menuitem').filter({ hasText: 'Preview' })
  await rows.first().waitFor()
  const texts = await rows.allTextContents()
  check('phone: one Preview row per port', texts.length === ports.length, texts.join(' | '))
  if (ports.length > 1) {
    check('phone: the rows name the workspace port alone', texts.every((t) => !t.includes(ARROW)), texts.join(' | '))
  }
  const overflow = await page.evaluate(() => [...document.querySelectorAll('[role=menuitem]')]
    .filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent))
  check('phone: no menu row overflows', overflow.length === 0, overflow.join(' | '))
  const popup = await page.getByRole('menu').boundingBox()
  await page.screenshot({ path: `${SHOTS}/preview-label-phone-menu.png`, clip: popup })
  await ctx.close()
} finally {
  await browser.close()
}
finish()
