/*
 * Verifies the Commits pane follows the checkout while it stays open: a
 * commit made after the pane opened appears, and an amend (which rewrites
 * HEAD, as before a force push) replaces the old tip. Then, in tabs mode,
 * it switches to a Files pane (unmounting Commits), commits, and switches
 * back: the new commit must show at once, not at the next poll. Logs every
 * request to the commits route, so a missing read shows as a gap.
 *
 * Needs a running containerless `yaac server` and WORKSPACE_ID, a running
 * workspace of it whose checkout this script commits into. Its commits are
 * reset away at the end, leaving the branch where it found it.
 *
 * Run: WORKSPACE_ID=... node test-playwright-scripts/commits-pane-live.js
 */
import { execFileSync } from 'node:child_process'
import { api, check, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()
const workspaceId = process.env.WORKSPACE_ID
const { projectId } = (await api('/workspace/list')).workspaces.find((w) => w.workspaceId === workspaceId)
const { listing } = await api(`/workspace/${workspaceId}/changes?diff=0&listing=paths`)
const git = (...args) => execFileSync('git', ['-c', 'user.name=PW', '-c', 'user.email=pw@example.com', ...args],
  { cwd: listing.root, encoding: 'utf8' }).trim()

const start = git('rev-parse', 'HEAD')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
  const t0 = Date.now()
  page.on('request', (r) => { if (r.url().includes('/commits')) console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${r.url().replace(origin, '')}`) })
  await page.goto(`${origin}/?${new URLSearchParams({ project: projectId, workspace: workspaceId })}`)
  await page.locator('button[title="Review commits"]').click({ timeout: 30000 })
  await page.locator('[title="Choose the branch this workspace is based on"]').waitFor()
  await page.waitForTimeout(2000)
  const subject = `live ${Date.now()}`
  git('commit', '-q', '--allow-empty', '-m', subject)
  console.log(`committed "${subject}"`)
  const shown = await page.locator(`span[title="${subject}"]`).waitFor({ timeout: 25000 }).then(() => true, () => false)
  check('a new commit appears while the pane is open', shown)
  git('commit', '-q', '--amend', '--allow-empty', '-m', `${subject} amended`)
  console.log('amended')
  const amended = await page.locator(`span[title="${subject} amended"]`).waitFor({ timeout: 25000 }).then(() => true, () => false)
  check('an amended tip replaces the old one', amended && await page.locator(`span[title="${subject}"]`).count() === 0)

  // Away and back: the pane unmounts off-screen, and on its return should
  // show the checkout as it is now, not the log it held when it left.
  if (await page.locator('[aria-label="Tab view"]').count() > 0) await page.locator('[aria-label="Tab view"]').click()
  await page.locator('[aria-label="Browse files"]').click()
  await page.waitForTimeout(1500)
  check('the Commits pane is unmounted behind the Files pane',
    await page.locator('[title="Choose the branch this workspace is based on"]').count() === 0)
  git('commit', '-q', '--allow-empty', '-m', `${subject} while away`)
  console.log('committed while away')
  await page.waitForTimeout(1500)
  const back = Date.now()
  await page.locator('[aria-label="Show commits"]').click()
  await page.locator('[title="Choose the branch this workspace is based on"]').waitFor()
  const away = await page.locator(`span[title="${subject} while away"]`).waitFor({ timeout: 25000 }).then(() => Date.now() - back, () => Infinity)
  check('a commit made while away shows on return within 2s', away < 2000, `${away}ms`)
} finally {
  await browser.close()
  git('reset', '-q', '--keep', start)
}
finish()
