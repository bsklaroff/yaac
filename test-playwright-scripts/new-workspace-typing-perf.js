/*
 * Measures what one keystroke in the new-workspace prompt costs, with real
 * keyboard events. Prints, per keystroke:
 *
 *  - components rendered: function/class components React re-rendered in
 *    the commits the keystroke caused, counted through a stub DevTools hook
 *    (deterministic, so before/after comparisons need no repeated runs);
 *  - latency: keydown to the frame after it, under 4x CPU throttling, as
 *    median and p95.
 *
 * Read-only: types into the pane, then clears the prompt.
 *
 * Run: PROJECT=<name or id> node test-playwright-scripts/new-workspace-typing-perf.js
 * (PROJECT defaults to yaac; KEYS sets how many keystrokes, default 120;
 * APP_URL points it at a vite dev server, whose hot reload makes comparing
 * render counts across a source edit quick. Take latency from a production
 * build: dev React is several times slower.)
 */
import { origin, requirePlaywright, resolveProject, newWorkspaceButton } from './lib.js'

const PROJECT = (await resolveProject(process.env.PROJECT ?? 'yaac')).id
const KEYS = Number(process.env.KEYS ?? 120)

/*
 * React calls the DevTools hook's onCommitFiberRoot after every commit, even
 * in a production build. A component fiber (function, class, forwardRef,
 * memo) with the PerformedWork flag (1) rendered in that commit. A subtree
 * React skipped keeps its child pointer and stale flags, so, as React
 * DevTools does, the walk does not descend where the child is unchanged.
 */
function installRenderCounter() {
  window.__renders = 0
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])
  const countFibers = (fiber) => {
    for (let f = fiber; f; f = f.sibling) {
      if (COMPONENT_TAGS.has(f.tag) && (f.flags & 1)) window.__renders++
      if (f.child && (!f.alternate || f.child !== f.alternate.child)) countFibers(f.child)
    }
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id },
    onCommitFiberRoot(_id, root) { countFibers(root.current) },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  }
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await context.addInitScript(installRenderCounter)
  const page = await context.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}`)
  await newWorkspaceButton(page).waitFor({ timeout: 15_000 })
  await newWorkspaceButton(page).click()
  const prompt = page.getByLabel('Prompt')
  await prompt.waitFor()
  await prompt.fill('')
  await prompt.click()
  await page.waitForTimeout(1000)

  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })

  // Each keydown records the time to the frame after it.
  await page.evaluate(() => {
    window.__latencies = []
    document.addEventListener('keydown', (e) => {
      const t0 = e.timeStamp
      requestAnimationFrame(() => setTimeout(() => window.__latencies.push(performance.now() - t0)))
    }, { capture: true })
  })

  const before = await page.evaluate(() => window.__renders)
  const text = 'the quick brown fox jumps over the lazy dog '.repeat(Math.ceil(KEYS / 44)).slice(0, KEYS)
  for (const ch of text) {
    await page.keyboard.type(ch)
    await page.waitForTimeout(40)
  }
  await page.waitForTimeout(500)
  const { renders, latencies } = await page.evaluate(() => ({ renders: window.__renders, latencies: window.__latencies }))
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })

  const sorted = [...latencies].sort((a, b) => a - b)
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1)
  console.log(`keystrokes:                   ${KEYS}`)
  console.log(`components rendered / key:    ${((renders - before) / KEYS).toFixed(1)}`)
  console.log(`latency (4x CPU) median, p95: ${pct(0.5)} ms, ${pct(0.95)} ms`)
  await prompt.fill('')
} finally {
  await browser.close()
}
