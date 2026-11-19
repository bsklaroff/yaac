/*
 * Verifies the sidebar's status strip (git-auth failure, image builds, plan
 * usage, server) and the New workspace row above it.
 *
 *  1. With usage cleared from the snapshot (and no other chits), the strip
 *     is a single rule: no height, a top border and no bottom one.
 *  2. New workspace is `aria-current` while the new-workspace pane shows.
 *  3. With a git-auth failure and a failed build for every project, usage
 *     (pinned to a model's weekly limit, the widest readout) and the server
 *     badge injected, at the 180px minimum and the 256px default, in project
 *     scope and on Home: the strip has a rule above and below, holds one chit
 *     of each kind (Home collapses its projects), keeps them on one line, and
 *     clips none of them. Each keeps at least its icon, the usage percentage
 *     stays whole, and the server name gives up its room first. The usage
 *     readout has no pill background, and every chit has hover text.
 *  4. At 180px the New workspace label is not truncated: its shortcut hides.
 *
 * Usage, the failures and the build are faked by rewriting snapshot frames
 * in flight, and the server badge by a stub `window.yaacWindow`, so no
 * credential, failing build or desktop shell is needed.
 *
 * Needs a running server with at least two projects (for Home).
 * Run: YAAC_DATA_DIR=<data dir> node test-playwright-scripts/sidebar-header-rows-test.js
 */
import path from 'node:path'
import { requirePlaywright, origin, check, finish, SHOTS, newWorkspaceButton } from './lib.js'

let inject = 'none'
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

await page.routeWebSocket(/\/api\/events$/, (route) => {
  const server = route.connectToServer()
  server.onMessage((message) => {
    const parsed = typeof message === 'string' ? JSON.parse(message) : null
    if (parsed?.type !== 'snapshot') {
      route.send(message)
      return
    }
    const d = parsed.data
    d.planUsage = {}
    d.codexPlanUsage = {}
    if (inject === 'all') {
      const ids = d.projects.map((p) => p.id)
      const fake = [{ host: 'github.com', status: 401, atMs: 1_784_000_000_000 }]
      d.gitAuthFailures = Object.fromEntries(ids.map((id) => [id, fake]))
      d.imageBuilds = ids.map((id) => ({
        id: `fake-${id}`, tag: 'yaac-base:fake', layer: 'base', projectIds: [id], reason: 'session',
        status: 'failed', startedAt: '2026-01-01 00:00:00', finishedAt: '2026-01-01 00:01:00',
      }))
      d.planUsage = {
        '00000000-0000-0000-0000-000000000000': {
          available: true, subscriptionType: 'max', rateLimitTier: null,
          limits: [
            { kind: 'session', percent: 42, severity: 'normal', resetsAt: null, modelName: null },
            { kind: 'weekly_scoped', percent: 100, severity: 'normal', resetsAt: null, modelName: 'Opus' },
          ],
        },
      }
    }
    route.send(JSON.stringify(parsed))
  })
})

