/*
 * Verifies the named-git-credential UI end to end in a real browser, against
 * a live server:
 *
 *  1. A project with no git credential cannot create: the "+ New worktree"
 *     popover offers "Add git authentication…" instead of Create, and that
 *     opens Settings → Credentials with the project's row in the "Projects
 *     without git authentication" list highlighted.
 *  2. Settings → Add git credential → SSH key: the name starts on a unique
 *     default, Generate shows the public key (with Copy) right away, and the
 *     key then lists among the stored credentials.
 *  3. The unassigned project's picker: "New HTTPS token…", a pasted token,
 *     Assign — the project moves under the new credential and out of the
 *     unassigned list.
 *  4. Add project with a new HTTPS token: URL, "New HTTPS token…" (named
 *     `<slug>-token` for the slug the remote becomes), token, Add. The token
 *     is stored exactly once whatever the clone does. A clone that succeeds
 *     adds and selects the project; one the host refuses (a fake token on a
 *     host that checks it) shows the error, with the picker now holding the
 *     stored token for a retry.
 *  5. Replace on step 3's token: a new token keeps the credential's name
 *     and its project.
 *  6. Delete on that token: a confirmation names the project it strands, a
 *     pressed Enter does not confirm, a click does — and the project is back
 *     among those without git authentication.
 *
 * Mutates the install it runs against — stages UNASSIGNED_URL as a project
 * with no credential if absent, stores three credentials, assigns, replaces
 * and deletes one, and may add ADD_URL — so point it at a scratch server on this machine. The API
 * never adds a project without a credential; one arises only from the
 * legacy importer or a remote change. So the script stages it the way the
 * e2e fixtures do: a clone plus `project.json` in the data dir, which the
 * server adopts as a project with no credential.
 *
 *   export YAAC_DATA_DIR=/tmp/yaac-pw-$$ YAAC_SERVER_PORT=8893
 *   yaac server start          # after `pnpm build`, so dist/ is current
 *   node test-playwright-scripts/git-credentials-ui-test.js
 *   yaac server stop && rm -rf "$YAAC_DATA_DIR"
 *
 * Env: UNASSIGNED_URL (default https://github.com/octocat/Hello-World),
 * ADD_URL (default https://github.com/octocat/Spoon-Knife; must not already be
 * a project), GIT_TOKEN (default a fake one), SCREENSHOT_DIR (default
 * /tmp/yaac-shots). Reads port + secret from
 * $YAAC_DATA_DIR/server-local/.server.lock (data dir defaults to ~/.yaac).
 * Playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers.
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

const dataDir = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')

function readServerLock() {
  const candidates = [
    path.join(dataDir, 'server-local', '.server.lock'),
    path.join(dataDir, '.server.lock'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const UNASSIGNED_URL = process.env.UNASSIGNED_URL ?? 'https://github.com/octocat/Hello-World'
const ADD_URL = process.env.ADD_URL ?? 'https://github.com/octocat/Spoon-Knife'
const GIT_TOKEN = process.env.GIT_TOKEN ?? 'ghp_fakefakefakefakefakefakefakefake0000'
const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const slugOf = (url) => url.replace(/\.git$/, '').split('/').pop().toLowerCase()

const lock = readServerLock()
const origin = `http://127.0.0.1:${lock.port}`
const auth = { authorization: `Bearer ${lock.secret}` }

async function api(method, route, body) {
  const res = await fetch(`${origin}${route}`, {
    method,
    headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function mintToken() {
  return (await api('POST', '/tokens', { kind: 'one-time' })).token
}

const projects = async () => await api('GET', '/project/list')
const credentials = async () => (await api('GET', '/auth/list')).gitCredentials

// Setup: a project with no credential, staged on disk for the server to adopt.
const unassigned = slugOf(UNASSIGNED_URL)
if (!(await projects()).some((p) => p.slug === unassigned)) {
  const dir = path.join(dataDir, 'global', 'projects', unassigned)
  execSync(`git clone --quiet ${UNASSIGNED_URL} ${path.join(dir, 'repo')}`)
  fs.mkdirSync(path.join(dir, 'claude'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    slug: unassigned, remoteUrl: UNASSIGNED_URL, addedAt: new Date().toISOString(),
  }) + '\n')
}
if ((await projects()).some((p) => p.slug === slugOf(ADD_URL))) {
  throw new Error(`${slugOf(ADD_URL)} is already a project — pick another ADD_URL`)
}

/** Poll `fn(arg)` in the page until truthy. (page.waitForFunction with an
 *  argument evaluates a string, which the app's CSP refuses.) */
