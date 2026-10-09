/*
 * Verifies in Chromium (1400x900), against a live server, the sidebar's
 * Stopped section:
 *
 *  1. Its header shows the project's real stopped count (the API's `total`),
 *     not the size of a loaded page.
 *  2. Expanded, it lists one page and loads the next each time the list is
 *     scrolled to its end, until every stopped workspace is listed once.
 *  3. Selecting a stopped row opens it read-only in the main pane, with its
 *     facts and a Restart action, and puts its id in the URL.
 *  4. The search box narrows the section to the server's matches.
 *
 * Needs a running server whose project PROJECT (default `yaac`) has more
 * than one page (50) of stopped workspaces. It changes nothing on the server
 * beyond what the Stopped section's expanded state saves in the browser.
 *
 * Run: [PROJECT=<name or id>] node test-playwright-scripts/stopped-sidebar-scroll-test.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const { total } = await api(`/workspace/list-stopped?project=${project.id}&limit=1`)
if (total <= 50) throw new Error(`${project.name} has ${total} stopped workspaces; seed more than 50`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${project.id}`)

  const section = page.getByRole('group', { name: 'Stopped workspaces' })
  const header = section.locator('button[aria-expanded]').first()
  await header.waitFor({ timeout: 15_000 })
  check('the header shows the real count', (await header.innerText()).includes(String(total)), await header.innerText())
  if (await header.getAttribute('aria-expanded') === 'false') await header.click()

  const rows = section.locator('button[title="Read this workspace\'s conversation"]')
  await rows.first().waitFor({ timeout: 15_000 })
  check('one page is listed at first', await rows.count() === 50, String(await rows.count()))
  for (let i = 0; i < 10 && await rows.count() < total; i++) {
    await rows.last().scrollIntoViewIfNeeded()
    await page.waitForTimeout(800)
  }
  check('scrolling to the end lists every stopped workspace', await rows.count() === total, `${await rows.count()} of ${total}`)

  const pick = rows.nth(3)
  const title = (await pick.locator('span.truncate').first().innerText()).trim()
  await pick.click()
  const pane = page.locator('main', { has: page.getByRole('button', { name: 'Restart' }) })
  await pane.waitFor({ timeout: 10_000 })
  check('a selected stopped row opens read-only in the pane', (await pane.locator('header').innerText()).includes(title), title)
  check('the pane lists its facts', /Stopped|Died/.test(await pane.locator('dl').innerText()))
  check('the URL names the workspace', new URL(page.url()).searchParams.has('workspace'))
  await page.screenshot({ path: path.join(SHOTS, 'stopped-sidebar-pane.png') })

  await page.getByRole('textbox', { name: 'Search workspaces' }).fill(title)
  await page.waitForTimeout(1000)
  check('a search narrows the section to its match', await rows.count() === 1, String(await rows.count()))
  check('the header counts the matches', (await header.innerText()).includes('1'), await header.innerText())
  await page.screenshot({ path: path.join(SHOTS, 'stopped-sidebar-search.png') })
} finally {
  await browser.close()
}
finish()
