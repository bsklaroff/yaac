/*
 * Verifies the named-git-credential UI end to end in a real browser, against
 * a live server (docs/git-credentials.md):
 *
 *  0. The git-auth-failure badge in the sidebar's project header, fed by
 *     snapshots rewritten to report a 401 from github.com (only the k8s
 *     proxy detects one for real; k8s/proxy/test covers that). Its popover
 *     names the host and status, and "Change git credential…" opens
 *     Settings → Credentials on the project's highlighted row.
 *  1. A project with no git credential cannot create: the create dialog's
 *     button reads "Add git authentication…", which opens that same row.
 *  2. Settings → Add git credential → SSH key: the name starts on a unique
 *     default, Generate shows the public key (with Copy) right away, and the
 *     key then lists among the stored credentials.
 *  3. The unassigned project's picker: "New HTTPS token…", a pasted token,
 *     Assign — the project moves under the new credential and out of the
 *     unassigned list.
 *  4. Add project with a new HTTPS token (named `<name>-token` for the
 *     project name the remote becomes). The token is stored exactly once whatever the
 *     clone does. A clone that succeeds adds and selects the project; one the
 *     host refuses shows the error, with the picker now holding the stored
 *     token for a retry.
 *  5. Replace on step 3's token keeps the credential's name and project.
 *  6. Delete on that token: a confirmation names the project it strands, a
 *     pressed Enter does not confirm, a click does, and the project is back
 *     among those without git authentication.
 *
 * Changes the install it runs against, so use a scratch server (see lib.js):
 * it stages UNASSIGNED_URL as a project with no credential (a clone in the
 * data dir recorded via `POST /api/project/register`), stores three
 * credentials, and adds ADD_URL. To rerun, delete both projects and those
 * credentials, or start from a fresh data dir.
 *
 * Run: node test-playwright-scripts/git-credentials-ui-test.js
 * Env: UNASSIGNED_URL (default https://github.com/octocat/Hello-World),
 * ADD_URL (default https://github.com/octocat/Spoon-Knife; must not already
 * be a project), GIT_TOKEN (default a fake one).
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { api, check, DATA_DIR, finish, origin, requirePlaywright, SHOTS, until } from './lib.js'

const UNASSIGNED_URL = process.env.UNASSIGNED_URL ?? 'https://github.com/octocat/Hello-World'
const ADD_URL = process.env.ADD_URL ?? 'https://github.com/octocat/Spoon-Knife'
const GIT_TOKEN = process.env.GIT_TOKEN ?? 'ghp_fakefakefakefakefakefakefakefake0000'
/** `until` as a boolean, for checks that report a timeout as a failure. */
const holds = (...args) => until(...args).then(() => true, () => false)
/** The name the server derives for a remote's project. */
const nameOf = (url) => url.replace(/\.git$/, '').split('/').pop().toLowerCase()

const projects = async () => await api('/project/list')
const credentials = async () => (await api('/auth/list')).gitCredentials