async function until(page, fn, arg, timeout) {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    if (await page.evaluate(fn, arg)) return true
  }
  return false
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${unassigned}&token=${await mintToken()}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })
  fs.mkdirSync(SHOTS, { recursive: true })

  const row = (slug) => page.locator(`[data-project="${slug}"]`)
  const unassignedList = page.locator('div.mt-6', { hasText: 'Projects without git authentication' })

  // (1) Gated create → settings on the project's row.
  await page.getByTitle('New worktree').first().click()
  const gate = page.getByRole('button', { name: 'Add git authentication…' })
  const gated = await gate.waitFor({ timeout: 15_000 }).then(() => true, () => false)
  check('a project without a credential offers "Add git authentication…", not Create', gated)
  if (gated) await gate.click()
  else await page.keyboard.press('Escape')
  const focused = await row(unassigned).waitFor({ timeout: 10_000 }).then(
    async () => /ring-accent/.test(await row(unassigned).getAttribute('class') ?? ''),
    () => false,
  )
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
  check('the token\'s name defaults to the project\'s', tokenName === `${unassigned}-token`, tokenName)
  await picker.getByLabel('Token').fill(GIT_TOKEN)
  await picker.getByRole('button', { name: 'Assign' }).click()
  const moved = await until(page, (slug) => {
    const lists = [...document.querySelectorAll('div.mt-6')]
    const bottom = lists.find((d) => d.textContent?.includes('Projects without git authentication'))
    return !bottom?.querySelector(`[data-project="${slug}"]`) && document.querySelector(`[data-project="${slug}"]`) !== null
  }, unassigned, 10_000)
  check('the project moves under its new credential', moved)
  check('with no picker reopened on it', await row(unassigned).getByRole('button', { name: 'Change' }).isVisible())
  const assigned = (await projects()).find((p) => p.slug === unassigned)
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
  check('the new token\'s default name is the new project\'s', newName === `${slugOf(ADD_URL)}-token`, newName)
  await dialog.getByLabel('Token').fill(GIT_TOKEN)
  await page.screenshot({ path: path.join(SHOTS, 'add-project-new-token.png') })
  await dialog.getByRole('button', { name: 'Add' }).click()
  const outcome = await Promise.race([
    until(page, (slug) => new URLSearchParams(location.search).get('project') === slug, slugOf(ADD_URL), 60_000)
      .then((added) => (added ? 'added' : 'timeout')),
    dialog.locator('p.text-red-400').waitFor({ timeout: 60_000 }).then(() => 'refused', () => 'timeout'),
  ])
  const stored = (await credentials()).filter((c) => c.name === newName)
  check('the token is stored exactly once', stored.length === 1, `${stored.length}`)
  if (outcome === 'added') {
    check('the project is added and selected with it', stored[0]?.projects.includes(slugOf(ADD_URL)) === true,
      JSON.stringify(stored[0]?.projects))
    check('and the dialog closes', await dialog.waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false))
  } else {
    const message = outcome === 'refused' ? await dialog.locator('p.text-red-400').textContent() : outcome
    console.log(`      clone refused (expected with a fake token): ${message}`)
    check('the clone\'s refusal shows', outcome === 'refused')
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
    (await confirm.textContent()).includes(`${unassigned} will be left with no git credential`))
  await page.screenshot({ path: path.join(SHOTS, 'git-credentials-delete-confirm.png') })
  check('focus starts on Cancel, not Delete',
    await until(page, () => document.activeElement?.textContent === 'Cancel', null, 2_000))
  await confirm.getByRole('button', { name: 'Delete' }).focus()
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 1000))
  check('Enter on the Delete button does not confirm',
    await confirm.isVisible() && (await credentials()).some((c) => c.name === tokenName))
  await confirm.getByRole('button', { name: 'Delete' }).click()
  const deleted = await until(page, () => !document.querySelector('[role="alertdialog"]'), null, 10_000)
  check('a click deletes it', deleted && !(await credentials()).some((c) => c.name === tokenName))
  check('and its project is back among those without git authentication',
    await unassignedList.locator(`[data-project="${unassigned}"]`).waitFor({ timeout: 10_000 }).then(() => true, () => false))
} finally {
  await browser.close()
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
