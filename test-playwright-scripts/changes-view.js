/*
 * Verifies the Changes pane and the file pane's diff modes in real Chromium
 * (docs/file-editor.md "Changes"):
 *   1. The status bar totals the changed lines; clicking them opens the
 *      Changes pane, its filter focused, listing the changed files as a
 *      flat list, each with its
 *      read-only diff, under a strip breaking the lines down by stage.
 *      Each row badges the stages its changes sit in.
 *   2. Clicking a file's row folds its diff and clicking it again unfolds
 *      it; its name opens the file. "Collapse all changes" folds every
 *      diff, and "Show all changes" opens them again.
 *   3. Cmd/Ctrl-F opens the find bar over the diffs: typing counts and marks
 *      matches across files, Enter steps to the next and scrolls it into
 *      view, Escape closes the bar and clears the marks.
 *   4. A changed file's header shows its +/− and stages. Each diff mode:
 *      `added` tints added lines and hides removed ones, `inline` shows
 *      removed lines as read-only widgets, `changes` folds unchanged
 *      stretches, and `plain` shows none of it. The editor stays editable.
 * SCREENSHOT_DIR gets changes-view.png and diff-<mode>.png.
 *
 * Needs a running containerless `yaac server` with one live workspace of the
 * yaac project whose checkout has a committed, a staged, a modified
 * (unstaged) and an untracked change. README.md must be among the changed
 * files, with a committed and a staged change and a stretch of at least 10
 * unchanged lines between or around them, so `changes` has something to
 * fold. The script reads these but does not make them.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/changes-view.js <workspace-id>
 */
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()

const { workspaces } = await api('/workspace/list')
const wt = workspaces.find((w) => w.workspaceId.startsWith(process.argv[2] ?? '\0'))
if (!wt) {
  console.error('usage: node test-playwright-scripts/changes-view.js <live-workspace-id>')
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const query = new URLSearchParams({ project: wt.projectId, workspace: wt.workspaceId })
await page.goto(`${origin}/?${query}`)

// 1. The status bar's total opens the Changes pane, which breaks it down.
const totals = page.locator('button[title="Review changes"]')
await totals.waitFor({ timeout: 20000 })
const text = await totals.innerText()
check('the status bar shows only the total', /^\+\d+ −\d+$/.test(text.trim()), text)
await totals.click()
const filter = page.locator('[aria-label="Filter changed files"]')
await filter.waitFor()
check('the Changes pane focuses its filter', await filter.evaluate((el) => el === document.activeElement))
check('the Changes pane opens as a flat list',
  await page.getByRole('button', { name: 'Show as a tree', exact: true }).count() === 1)
await page.locator('.diff-hl').first().waitFor({ timeout: 10000 })
check('each changed file shows its diff', await page.locator('.diff-hl').count() >= 3)
const strip = await page.locator('[title="Choose the branch changes are compared against"]').locator('..').innerText()
for (const stage of ['committed', 'staged', 'modified', 'untracked']) {
  check(`the strip names the ${stage} stage`, strip.includes(stage), strip)
}
const readmeBadges = await page.locator('div[title="README.md"] [title="Committed"], div[title="README.md"] [title="Staged"]').count()
check('a file changed in two stages shows both letters', readmeBadges === 2)
await page.screenshot({ path: path.join(SHOTS, 'changes-view.png') })

// 2. Fold one diff from its row, then all of them, then open them all.
const diffs = await page.locator('.diff-hl').count()
/** The number of mounted diffs once it reaches `n`, or as it stands after
 *  2 s. A diff shown again mounts on the observer's next callback, a moment
 *  after the click. */
async function diffCount(n) {
  await page.waitForFunction((want) => document.querySelectorAll('.diff-hl').length === want, n, { timeout: 2000 })
    .catch(() => {})
  return page.locator('.diff-hl').count()
}
await page.locator('div[title="README.md"]').click()
check('clicking a row folds its diff', await diffCount(diffs - 1) === diffs - 1)
await page.locator('div[title="README.md"]').click()
check('clicking it again unfolds it', await diffCount(diffs) === diffs)
await page.screenshot({ path: path.join(SHOTS, 'changes-flat.png') })
await page.getByRole('button', { name: 'Collapse all changes', exact: true }).click()
check('collapsing all changes folds every diff', await diffCount(0) === 0)
await page.getByRole('button', { name: 'Show all changes', exact: true }).click()
check('showing all changes unfolds them', await diffCount(diffs) === diffs)

// 3. Find across the diffs. "e" is in nearly every diff.
await page.locator('.diff-hl').first().click()
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
const find = page.getByRole('textbox', { name: 'Find', exact: true })
check('Cmd/Ctrl-F opens the find bar', await find.evaluate((el) => el === document.activeElement))
await find.fill('e')
const status = find.locator('xpath=..').getByRole('status')
await status.filter({ hasText: /^1 of \d+/ }).waitFor({ timeout: 5000 }).catch(() => {})
check('typing counts the matches and lands on the first', /^1 of \d+/.test(await status.innerText()), await status.innerText())
await find.press('Enter')
check('Enter steps to the next match', /^2 of /.test(await status.innerText()), await status.innerText())
check('the current match is in view', await page.locator('[data-find-current]').first().isVisible())
await page.screenshot({ path: path.join(SHOTS, 'changes-find.png') })
await find.press('Escape')
check('Escape closes the bar and clears the marks',
  await find.count() === 0 && await page.locator('[data-find-current]').count() === 0)

// 4. The file pane's header and diff modes.
await page.locator('button[title="Open README.md"]').click()
const editor = page.locator('.cm-editor').last()
await editor.waitFor({ timeout: 10000 })
const header = page.locator('div:has(> span[title="README.md"])').last()
check('the file header shows its stages', /committed/.test(await header.innerText()), await header.innerText())

async function mode(label) {
  await page.locator('[aria-label="Diff mode"]').last().click()
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.waitForTimeout(800)
}
const count = (sel) => editor.locator(sel).count()
const shown = (sel) => editor.locator(sel).evaluateAll((els) => els.filter((e) => e.offsetHeight > 0).length)

await mode('Added lines')
// The first diff mode waits on the file's text at the base.
const tinted = await editor.locator('.cm-changedLine').first().waitFor({ timeout: 10000 }).then(() => true, () => false)
check('added: added lines are tinted', tinted)
check('added: removed lines are hidden', await shown('.cm-deletedChunk') === 0)
await page.screenshot({ path: path.join(SHOTS, 'diff-added.png') })

await mode('Added and removed lines')
check('inline: removed lines show', await shown('.cm-deletedChunk') > 0)
check('inline: removed lines are not editable',
  await editor.locator('.cm-deletedChunk').first().evaluate((el) => !el.isContentEditable))
await page.screenshot({ path: path.join(SHOTS, 'diff-inline.png') })

await mode('Changed parts only')
check('changes: unchanged stretches fold away', await count('.cm-collapsedLines') > 0)
await page.screenshot({ path: path.join(SHOTS, 'diff-changes.png') })

await mode('File only')
check('plain: no diff decorations', await count('.cm-changedLine') === 0 && await count('.cm-deletedChunk') === 0)
check('the editor stays editable', await editor.locator('.cm-content').getAttribute('contenteditable') === 'true')
await page.screenshot({ path: path.join(SHOTS, 'diff-plain.png') })

await browser.close()
finish()