// Setup: a project with no credential, staged on disk and recorded as is.
// Projects are found by remote, since a name can be shared.
let unassigned = (await projects()).find((p) => p.remoteUrl === UNASSIGNED_URL)?.id
if (unassigned === undefined) {
  unassigned = randomUUID()
  const dir = path.join(DATA_DIR, 'global', 'projects', unassigned)
  execFileSync('git', ['clone', '--quiet', UNASSIGNED_URL, path.join(dir, 'repo')])
  fs.mkdirSync(path.join(dir, 'claude'), { recursive: true })
  await api('/project/register', {
    method: 'POST', body: { id: unassigned, name: nameOf(UNASSIGNED_URL), remoteUrl: UNASSIGNED_URL },
  })
}
const unassignedName = (await projects()).find((p) => p.id === unassigned).name
const addedProject = async () => (await projects()).find((p) => p.remoteUrl === ADD_URL)
if (await addedProject()) throw new Error(`${ADD_URL} is already a project — pick another ADD_URL`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  // Every snapshot reports a rejected credential for the unassigned project.
  await page.routeWebSocket(/\/api\/events$/, (ws) => {
    const server = ws.connectToServer()
    server.onMessage((message) => {
      const frame = JSON.parse(message)
      if (frame.type === 'snapshot') {
        frame.data.gitAuthFailures = { [unassigned]: [{ host: 'github.com', status: 401, atMs: Date.now() }] }
      }
      ws.send(JSON.stringify(frame))
    })
  })
  await page.goto(`${origin}/?project=${unassigned}`)

  const row = (projectId) => page.locator(`[data-project="${projectId}"]`)
  const highlighted = (projectId) => row(projectId).waitFor({ timeout: 10_000 }).then(
    async () => /ring-accent/.test(await row(projectId).getAttribute('class') ?? ''),
    () => false,
  )
  const unassignedList = page.locator('div.mt-6', { hasText: 'Projects without git authentication' })

  // (0) The git-auth badge's popover leads to the same settings row.
  const badge = page.locator('aside [aria-label="Git authentication failed"]')
  check('a rejected credential badges the sidebar\'s project header',
    await badge.waitFor({ timeout: 15_000 }).then(() => true, () => false))
  await badge.click()
  check('its popover names the host and status',
    await page.getByText('github.com — HTTP 401').waitFor({ timeout: 5_000 }).then(() => true, () => false))
  await page.screenshot({ path: path.join(SHOTS, 'git-auth-badge-popover.png') })
  await page.getByRole('button', { name: 'Change git credential…' }).click()
  check('"Change git credential…" opens Settings → Credentials on the project\'s row', await highlighted(unassigned))
  await page.keyboard.press('Escape')

  // (1) Gated create → settings on the project's row.
  await page.getByTitle('New workspace').first().click()
  const gate = page.getByRole('button', { name: 'Add git authentication…' })
  const gated = await gate.waitFor({ timeout: 15_000 }).then(() => true, () => false)
  check('a project without a credential offers "Add git authentication…", not Create', gated)
  if (gated) await gate.click()
  else await page.keyboard.press('Escape')
  const focused = await highlighted(unassigned)
  check('it opens Settings → Credentials on the project\'s highlighted row', focused)
  if (!focused) {
    await page.getByTitle('Settings').first().click()
    await page.getByRole('button', { name: 'Credentials' }).click()
  }
  await page.screenshot({ path: path.join(SHOTS, 'git-credentials-focused.png') })

  // (2) A new SSH key, no project: the public key shows at once.
  await page.getByLabel('Credential kind').selectOption('ssh')
  const addForm = page.locator('div.mt-6', { hasText: 'Add git credential' })
  const keyName = await addForm.getByLabel('Credential name').inputValue()
  check('the key\'s name starts on a default', /^git-key(-\d+)?$/.test(keyName), keyName)
  await addForm.getByRole('button', { name: 'Generate key' }).click()
  const pub = addForm.locator('code', { hasText: 'ssh-ed25519 ' })
  const shown = await pub.waitFor({ timeout: 10_000 }).then(() => true, () => false)
  check('Generate shows the public key right away', shown, shown ? (await pub.textContent()).slice(0, 40) : '')
  check('with a Copy button', await addForm.getByRole('button', { name: 'Copy' }).isVisible())
  await page.screenshot({ path: path.join(SHOTS, 'git-credentials-ssh-generated.png') })
  await addForm.getByRole('button', { name: 'Done' }).click()
  const keyListed = await page.getByRole('button', { name: keyName, exact: true })
    .waitFor({ timeout: 5_000 }).then(() => true, () => false)
  check('the key lists among the stored credentials', keyListed)

  // (3) Assign the unassigned project a new HTTPS token from its own row.
  const picker = unassignedList.locator(`[data-project="${unassigned}"]`)
  await picker.getByLabel('Git credential').selectOption('new')
  const tokenName = await picker.getByLabel('Credential name').inputValue()
  check('the token\'s name defaults to the project\'s', tokenName === `${unassignedName}-token`, tokenName)
  await picker.getByLabel('Token').fill(GIT_TOKEN)
  await picker.getByRole('button', { name: 'Assign' }).click()
  const moved = await holds(page, (projectId) => {
    const lists = [...document.querySelectorAll('div.mt-6')]
    const bottom = lists.find((d) => d.textContent?.includes('Projects without git authentication'))
    return !bottom?.querySelector(`[data-project="${projectId}"]`) && document.querySelector(`[data-project="${projectId}"]`) !== null
  }, unassigned, 10_000)
  check('the project moves under its new credential', moved)
  check('with no picker reopened on it', await row(unassigned).getByRole('button', { name: 'Change' }).isVisible())
  const assigned = (await projects()).find((p) => p.id === unassigned)
  const creds = await credentials()
  const token = creds.find((c) => c.name === tokenName)
  check('the server has it assigned', token !== undefined && token.projects.includes(unassigned),
    JSON.stringify(assigned?.gitCredential ?? null))
  await page.screenshot({ path: path.join(SHOTS, 'git-credentials-assigned.png') })
  await page.keyboard.press('Escape')

  // (4) Add a project with a new HTTPS token.
  await page.getByTitle('New project').first().click()
  await page.getByLabel('Repository URL').fill(ADD_URL)
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Git credential').selectOption('new')
  const newName = await dialog.getByLabel('Credential name').inputValue()
  check('the new token\'s default name is the new project\'s', newName === `${nameOf(ADD_URL)}-token`, newName)
  await dialog.getByLabel('Token').fill(GIT_TOKEN)
  await page.screenshot({ path: path.join(SHOTS, 'add-project-new-token.png') })
  await dialog.getByRole('button', { name: 'Add' }).click()
  const error = dialog.locator('p.text-red-400')
  const settled = await Promise.race([
    dialog.waitFor({ state: 'detached', timeout: 60_000 }),
    error.waitFor({ timeout: 60_000 }),
  ]).then(() => true, () => false)
  check('the add settles within 60s', settled)
  const stored = (await credentials()).filter((c) => c.name === newName)
  check('the token is stored exactly once', stored.length === 1, `${stored.length}`)
  const added = await addedProject()
  if (added) {
    check('the project is added with it', stored[0]?.projects.includes(added.id) === true,
      JSON.stringify(stored[0]?.projects))
    check('the dialog closes', await dialog.count() === 0)
    check('and the new project is selected', await holds(page,
      (projectId) => new URLSearchParams(location.search).get('project') === projectId, added.id, 5_000))
  } else {
    console.log(`      clone refused: ${await error.textContent().catch(() => '(no error shown)')}`)
    check('the clone\'s refusal shows', await error.isVisible())
    check('and the picker now holds the stored token for a retry',
      await dialog.getByLabel('Git credential').inputValue() === stored[0]?.id)
  }
  await page.screenshot({ path: path.join(SHOTS, 'add-project-result.png') })
  if (await dialog.isVisible()) await page.keyboard.press('Escape')

  // (5) Replace step 3's token: same name and project, new credential.
  await page.getByTitle('Settings').first().click()
  await page.getByRole('button', { name: 'Credentials' }).click()
  const tokenRow = page.locator('div.rounded-md.bg-bg', { has: page.getByRole('button', { name: tokenName, exact: true }) })
  await tokenRow.getByRole('button', { name: 'Replace' }).click()
  await tokenRow.getByLabel('New token').fill(`${GIT_TOKEN.slice(0, -4)}1111`)
  await tokenRow.getByRole('button', { name: 'Replace', exact: true }).click()
  const replacedOk = await tokenRow.getByLabel('New token').waitFor({ state: 'detached', timeout: 10_000 })
    .then(() => true, () => false)
  const replaced = (await credentials()).find((c) => c.name === tokenName)
  check('Replace keeps the name and project under a new credential', replacedOk && replaced !== undefined
    && replaced.id !== token?.id && replaced.projects.includes(unassigned), JSON.stringify(replaced ?? null))
  check('and a new preview', replaced?.preview.endsWith('1111') === true, replaced?.preview)

  // (6) Delete it: confirmed only by a click, stranding its project.
  await tokenRow.getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('alertdialog')
  await confirm.waitFor({ timeout: 5_000 })
  check('the delete confirmation names the stranded project',
    (await confirm.textContent()).includes(`${unassignedName} will be left with no git credential`))
  await page.screenshot({ path: path.join(SHOTS, 'git-credentials-delete-confirm.png') })
  check('focus starts on Cancel, not Delete',
    await holds(page, () => document.activeElement?.textContent === 'Cancel', null, 2_000))
  await confirm.getByRole('button', { name: 'Delete' }).focus()
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 1000))
  check('Enter on the Delete button does not confirm',
    await confirm.isVisible() && (await credentials()).some((c) => c.name === tokenName))
  await confirm.getByRole('button', { name: 'Delete' }).click()
  const deleted = await holds(page, () => !document.querySelector('[role="alertdialog"]'), null, 10_000)
  check('a click deletes it', deleted && !(await credentials()).some((c) => c.name === tokenName))
  check('and its project is back among those without git authentication',
    await unassignedList.locator(`[data-project="${unassigned}"]`).waitFor({ timeout: 10_000 }).then(() => true, () => false))
} finally {
  await browser.close()
}
finish()
