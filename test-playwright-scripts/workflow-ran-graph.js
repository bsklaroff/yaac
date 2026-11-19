/*
 * Verifies that a workflow run shows the graph it ran, folded, above its
 * logs, in real Chromium:
 *   1. A running unattended run's step pane has a "Workflow <name>" fold
 *      above its log, closed at first, with nothing to scroll; opening it
 *      shows the steps as JSON, in the form a workflow is written in, at
 *      full length, taller than the pane, and the pane scrolls past it to a
 *      log at least three quarters of its height.
 *   2. After the named workflow is edited, the fold still shows what the
 *      run started with.
 *   3. Once the run is stopped, its logs view shows the same fold above the
 *      picked step's log.
 * SCREENSHOT_DIR gets ran-graph-step-pane.png and ran-graph-stopped.png.
 *
 * Needs a running containerless `yaac server` with the `yaac` project
 * (PROJECT overrides) registered. Creates a workflow named `ran-graph`
 * and one run of it, stops the run and deletes the workflow at the end;
 * the run stays as a stopped workspace.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/workflow-ran-graph.js
 */
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const { chromium } = requirePlaywright()
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const NAME = 'ran-graph'
// Enough steps that the graph is taller than the pane.
const steps = {
  prep: { run: ['echo prepared'] },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`check${i}`, { run: [`echo check ${i}`], needs: ['prep'] }])),
  serve: { run: ['echo serving', 'sleep 600'], needs: ['prep'] },
}
await api('/workflow/delete', { method: 'POST', body: { project: project.id, name: NAME } }).catch(() => {})
await api('/workflow/create', { method: 'POST', body: { project: project.id, name: NAME, repos: [], steps } })
const workspaceId = await createWorkspace({ project: project.id, workflow: NAME, nonInteractive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const fold = page.locator('details', { has: page.getByText(`Workflow ${NAME}`, { exact: true }) })
const shown = async () => JSON.parse(await fold.locator('pre').textContent())
try {
  await page.goto(`${origin}/?project=${project.id}&workspace=${workspaceId}`)
  const bar = page.getByLabel('Steps')
  await bar.getByRole('button', { name: 'serve' }).click({ timeout: 30_000 })
  await fold.waitFor()
  const scroller = fold.locator('xpath=..')
  const metrics = () => scroller.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }))
  check('step pane: fold is closed at first', !(await fold.locator('pre').isVisible()))
  const closed = await metrics()
  check('step pane: nothing to scroll while folded', closed.scroll <= closed.client, JSON.stringify(closed))
  await fold.getByText(`Workflow ${NAME}`).click()
  check('step pane: fold shows the graph it ran', JSON.stringify(await shown()) === JSON.stringify(steps))
  const pre = await fold.locator('pre').evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }))
  check('step pane: graph at full length', pre.scroll <= pre.client, JSON.stringify(pre))
  const open = await metrics()
  check('step pane: open graph taller than the pane, which scrolls', open.scroll > open.client, JSON.stringify(open))
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
  const [paneBox, foldBox, logBox] = [await scroller.boundingBox(), await fold.boundingBox(), await page.locator('.xterm').last().boundingBox()]
  check('step pane: fold sits above the log', foldBox.y + foldBox.height <= logBox.y + 1)
  check('step pane: scrolled down, the log is in view at three quarters of the pane or more',
    logBox.y >= paneBox.y && logBox.y + logBox.height <= paneBox.y + paneBox.height + 1 && logBox.height >= paneBox.height * 0.7,
    JSON.stringify({ paneBox, logBox }))

  await api('/workflow/edit', { method: 'POST', body: { project: project.id, name: NAME, steps: { other: { run: ['true'] } } } })
  await page.reload()
  await page.getByLabel('Steps').getByRole('button', { name: 'serve' }).click({ timeout: 30_000 })
  await fold.getByText(`Workflow ${NAME}`).click()
  check('step pane: an edit since leaves what ran', JSON.stringify(await shown()) === JSON.stringify(steps))
  await page.screenshot({ path: `${SHOTS}/ran-graph-step-pane.png` })

  await api('/workspace/stop', { method: 'POST', body: { workspaceId } })
  await page.goto(`${origin}/?project=${project.id}&workspace=${workspaceId}`)
  await until(page, () => document.querySelector('[role="group"][aria-label="ran-graph"]') !== null, undefined, 60_000)
  await fold.getByText(`Workflow ${NAME}`).click({ timeout: 30_000 })
  check('stopped run: logs show the graph it ran', JSON.stringify(await shown()) === JSON.stringify(steps))
  await page.screenshot({ path: `${SHOTS}/ran-graph-stopped.png` })
} finally {
  await browser.close()
  await api('/workspace/stop', { method: 'POST', body: { workspaceId } }).catch(() => {})
  await api('/workflow/delete', { method: 'POST', body: { project: project.id, name: NAME } }).catch(() => {})
}
finish()
