/*
 * Verifies the Commits pane in real Chromium:
 *   1. The git status strip's "N ahead of, M behind <base>" opens the pane,
 *      which lists HEAD's commits and the compared branch's beside a graph:
 *      one dot per commit, a merge drawn across two lanes, the HEAD branch
 *      and origin/main as ref pills, and the commit only origin/main has
 *      dimmed.
 *   2. The compare picker lists the checkout's local and origin branches;
 *      picking a local one asks for it by its full ref and relabels the
 *      strip.
 *   3. On a phone-sized viewport the overflow menu's Commits item opens it,
 *      and with 18 branches open at once the graph keeps to its share of the
 *      row: every subject keeps its room, ages stay on one line, and the HEAD
 *      branch's label stays clear of the sha.
 * SCREENSHOT_DIR gets commits-pane.png, commits-picked.png and
 * commits-mobile.png.
 *
 * Needs a running containerless `yaac server` with the `yaac` project
 * (PROJECT overrides) registered. With no WORKSPACE_ID it creates a
 * workspace with no session, commits a small history into its checkout
 * (ours, a merged feature branch, 18 topic branches merged one by one, and
 * a commit standing in for one origin's main gained since the fork), and
 * stops it at the end.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/commits-pane.js
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()
const PROJECT = process.env.PROJECT ?? 'yaac'
const owned = !process.env.WORKSPACE_ID
const workspaceId = process.env.WORKSPACE_ID ?? await createWorkspace({ project: PROJECT, noSession: true, title: 'PW commits pane' })
const { projectId } = (await api('/workspace/list')).workspaces.find((w) => w.workspaceId === workspaceId)

if (owned) {
  const { listing } = await api(`/workspace/${workspaceId}/changes?diff=0&listing=paths`)
  const git = (...args) => execFileSync('git', ['-c', 'user.name=PW', '-c', 'user.email=pw@example.com', ...args],
    { cwd: listing.root, encoding: 'utf8' }).trim()
  const fork = git('rev-parse', 'HEAD')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  git('commit', '-q', '--allow-empty', '-m', 'ours: first')
  git('checkout', '-q', '-b', 'feature', fork)
  git('commit', '-q', '--allow-empty', '-m', 'feature: first')
  git('commit', '-q', '--allow-empty', '-m', 'feature: second')
  git('checkout', '-q', branch)
  git('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature')
  git('commit', '-q', '--allow-empty', '-m', 'ours: after the merge')
  // Every topic commit is older than every merge, so all 18 lanes are open
  // at once across the merges' rows.
  for (let i = 0; i < 18; i++) {
    git('checkout', '-q', '-b', `topic-${i}`, fork)
    git('commit', '-q', '--allow-empty', '-m', `topic ${i}`)
  }
  git('checkout', '-q', branch)
  for (let i = 0; i < 18; i++) git('merge', '-q', '--no-ff', '-m', `Merge topic ${i}`, `topic-${i}`)
  git('checkout', '-q', '--detach', fork)
  git('commit', '-q', '--allow-empty', '-m', 'main: landed upstream')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('checkout', '-q', branch)
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
  await page.goto(`${origin}/?${new URLSearchParams({ project: projectId, workspace: workspaceId })}`)

  // 1. From the strip into the pane.
  const strip = page.locator('button[title="Review commits"]')
  await strip.filter({ hasText: 'behind' }).waitFor({ timeout: 30000 })
  check('the strip says how far HEAD is from origin/main', /ahead of, 1 commit behind\s+origin\/main/.test(await strip.innerText()),
    await strip.innerText())
  await strip.click()
  const row = (subject) => page.locator(`span[title="${subject}"]`).locator('xpath=ancestor::div[1]')
  await page.locator('span[title="ours: after the merge"]').waitFor({ timeout: 15000 })
  for (const s of ['Merge feature', 'feature: second', 'feature: first', 'ours: first', 'main: landed upstream']) {
    check(`lists "${s}"`, await page.locator(`span[title="${s}"]`).count() === 1)
  }
  // The list below the strip; the icons elsewhere are SVGs too.
  const list = page.locator('[title="Choose the branch HEAD is compared against"]').locator('xpath=../../div[2]')
  const dots = await list.locator('svg circle').count()
  const shas = await list.locator('span.font-mono[title]').filter({ hasText: /^[0-9a-f]{7}$/ }).count()
  check('draws one dot per commit', dots === shas && dots > 6, `${dots} dots, ${shas} commits`)
  const width = await row('Merge feature').locator('svg').getAttribute('width')
  check('the graph spans at least two lanes for the merge', Number(width) >= 28, width)
  check('the HEAD branch is a pill', await page.locator('span[title^="HEAD -> "]').count() === 1)
  check('origin/main is a pill', await page.locator('span[title="origin/main"]').count() === 1)
  check('the commit only origin/main has is dimmed',
    (await row('main: landed upstream').getAttribute('class')).includes('text-text-faint'))
  check('our commits are not',
    !(await row('ours: first').getAttribute('class')).includes('text-text-faint'))
  await page.screenshot({ path: path.join(SHOTS, 'commits-pane.png') })

  // 2. Pick a local branch to compare with.
  const trigger = page.locator('[title="Choose the branch HEAD is compared against"]')
  await trigger.click()
  const picker = page.getByRole('listbox')
  await picker.waitFor()
  const options = await picker.getByRole('option').allInnerTexts()
  check('the picker lists local and origin branches',
    options.some((o) => o.startsWith('feature')) && options.some((o) => o.startsWith('origin/')), options.join(', '))
  await page.getByRole('combobox', { name: 'Compare branch' }).fill('origin/main')
  check('the fork branch is tagged as the default',
    (await picker.getByRole('option').first().innerText()).replace(/\s+/g, ' ') === 'origin/main default')
  await page.getByRole('combobox', { name: 'Compare branch' }).fill('')
  const asked = page.waitForRequest((r) => r.url().includes('/commits?') && r.url().includes('base=refs%2Fheads%2Ffeature'))
  await picker.getByRole('option', { name: 'feature', exact: true }).click()
  check('a local branch is asked for by its full ref', Boolean(await asked.catch(() => null)))
  await page.locator('[title="Choose the branch HEAD is compared against"]', { hasText: 'feature' }).waitFor({ timeout: 10000 })
  check('the strip names the pick', (await trigger.innerText()).includes('feature'))
  await page.screenshot({ path: path.join(SHOTS, 'commits-picked.png') })

  // 3. A phone opens it from the overflow menu.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await phone.goto(`${origin}/?${new URLSearchParams({ project: projectId, workspace: workspaceId })}`)
  // Until the workspace is listed the bar is the new-workspace pane's.
  await phone.locator('button[title="Review commits"]').waitFor({ timeout: 30000 })
  await phone.locator('[aria-label="More pane actions"]').click()
  await phone.getByRole('menuitem', { name: 'Commits' }).click()
  await phone.locator('span[title="ours: after the merge"]').waitFor({ timeout: 15000 })
  check('the overflow menu opens the pane on a phone', true)
  const layout = await phone.evaluate(() => {
    // Each row's graph cell is the svg inside its width-capped box.
    const rows = [...document.querySelectorAll('div[style*="max-width: 30%"] > svg')].map((g) => g.parentElement.parentElement)
    const box = (el) => el.getBoundingClientRect()
    return rows.slice(0, 20).map((r) => {
      const [graph, text, , age, sha] = r.children
      const subject = text.lastElementChild
      return {
        graph: box(graph).width / box(r).width,
        subject: box(subject).width,
        age: age.offsetHeight,
        pill: text.firstElementChild === subject ? null : box(text).right <= box(sha).left,
      }
    })
  })
  check('the graph keeps to its share of the row', layout.every((r) => r.graph <= 0.31), JSON.stringify(layout[0]))
  check('every subject keeps its room', layout.every((r) => r.subject >= 60), String(Math.min(...layout.map((r) => r.subject))))
  check('ages stay on one line', layout.every((r) => r.age <= 20), String(Math.max(...layout.map((r) => r.age))))
  check('labels stay clear of the sha', layout.every((r) => r.pill !== false))
  await phone.screenshot({ path: path.join(SHOTS, 'commits-mobile.png') })
} finally {
  await browser.close()
  if (owned) await api('/workspace/stop', { method: 'POST', body: { workspaceId } }).catch(() => {})
}
finish()
