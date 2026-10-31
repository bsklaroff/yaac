/*
 * Verifies that the ACP chat composer refits its height when its width
 * changes. The page loads at a very narrow phone width, where the empty box's
 * placeholder wraps onto several lines, then widens to a normal phone; the
 * box must shrink back to one line instead of keeping the narrow height
 * until the user types. A web view first laid out narrow, a rotation, or a
 * tiles column being widened all do the same thing.
 *
 * Needs a running `yaac server` with a live ACP workspace (`yaac workspace
 * create <project> --tool claude --mode acp`). WORKSPACE_ID picks one when
 * there are several.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/acp-composer-refit.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.conversations.some((a) => a.mode === 'acp' && a.active)
  && w.workspaceId.startsWith(process.env.WORKSPACE_ID ?? ''))
if (!workspace) throw new Error('no live acp workspace — yaac workspace create <project> --mode acp')

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 120, height: 844 }, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  await page.goto(`${origin}/?project=${workspace.projectId}&workspace=${workspace.workspaceId}`)
  const box = page.locator('textarea[placeholder]').first()
  await box.waitFor({ state: 'attached', timeout: 30_000 })
  await page.waitForTimeout(1500)
  const narrow = (await box.boundingBox()).height
  check('the placeholder wraps in a very narrow box', narrow > 60, `${narrow}px`)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(1500)
  const wide = (await box.boundingBox()).height
  await page.screenshot({ path: path.join(SHOTS, 'acp-composer-refit.png') })
  // One line of 16px text plus the box's padding is well under 60px.
  check('the empty box shrinks to one line once the pane widens', wide < 60, `${wide}px`)
} finally {
  await browser.close()
}
finish()