/** The strip (the sibling just above the scrolling list) and its chits. */
const geometry = () => page.locator('aside').first().evaluate((el) => {
  const strip = el.querySelector('.overflow-y-auto').previousElementSibling
  const style = getComputedStyle(strip)
  const box = strip.getBoundingClientRect()
  const inner = { left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight) }
  const chits = [...strip.children].map((c) => {
    const r = c.getBoundingClientRect()
    return { label: c.getAttribute('aria-label'), left: r.left, right: r.right, width: r.width, mid: r.top + r.height / 2 }
  })
  const serverText = el.querySelector('[aria-label="Choose a server"] span')
  const usage = el.querySelector('[aria-label="Show plan usage"]')
  const percent = usage?.lastElementChild.getBoundingClientRect()
  return {
    height: box.height,
    borderTop: style.borderTopWidth,
    borderBottom: style.borderBottomWidth,
    chits,
    clipped: chits.filter((c) => c.left < inner.left - 0.5 || c.right > inner.right + 0.5 || c.width < 18)
      .map((c) => `${c.label} ${Math.round(c.left)}-${Math.round(c.right)} of ${Math.round(inner.left)}-${Math.round(inner.right)}`),
    oneLine: chits.length === 0 || Math.max(...chits.map((c) => c.mid)) - Math.min(...chits.map((c) => c.mid)) <= 1,
    usageBg: getComputedStyle(el.querySelector('[aria-label="Show plan usage"]') ?? el).backgroundColor,
    serverShrunk: serverText ? serverText.scrollWidth > serverText.clientWidth : null,
    percentWhole: percent ? percent.right <= usage.getBoundingClientRect().right + 0.5 : null,
    untitled: [...strip.children].filter((c) => !c.title && c.getAttribute('aria-label') !== 'Show plan usage')
      .map((c) => c.getAttribute('aria-label')),
  }
})

const newWorkspace = newWorkspaceButton(page)

await page.goto(`${origin}/`)
await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
await page.waitForTimeout(3000)
let g = await geometry()
check('an empty strip is a single rule', g.chits.length === 0 && g.height === 1 && g.borderTop === '1px'
  && g.borderBottom === '0px', `chits=${g.chits.length} height=${g.height} top=${g.borderTop} bottom=${g.borderBottom}`)
await page.locator('aside').first().screenshot({ path: path.join(SHOTS, 'sidebar-strip-empty.png') })

await newWorkspace.click()
check('New workspace is aria-current while its pane shows', await newWorkspace.getAttribute('aria-current') === 'true')

inject = 'all'
await page.addInitScript(() => { window.yaacWindow = { showServers: '/' } })
await page.evaluate(() => localStorage.setItem('yaac.pinnedusage.v1', 'claude:weekly_scoped:Opus'))
for (const width of [180, 256]) {
  await page.evaluate((w) => localStorage.setItem('yaac.sidebarwidth.v1', String(w)), width)
  for (const scope of ['project', 'home']) {
    await page.reload()
    await page.getByLabel('Git authentication failed').waitFor({ timeout: 15_000 })
    if (scope === 'home') {
      await page.getByRole('button', { name: 'Home' }).click()
      await page.waitForTimeout(500)
    }
    g = await geometry()
    const at = `${scope} at ${width}px`
    check(`${at}: a rule above and below`, g.borderTop === '1px' && g.borderBottom === '1px')
    check(`${at}: one chit of each kind`, g.chits.length === 4, g.chits.map((c) => c.label).join(', '))
    check(`${at}: on one line`, g.oneLine)
    check(`${at}: no chit clipped`, g.clipped.length === 0, g.clipped.join(', '))
    check(`${at}: the usage percentage stays whole`, g.percentWhole === true)
    check(`${at}: every chit has hover text`, g.untitled.length === 0, g.untitled.join(', '))
    if (width === 180) check(`${at}: the server name gives up its room`, g.serverShrunk === true)
    await page.locator('aside').first().screenshot({ path: path.join(SHOTS, `sidebar-strip-${scope}-${width}.png`) })
  }
}
check('the usage readout has no pill background', g.usageBg === 'rgba(0, 0, 0, 0)', g.usageBg)

await page.evaluate(() => localStorage.setItem('yaac.sidebarwidth.v1', '180'))
await page.reload()
await newWorkspace.waitFor({ timeout: 15_000 })
const label = await newWorkspace.evaluate((b) => {
  const span = [...b.querySelectorAll('span')].find((s) => s.textContent === 'New workspace')
  return { truncated: span.scrollWidth > span.clientWidth, kbd: b.querySelector('kbd')?.getBoundingClientRect().width ?? 0 }
})
check('at 180px the label is whole and the shortcut hidden', !label.truncated && label.kbd === 0, JSON.stringify(label))

await browser.close()
finish()
