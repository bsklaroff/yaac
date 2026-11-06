/*
 * Verifies the Commits pane in real Chromium:
 *   1. The git status strip's "N ahead of, M behind <base>" opens the pane,
 *      which lists HEAD's commits and the base branch's beside a graph:
 *      one dot per commit, a merge drawn across two lanes, the HEAD branch
 *      and origin/main as ref pills, and the commit only origin/main has
 *      dimmed.
 *   2. The base picker lists origin's branches, the current base first. A
 *      pick asks for confirmation; Cancel changes nothing, and confirming
 *      records it as the workspace's base and relabels the strip.
 *   3. A commit's chevron unfolds its message. Clicking a commit opens it in
 *      a Changes pane under its message; ticking two opens their range; the
 *      context menu compares one with the working tree; and the workspace's
 *      own Changes pane offers Compare… from its base.
 *   4. On a phone-sized viewport the overflow menu's Commits item opens it,
 *      and with 18 branches open at once the graph keeps to its share of the
 *      row: every subject keeps its room, ages stay on one line, and the HEAD
 *      branch's label stays clear of the sha.
 * SCREENSHOT_DIR gets commits-pane.png, commits-confirm.png,
 * commits-picked.png, commits-expanded.png, commits-show.png,
 * commits-range.png and commits-mobile.png. The project's origin needs a
 * branch besides the workspace's base.
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
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()
const PROJECT = process.env.PROJECT ?? 'yaac'
const owned = !process.env.WORKSPACE_ID
const workspaceId = process.env.WORKSPACE_ID ?? await createWorkspace({ project: PROJECT, noSession: true, title: 'PW commits pane' })
const { projectId, baseBranch } = (await api('/workspace/list')).workspaces.find((w) => w.workspaceId === workspaceId)
const TRIGGER = '[title="Choose the branch this workspace is based on"]'

if (owned) {
  const { listing } = await api(`/workspace/${workspaceId}/changes?diff=0&listing=paths`)
  const git = (...args) => execFileSync('git', ['-c', 'user.name=PW', '-c', 'user.email=pw@example.com', ...args],
    { cwd: listing.root, encoding: 'utf8' }).trim()
  const fork = git('rev-parse', 'HEAD')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  writeFileSync(path.join(listing.root, 'pw-ours.txt'), 'ours\n')
  git('add', 'pw-ours.txt')
  git('commit', '-q', '-m', 'ours: first', '-m', 'Why ours came first.\n\n- one reason\n- another')
  git('checkout', '-q', '-b', 'feature', fork)
  writeFileSync(path.join(listing.root, 'pw-feature.txt'), 'feature\n')
  git('add', 'pw-feature.txt')
  git('commit', '-q', '-m', 'feature: first')
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
  const list = page.locator(TRIGGER).locator('xpath=../../div[2]')
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

  // 2. Base the workspace on another of origin's branches.
  const trigger = page.locator(TRIGGER)
  await trigger.click()
  const picker = page.getByRole('listbox')
  await picker.waitFor()
  await picker.getByRole('option').nth(1).waitFor({ timeout: 15000 })
  const options = (await picker.getByRole('option').allInnerTexts()).map((o) => o.replace(/\s+default$/, ''))
  check('the picker lists origin\'s branches, the current base first',
    options[0] === baseBranch && options.every((o) => !o.startsWith('origin/')), options.slice(0, 5).join(', '))
  const other = options[1]
  await picker.getByRole('option').nth(1).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.waitFor()
  check('a pick asks first', (await dialog.innerText()).includes(`Base this workspace on origin/${other}?`))
  await page.screenshot({ path: path.join(SHOTS, 'commits-confirm.png') })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await dialog.waitFor({ state: 'detached' })
  check('Cancel leaves the base', (await trigger.innerText()).includes(`origin/${baseBranch}`))

  await trigger.click()
  await picker.getByRole('option', { name: other, exact: false }).first().click()
  const posted = page.waitForResponse((r) => r.url().endsWith(`/workspace/${workspaceId}/base`))
  await dialog.getByRole('button', { name: 'Change base' }).click()
  check('confirming records the base', (await (await posted).json()).baseBranch === other)
  await page.locator(TRIGGER, { hasText: `origin/${other}` }).waitFor({ timeout: 10000 })
  check('the strip names the new base', true)
  const named = await Promise.all([
    page.locator(`span[title="origin/${other}"]`).first().waitFor({ timeout: 15000 }).then(() => true, () => false),
    strip.filter({ hasText: `origin/${other}` }).waitFor({ timeout: 15000 }).then(() => true, () => false),
  ])
  check('the list marks the new base and the status bar compares against it', named.every(Boolean),
    `${named} / ${await strip.innerText()}`)
  await page.screenshot({ path: path.join(SHOTS, 'commits-picked.png') })
  if (!owned) await api(`/workspace/${workspaceId}/base`, { method: 'POST', body: { branch: baseBranch } })

  // 3. Messages, a shown commit, a ticked range, and the context menu.
  await row('ours: first').getByRole('button', { name: 'Show the message' }).click()
  await page.getByText('Why ours came first.').waitFor({ timeout: 5000 })
  check('a chevron unfolds the message', await page.getByText('- one reason').count() === 1)
  await page.screenshot({ path: path.join(SHOTS, 'commits-expanded.png') })

  await page.locator('span[title="ours: first"]').click()
  const shown = page.locator('div.font-medium', { hasText: 'ours: first' })
  await shown.waitFor({ timeout: 15000 })
  check('a click shows the commit under its message', await page.locator('[title="pw-ours.txt"]').count() > 0)
  check('its pane compares from the parent', (await page.locator('[title="Compare from"]').first().innerText()).includes('parent'))
  await page.screenshot({ path: path.join(SHOTS, 'commits-show.png') })

  // Each pane opens in a column of its own, so the Commits pane stays in view.
  await row('ours: first').getByRole('checkbox').check()
  await row('feature: first').getByRole('checkbox').check()
  const compare = page.getByRole('button', { name: /^Compare [0-9a-f]{7} → [0-9a-f]{7}$/ })
  await compare.waitFor({ timeout: 5000 })
  await compare.click()
  // Made in one second, either may list as the newer; the range holds only
  // the newer one's file, since their merge base is the fork.
  const range = page.locator('[title="Compare from"]').last().locator('xpath=ancestor::div[contains(@class, "flex-col")][1]')
  await range.locator('[title="pw-feature.txt"], [title="pw-ours.txt"]').first().waitFor({ timeout: 15000 })
  const files = await range.locator('[title="pw-feature.txt"], [title="pw-ours.txt"]').count()
  check('two ticked commits open their range', files === 1, String(files))
  await page.screenshot({ path: path.join(SHOTS, 'commits-range.png') })

  await row('ours: first').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Compare with working tree' }).click()
  await page.locator('[title="Compare to"]', { hasText: 'Working tree' }).waitFor({ timeout: 15000 })
  check('the context menu compares with the working tree', true)

  await page.locator('button[title="Review changes"]').click()
  await page.getByRole('button', { name: 'Compare…' }).click()
  await page.locator('[title="Compare from"]', { hasText: other }).waitFor({ timeout: 15000 })
  check('the own Changes pane opens a range from its base', true)

  // 4. A phone opens it from the overflow menu.
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
      const [, graph, text, , age, sha] = r.children
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
