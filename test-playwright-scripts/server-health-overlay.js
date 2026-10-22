/*
 * Verifies the Server health overlay (docs/server-health.md): the rail's
 * pulse button (the projects screen's row on mobile) opens it, it shows the
 * totals with their meters, the infrastructure and workspace tables, and on
 * a k8s server the nodes, and hovering a sparkline shows a tooltip once the
 * server holds two minutes of history. Screenshots desktop and mobile to
 * $SCREENSHOT_DIR (default /tmp/yaac-shots).
 *
 * Needs a running `yaac server`, or a cluster's (see lib.js); it creates
 * nothing. Start the server a few minutes before for sparklines to show.
 *
 * Run: node test-playwright-scripts/server-health-overlay.js
 */
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()
const report = await api('/server/usage')
const history = report.totals.history.length

const browser = await chromium.launch()
try {
  for (const [name, viewport] of [['desktop', { width: 1500, height: 900 }], ['mobile', { width: 390, height: 800 }]]) {
    const page = await browser.newPage({ viewport })
    await page.goto(origin)
    const open = page.getByRole('button', { name: 'Server health' })
    await open.first().waitFor({ timeout: 20_000 })
    await open.first().click()

    const dialog = page.getByRole('dialog')
    await dialog.getByText(report.driver === 'k8s' ? 'Cluster' : 'Host', { exact: true }).waitFor({ timeout: 15_000 })
    check(`${name}: totals show CPU and memory meters`,
      await dialog.getByRole('meter', { name: 'CPU in use' }).isVisible()
        && await dialog.getByRole('meter', { name: 'Memory in use' }).isVisible())
    check(`${name}: infrastructure lists the server`,
      await dialog.getByRole('cell', { name: 'yaac server' }).first().isVisible())
    check(`${name}: workspaces section shows`, await dialog.getByText(/^Workspaces \(/).isVisible())
    if (report.driver === 'k8s') {
      check(`${name}: nodes section lists every node`, await dialog.getByText(`Nodes (${report.nodes.length})`).isVisible())
    }
    if (report.totals.disks.length > 0) {
      check(`${name}: a disk row per filesystem`,
        await dialog.getByText(report.totals.disks[0].name, { exact: true }).first().isVisible())
    }
    // Let the dialog's fade-in finish before the screenshot.
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/server-health-${name}.png`, fullPage: true })

    if (history >= 2 && name === 'desktop') {
      const spark = dialog.getByRole('img', { name: /^CPU, last hour/ })
      await spark.hover({ position: { x: 20, y: 12 } })
      const tip = page.getByRole('tooltip')
      await tip.waitFor({ timeout: 3_000 })
      check('desktop: sparkline hover shows a value and time', /cores/.test(await tip.innerText()))
      await page.screenshot({ path: `${SHOTS}/server-health-hover.png` })
    } else if (history < 2) {
      console.log(`  (only ${String(history)} history point(s); skipping the sparkline hover)`)
    }
    await page.keyboard.press('Escape')
    await page.close()
  }
} finally {
  await browser.close()
}
finish()
