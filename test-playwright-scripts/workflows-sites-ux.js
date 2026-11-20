/*
 * Verifies the workflow UX in a real browser:
 *
 *  1. The new-workspace pane sits at the top of the main pane, wider than a
 *     narrow centred column, with Agent and Workflow tabs (no Site tab on a
 *     containerless server, which has no sites).
 *  2. The Agent tab's Steps row names the init workflows a workspace would
 *     run.
 *  3. The Workflow tab picks a named workflow, shows its steps beside the
 *     form, and Run now starts an unattended run with no agent.
 *  4. The sidebar's Workflow tab lists the workflow, and its run sits
 *     under its row, in the group the workflow owns, not as a section of
 *     its own.
 *  5. The workflow's row opens its pane, with its steps and Run now.
 *  6. Settings has an Account and a Project group, the project's pages
 *     (General, Environment, Network, Storage), and no Workflows section.
 *  7. The pane at a phone's width.
 *
 * Screenshots land in $SCREENSHOT_DIR (default /tmp/yaac-shots). Creates a
 * workflow named `ux-check` and one run of it, and removes the workflow at
 * the end; the run stays as a stopped workspace.
 *
 * Run: APP_URL=http://127.0.0.1:<port> PROJECT=<name or id> node test-playwright-scripts/workflows-sites-ux.js
 */
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const { chromium } = requirePlaywright()
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const NAME = 'ux-check'
await api('/workflow/delete', { method: 'POST', body: JSON.stringify({ project: project.id, name: NAME }) }).catch(() => {})
await api('/workflow/create', {
  method: 'POST',
  body: JSON.stringify({
    project: project.id, name: NAME, repos: [],
    steps: { build: { run: ['echo building', 'sleep 2'] }, check: { run: ['echo checked'], needs: ['build'] } },
  }),
})
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })

try {
  await page.goto(`${origin}/?project=${project.id}`)
  const tabs = page.getByRole('group', { name: 'What to start' })
  await tabs.waitFor()
  const main = await page.getByLabel('Prompt').evaluate((el) => el.closest('.\\@container')?.getBoundingClientRect().toJSON())
  const tabBox = await tabs.boundingBox()
  check('pane: tabs near the top, not centred', tabBox.y - main.top < 80, `tabs at ${tabBox.y}, pane top ${main.top}`)
  const formWidth = await tabs.evaluate((el) => el.parentElement.getBoundingClientRect().width)
  check('pane: form wider than the old 448px column', formWidth > 500, `${formWidth}px`)
  check('pane: Agent and Workflow tabs', await tabs.getByRole('button', { name: 'Agent' }).isVisible()
    && await tabs.getByRole('button', { name: 'Workflow' }).isVisible())
  check('pane: no Site tab on containerless', await tabs.getByRole('button', { name: 'Site' }).count() === 0)
  check('agent tab: Steps row', (await page.getByLabel('Steps').locator('option').first().textContent()).startsWith('Init workflows'))
  await page.screenshot({ path: `${SHOTS}/ux-agent-tab.png` })

  await tabs.getByRole('button', { name: 'Workflow' }).click()
  await page.getByRole('combobox', { name: 'Workflow' }).selectOption(NAME)
  const steps = page.getByRole('complementary', { name: 'Its steps' })
  await steps.waitFor()
  check('workflow tab: steps beside the form', await steps.getByText('echo checked').isVisible())
  check('workflow tab: no prompt', await page.getByLabel('Prompt').count() === 0)
  await page.screenshot({ path: `${SHOTS}/ux-workflow-tab.png` })
  await page.getByRole('button', { name: 'Run now', exact: true }).click()

  await page.getByRole('group', { name: 'Sidebar list' }).getByRole('button', { name: 'Workflow' }).click()
  const section = page.locator('aside')
  await section.getByText(NAME, { exact: true }).first().waitFor()
  check('sidebar: Workflow tab lists it', true)
  await until(page, (name) => document.querySelector(`aside [role="group"][aria-label="${name}"]`) !== null, NAME, 60_000)
  check('sidebar: its run nests under its row', true)
  check('sidebar: no separate group section', await section.locator(`[role="group"][aria-label="${NAME}"]`).count() === 1)
  await page.screenshot({ path: `${SHOTS}/ux-sidebar-run.png` })

  await section.getByRole('button', { name: NAME, exact: true }).click()
  await page.getByText('echo building').waitFor()
  check('pane: workflow pane with Run now', await page.getByRole('button', { name: 'Run now', exact: true }).isVisible())
  await page.screenshot({ path: `${SHOTS}/ux-workflow-pane.png` })

  await page.getByRole('button', { name: 'yaac menu' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  const nav = page.getByRole('dialog')
  await nav.getByRole('group', { name: 'Project' }).waitFor()
  for (const label of ['General', 'Environment', 'Network', 'Storage']) {
    check(`settings: project page ${label}`, await nav.getByRole('group', { name: 'Project' }).getByRole('button', { name: label }).isVisible())
  }
  await nav.getByRole('group', { name: 'Project' }).getByRole('button', { name: 'Environment' }).click()
  check('settings: no Workflows section', await nav.getByText('Workflows', { exact: true }).count() === 0)
  await page.screenshot({ path: `${SHOTS}/ux-settings.png` })
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${origin}/?project=${project.id}`)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/ux-mobile.png` })
} finally {
  await browser.close()
  await api('/workflow/delete', { method: 'POST', body: JSON.stringify({ project: project.id, name: NAME }) }).catch(() => {})
}
finish()
