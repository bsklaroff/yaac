/*
 * Verifies the new-workspace pane and the create flow that follows it, in a
 * real browser with real keyboard and mouse events:
 *
 *  1. With nothing selected the main pane is the new-workspace pane: the chat
 *     composer ("Message the agent…") with its settings above, the prompt
 *     focused, and Create disabled until a prompt is typed.
 *  2. A typed prompt survives a page reload.
 *  3. A chat create shows its prompt and the working spinner captioned with
 *     the create's progress, then hands over to the chat pane, where the
 *     prompt stays and the spinner reads "working", with no empty state in
 *     between.
 *  4. Back on the pane (the sidebar's +), a typed prompt and a click on the
 *     new workspace's row asks to save a draft; Keep editing stays, Save
 *     draft lands it in the sidebar's Drafts and moves on.
 *  5. With UI set to Terminal, "Start without a prompt" creates a terminal
 *     workspace whose create pane shows no prompt, then its terminal.
 *  6. The header bar matches a workspace's. With UI set to Chat and no
 *     prompt, its Files button starts an empty chat, says it will open
 *     Files, and once up shows the chat empty with Files open beside it.
 *
 * Needs a containerless server with a claude credential and a project.
 * Creates three workspaces and a draft, and removes them at the end.
 *
 * Run: APP_URL=http://127.0.0.1:8787 PROJECT=<name or id> node test-playwright-scripts/new-workspace-pane-test.js
 */
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const { chromium } = requirePlaywright()
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const created = []
const prompt = 'Reply with the single word pong, and do nothing else.'

try {
  await page.goto(`${origin}/?project=${project.id}`)
  const box = page.getByLabel('Prompt')
  await box.waitFor()
  check('pane: composer placeholder', await box.getAttribute('placeholder') === 'Message the agent…')
  await until(page, () => document.activeElement?.getAttribute('aria-label') === 'Prompt')
  check('pane: prompt focused on load', true)
  check('pane: Create waits for a prompt', await page.getByRole('button', { name: 'Create' }).isDisabled())
  await page.screenshot({ path: `${SHOTS}/new-workspace-pane.png` })

  await page.keyboard.type('kept across a reload')
  await page.waitForTimeout(600)
  await page.reload()
  await box.waitFor()
  check('reload: prompt restored', await box.inputValue() === 'kept across a reload')

  // A chat create, straight from the keyboard.
  await box.fill(prompt)
  await page.getByLabel('UI').selectOption('acp')
  // Creating waits on the credential list.
  await until(page, () => document.querySelector('button[aria-label="Create"]')?.disabled === false)
  await box.press('Enter')
  await page.getByText(prompt).first().waitFor()
  const caption = await page.locator('.working-dots').first().evaluate((el) => el.parentElement?.textContent ?? '')
  check('creating: prompt and progress shown', !caption.startsWith('working'), caption)
  await page.screenshot({ path: `${SHOTS}/new-workspace-creating.png` })
  const workspaceParam = () => new URL(location.href).searchParams.get('workspace')
  await until(page, workspaceParam)
  const id = await page.evaluate(workspaceParam)
  created.push(id)

  // Hand-over: watch for an empty state until the agent answers.
  let sawEmpty = false
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (await page.getByText(/No messages yet|Connecting to the agent/).count() > 0) sawEmpty = true
    if (await page.getByText('pong', { exact: true }).count() > 0) break
    await page.waitForTimeout(250)
  }
  check('chat: agent answered', await page.getByText('pong', { exact: true }).count() > 0)
  check('chat: no empty state during the hand-over', !sawEmpty)
  check('chat: prompt shown once', await page.locator('[class*="bg-accent/10"]').filter({ hasText: prompt }).count() === 1)
  await page.screenshot({ path: `${SHOTS}/new-workspace-chat.png` })

  // Leaving with a typed prompt asks first.
  await page.getByRole('button', { name: 'New workspace', exact: true }).click()
  await box.waitFor()
  await box.fill('an idea for later')
  const row = page.getByRole('group', { name: 'Ungrouped workspaces' }).getByRole('button').first()
  await row.click()
  await page.getByText('Save as a draft?').waitFor()
  check('leave: asks to save', true)
  await page.getByRole('button', { name: 'Keep editing' }).click()
  check('leave: keep editing stays', await box.inputValue() === 'an idea for later')
  await row.click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save draft' }).click()
  await page.getByRole('group', { name: 'Drafts' }).getByText('an idea for later').waitFor()
  check('leave: draft saved to the sidebar', true)

  /** Wait for the selection to move off `prev`, and record the new one. */
  const nextWorkspace = async (prev) => {
    await until(page, (p) => {
      const w = new URL(location.href).searchParams.get('workspace')
      return w !== null && w !== p
    }, prev)
    const next = await page.evaluate(workspaceParam)
    created.push(next)
    return next
  }

  // A bare terminal.
  await page.getByRole('button', { name: 'New workspace', exact: true }).click()
  await page.getByLabel('UI').selectOption('tui')
  await until(page, () => [...document.querySelectorAll('button')]
    .some((b) => b.textContent === 'Start without a prompt' && !b.disabled))
  await page.getByRole('button', { name: 'Start without a prompt' }).click()
  const termId = await nextWorkspace(id)
  check('terminal: create pane has no prompt', await page.locator('.working-dots').count() > 0
    && await page.getByText('an idea for later').count() <= 1)
  await page.locator('.xterm').first().waitFor({ timeout: 240_000 })
  check('terminal: terminal shown once up', true)
  await page.screenshot({ path: `${SHOTS}/new-workspace-terminal.png` })

  // An empty chat, started from the bar's Files button.
  await page.getByRole('button', { name: 'New workspace', exact: true }).click()
  await page.getByLabel('UI').selectOption('acp')
  check('bar: matches a workspace\'s', await page.getByRole('button', { name: /Tile view|Tab view/ }).count() === 1
    && await page.getByRole('button', { name: 'Show changes' }).count() === 1)
  const files = page.getByRole('button', { name: 'Browse files' })
  await until(page, () => document.querySelector('button[aria-label="Browse files"]')?.disabled === false)
  await files.click()
  await nextWorkspace(termId)
  check('files: create says it will open Files', await page.getByText(/then opening Files$/).count() === 1)
  await page.getByText(/No messages yet/).waitFor({ timeout: 240_000 })
  check('files: chat starts empty', true)
  await page.getByPlaceholder('Filter files').or(page.getByLabel('Filter files')).first()
    .waitFor({ timeout: 30_000 }).catch(() => {})
  const tabs = await page.locator('section button').allTextContents()
  check('files: Files opened beside the chat', tabs.includes('Files'), tabs.join(' | '))
  await page.screenshot({ path: `${SHOTS}/new-workspace-files.png` })
} finally {
  for (const id of created) await api('/workspace/stop', { method: 'POST', body: { workspaceId: id } }).catch(() => {})
  // The draft goes through its row's menu, as the snapshot is the only listing.
  const draftRow = page.getByRole('group', { name: 'Drafts' }).locator('.group').filter({ hasText: 'an idea for later' })
  while (await draftRow.count() > 0) {
    const n = await draftRow.count()
    await draftRow.first().hover()
    await draftRow.first().getByRole('button', { name: 'Draft actions' }).click()
    await page.getByRole('menuitem', { name: 'Discard…' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click()
    await until(page, (want) => [...document.querySelectorAll('button[title="an idea for later"]')].length < want, n)
  }
  await browser.close()
}
finish()
