/*
 * Measures what one server snapshot frame costs the page: how many
 * function/class components React re-renders when a frame changes one
 * workspace row, counted through a stub DevTools hook (deterministic, so
 * before/after comparisons need no repeated runs), plus the time from each
 * frame's arrival to the next paint under 4x CPU throttling, as median and
 * p95.
 *
 * The page sits on PROJECT with its first workspace open. The script drives
 * the frames itself by renaming the project's last workspace FRAMES times,
 * so it needs at least two running workspaces; it puts the old title back
 * when done. Every `/events` frame in that window counts toward the
 * per-frame figure, including any the server pushes on its own.
 *
 * Run: PROJECT=<name or id> node test-playwright-scripts/snapshot-frame-render-perf.js
 * (PROJECT defaults to yaac; FRAMES sets how many renames, default 40; TOP=<n>
 * also lists the n components rendered most per frame, named only on a dev
 * build since production minifies them;
 * APP_URL points it at a vite dev server, whose hot reload makes comparing
 * render counts across a source edit quick. Take timings from a production
 * build: dev React is several times slower.)
 */
import { api, newWorkspaceButton, origin, requirePlaywright, resolveProject } from './lib.js'

const PROJECT = (await resolveProject(process.env.PROJECT ?? 'yaac')).id
const FRAMES = Number(process.env.FRAMES ?? 40)

const workspaces = (await api('/workspace/list')).workspaces.filter((w) => w.projectId === PROJECT)
if (workspaces.length < 2) throw new Error(`project ${PROJECT} needs two running workspaces`)
const [open, renamed] = [workspaces[0], workspaces.at(-1)]

/*
 * React calls the DevTools hook's onCommitFiberRoot after every commit, even
 * in a production build. A component fiber (function, class, forwardRef,
 * memo) with the PerformedWork flag (1) rendered in that commit. A subtree
 * React skipped keeps its child pointer and stale flags, so, as React
 * DevTools does, the walk does not descend where the child is unchanged.
 */
function installRenderCounter() {
  window.__renders = 0
  window.__names = new Map()
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])
  const nameOf = (f) => {
    const t = f.type?.type ?? f.type?.render ?? f.type
    return t?.displayName ?? t?.name ?? '?'
  }
  const countFibers = (fiber) => {
    for (let f = fiber; f; f = f.sibling) {
      if (COMPONENT_TAGS.has(f.tag) && (f.flags & 1)) {
        window.__renders++
        const n = nameOf(f)
        window.__names.set(n, (window.__names.get(n) ?? 0) + 1)
      }
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

/* Time from each `/events` message to the frame after it. */
function installFrameTimer() {
  window.__frameMs = []
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args)
      if (!String(args[0]).includes('/events')) return
      this.addEventListener('message', () => {
        const t0 = performance.now()
        requestAnimationFrame(() => setTimeout(() => window.__frameMs.push(performance.now() - t0)))
      })
    }
  }
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const title = renamed.title ?? ''
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await context.addInitScript(installRenderCounter)
  await context.addInitScript(installFrameTimer)
  const page = await context.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  let frames = 0
  page.on('websocket', (ws) => {
    if (ws.url().includes('/events')) ws.on('framereceived', () => frames++)
  })
  await page.goto(`${origin}/?project=${PROJECT}&workspace=${open.workspaceId}`)
  await newWorkspaceButton(page).waitFor({ timeout: 15_000 })
  await page.waitForTimeout(3000)

  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const before = await page.evaluate(() => {
    window.__names.clear()
    window.__frameMs = []
    return window.__renders
  })
  const framesBefore = frames
  for (let i = 0; i < FRAMES; i++) {
    await api(`/workspace/${renamed.workspaceId}/title`, { method: 'POST', body: { title: `perf ${i}` } })
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(1000)
  const { renders, names, frameMs } = await page.evaluate(() => ({
    renders: window.__renders, names: [...window.__names], frameMs: window.__frameMs,
  }))
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })

  const n = frames - framesBefore
  const sorted = [...frameMs].sort((a, b) => a - b)
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1)
  console.log(`snapshot frames:                  ${n}`)
  console.log(`components rendered / frame:      ${((renders - before) / n).toFixed(1)}`)
  console.log(`frame to paint (4x CPU) med, p95: ${pct(0.5)} ms, ${pct(0.95)} ms`)
  if (process.env.TOP) {
    console.log('\nmost rendered per frame:')
    for (const [name, count] of names.sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOP))) {
      console.log(`  ${(count / n).toFixed(1).padStart(6)}  ${name}`)
    }
  }
} finally {
  await api(`/workspace/${renamed.workspaceId}/title`, { method: 'POST', body: { title } }).catch(() => {})
  await browser.close()
}
