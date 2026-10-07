/*
 * Verifies the ownership-aware SPA with two tailnet principals against a
 * real containerless server in `tailnet` mode
 * (docs/multi-user.md "Snapshot and webapp"):
 *
 *  1. Ada, the project's owner, sees her workspace with its controls and no
 *     read-only banner.
 *  2. Bob starts on his own (empty) projects; the user switcher lists Ada,
 *     and its menu says this containerless server does not separate users.
 *  3. Switching to Ada shows her project and workspace laid out as hers,
 *     read-only: banner, no new-workspace button, no row menu; the
 *     workspace opens in the transcript view, with no terminal.
 *  4. Settings → Project Config shows Ada's project with no Save button.
 *  5. A fresh page deep-linked to Ada's workspace selects Ada by itself.
 *  6. Bob made no write the server refused (no 403 in any response).
 *
 * A principal is only request headers: `tailscale serve` stamps
 * `Tailscale-User-Login`/`-Name` and `X-Forwarded-For`, so each browser
 * context sends them itself. The script stands up its own throwaway data
 * dir and server (fake `claude`, a staged checkout, no network), so it never
 * touches your install.
 *
 * Prerequisites: `pnpm build` at the repo root (the server serves dist/),
 * tmux and git on PATH.
 *
 * Run:
 *   node test-playwright-scripts/multi-user-switcher.js
 *
 * Screenshots: $SCREENSHOT_DIR/multi-user-*.png (default /tmp/yaac-shots).
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, requirePlaywright, SHOTS, until } from './lib.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(REPO, 'dist', 'cli.js')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-multi-user-'))
const PORT = process.env.YAAC_SERVER_PORT ?? '47391'
const ORIGIN = `http://127.0.0.1:${PORT}`
// Inherited YAAC_* settings are dropped: inside a yaac workspace,
// YAAC_WORKSPACE_ID would make this a nested server, which is always local.
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('YAAC_'))),
  YAAC_DATA_DIR: DATA_DIR,
  YAAC_SERVER_PORT: PORT,
  // The project's remote is fake; never fetch it.
  YAAC_E2E_SKIP_FETCH: '1',
}

const ADA = { login: 'ada@example.com', name: 'Ada Lovelace' }
const BOB = { login: 'bob@example.com', name: 'Bob Builder' }
const headersFor = (who) => ({
  'Tailscale-User-Login': who.login,
  'Tailscale-User-Name': who.name,
  'X-Forwarded-For': '100.64.0.1',
})

function yaac(...args) {
  return execFileSync('node', [CLI, ...args], { env: ENV, encoding: 'utf8' })
}

/** `/api<route>` as `who`, as JSON. */
async function apiAs(who, route, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(`${ORIGIN}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headersFor(who) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} /api${route}: HTTP ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

/** Where this data dir keeps yaac's `claude` install and a project's
 *  checkout, as the server resolves them. */
function stagingPaths(projectId) {
  const out = execFileSync('pnpm', ['exec', 'tsx', '-e',
    "import { AGENT_PACKAGES, agentPackagePrefix } from '@yaac/shared/tool-install';"
    + "import { projectDir, repoDir } from '@yaac/shared/project-paths';"
    + 'console.log(JSON.stringify({ claude: agentPackagePrefix(AGENT_PACKAGES.claude),'
    + ` project: projectDir('${projectId}'), repo: repoDir('${projectId}') }))`],
  { cwd: path.join(REPO, 'packages', 'server'), env: ENV, encoding: 'utf8' })
  return JSON.parse(out)
}

/** A fake `claude` where yaac installs the pinned one, holding its window
 *  open like a real TUI, so a create installs nothing. */
function stageFakeClaude(prefix) {
  const bin = path.join(prefix, 'bin', 'claude')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '#!/bin/sh\nexec sleep infinity\n', { mode: 0o755 })
}

/** A checkout staged where `/project/register` expects it, with origin refs
 *  set locally so a create needs no fetch. */
function stageCheckout({ project, repo }) {
  fs.mkdirSync(path.join(project, 'claude'), { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  fs.mkdirSync(repo, { recursive: true })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
}

async function main() {
  const projectId = crypto.randomUUID()
  const paths = stagingPaths(projectId)
  stageFakeClaude(paths.claude)
  stageCheckout(paths)
  yaac('server', 'start', '--tailnet', 'yaac.test')

  // Ada: a project, a credential, an identity and one running workspace.
  await apiAs(ADA, '/project/register', { id: projectId, name: 'ada-demo', remoteUrl: 'https://github.com/ada/demo.git' })
  await apiAs(ADA, '/auth/fake', { kinds: ['claude-oauth'] })
  await apiAs(ADA, '/config/git-identity', { name: 'Ada', email: 'ada@example.com' }, 'PUT')
  const cred = await apiAs(ADA, '/auth/git/credentials', { name: 'gh', token: 'ghp_fake' })
  await apiAs(ADA, `/project/${projectId}/git-credential`, { credentialId: cred.id }, 'PUT')
  const created = await fetch(`${ORIGIN}/api/workspace/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headersFor(ADA) },
    body: JSON.stringify({ project: projectId, tool: 'claude', prompt: 'Ada fixes the parser', title: 'Parser fix' }),
  })
  const last = (await created.text()).trim().split('\n').map((l) => JSON.parse(l)).at(-1)
  if (last?.type !== 'result') throw new Error(`create failed: ${JSON.stringify(last)}`)
  const workspaceId = last.result.workspaceId
  // Bob becomes a user on his first request.
  await apiAs(BOB, '/whoami')

  const { chromium } = requirePlaywright()
  const browser = await chromium.launch()
  const contextFor = (who) => browser.newContext({ extraHTTPHeaders: headersFor(who), viewport: { width: 1400, height: 900 } })

  // 1. Ada's own view.
  const ada = await (await contextFor(ADA)).newPage()
  await ada.goto(`${ORIGIN}/?project=${projectId}`)
  await ada.getByText('Parser fix').first().waitFor()
  check('Ada sees her new-workspace button', await ada.getByRole('button', { name: 'New workspace' }).count() > 0)
  check('Ada sees no read-only banner', await ada.getByText(/read-only/).count() === 0)
  await ada.screenshot({ path: path.join(SHOTS, 'multi-user-ada.png') })

  // 2. Bob starts on his own projects.
  const bobContext = await contextFor(BOB)
  const refused = []
  bobContext.on('response', (r) => { if (r.status() === 403) refused.push(`${r.request().method()} ${r.url()}`) })
  const bob = await bobContext.newPage()
  await bob.goto(`${ORIGIN}/`)
  const switcher = bob.getByRole('button', { name: /Switch user/ })
  await switcher.waitFor()
  check('Bob starts on his own projects', (await switcher.getAttribute('aria-label')) === 'Switch user (Your projects)')
  await switcher.click()
  check('the switcher lists Ada', await bob.getByRole('menuitem', { name: /Ada Lovelace/ }).count() === 1)
  check('it says containerless does not separate users', await bob.getByText(/does not separate users/).count() === 1)
  await bob.screenshot({ path: path.join(SHOTS, 'multi-user-switcher.png') })

  // 3. Ada's projects, read-only.
  await bob.getByRole('menuitem', { name: /Ada Lovelace/ }).click()
  await bob.getByText('Parser fix').first().waitFor()
  check('the sidebar says it is read-only', await bob.getByText(/Ada Lovelace's workspaces, read-only/).count() === 1)
  check('no new-workspace button', await bob.getByRole('button', { name: 'New workspace' }).count() === 0)
  check('no row menu', await bob.getByRole('button', { name: 'Workspace actions' }).count() === 0)
  await bob.getByText('Parser fix').first().click()
  await until(bob, () => document.querySelector('main header')?.textContent?.includes('Parser fix'))
  check('the workspace opens without a terminal', await bob.locator('.xterm').count() === 0)
  await bob.locator('main').getByText('Ada fixes the parser').first().waitFor()
  check('the transcript view shows the prompt', true)
  await bob.screenshot({ path: path.join(SHOTS, 'multi-user-readonly.png') })

  // 4. Their project settings, read-only.
  await bob.getByTitle('Settings').click()
  await bob.getByRole('button', { name: 'Project Config' }).click()
  await bob.getByText('yaac-config.json').waitFor()
  check('the project picker offers Ada\'s project', await bob.locator('select option').allTextContents()
    .then((names) => names.join() === 'ada-demo'))
  check('project settings have no Save', await bob.getByRole('button', { name: 'Save' }).count() === 0)
  check('no env var form', await bob.getByPlaceholder('NAME').count() === 0)
  await bob.screenshot({ path: path.join(SHOTS, 'multi-user-settings.png') })

  // 5. A deep link to her workspace selects Ada.
  const linked = await bobContext.newPage()
  await linked.goto(`${ORIGIN}/?project=${projectId}&workspace=${workspaceId}`)
  await linked.getByText(/Ada Lovelace's workspaces, read-only/).waitFor()
  check('a deep link selects the owner', (await linked.getByRole('button', { name: /Switch user/ })
    .getAttribute('aria-label')) === "Switch user (Ada Lovelace's projects)")
  await until(linked, () => document.querySelector('main header')?.textContent?.includes('Parser fix'))
  check('and opens the linked workspace', true)

  // 6. Nothing Bob's pages did was refused.
  check(`no request was refused (${refused.join(', ') || 'none'})`, refused.length === 0)

  await browser.close()
}

try {
  await main()
} finally {
  try { yaac('server', 'stop') } catch (e) { console.error(`server stop: ${e.message}`) }
}
finish()
