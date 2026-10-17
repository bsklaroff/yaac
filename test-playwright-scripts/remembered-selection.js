/*
 * Verifies that the SPA reopens each project's and each user's last
 * selection (lastWorkspaceOf / lastProjectOf in #lib/store), against a real
 * containerless server in `tailnet` mode with two principals:
 *
 *  1. Ada, with two projects of two workspaces each: switching projects back
 *     and forth reopens the workspace last open in each, not the top row.
 *  2. The memory survives a reload.
 *  3. A remembered workspace that has stopped is not reopened: switching
 *     back opens the top row, not the read-only stopped view.
 *  4. A `?project=&workspace=` deep link opens what it names, and switching
 *     away and back reopens that workspace.
 *  5. Bob, viewing Ada's projects through the user switcher, reopens the
 *     project of Ada's he last had open after switching to himself and back.
 *
 * Which workspace is open is read from the URL's `workspace` param, which
 * the store mirrors from its selection.
 *
 * The script stands up its own throwaway data dir and server (fake `claude`,
 * staged checkouts, no network), so it never touches your install.
 *
 * Prerequisites: `pnpm build` at the repo root (the server serves dist/),
 * tmux and git on PATH.
 *
 * Run:
 *   node test-playwright-scripts/remembered-selection.js
 *
 * Screenshots: $SCREENSHOT_DIR/remembered-*.png (default /tmp/yaac-shots).
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-remembered-'))
const PORT = process.env.YAAC_SERVER_PORT ?? '47392'
const ORIGIN = `http://127.0.0.1:${PORT}`
// Inherited YAAC_* settings are dropped: inside a yaac workspace,
// YAAC_WORKSPACE_ID would make this a nested server, which is always local.
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('YAAC_'))),
  YAAC_DATA_DIR: DATA_DIR,
  YAAC_SERVER_PORT: PORT,
  // The projects' remotes are fake; never fetch them.
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

async function createAs(who, project, title) {
  const res = await fetch(`${ORIGIN}/api/workspace/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headersFor(who) },
    body: JSON.stringify({ project, tool: 'claude', prompt: title, title }),
  })
  const last = (await res.text()).trim().split('\n').map((l) => JSON.parse(l)).at(-1)
  if (last?.type !== 'result') throw new Error(`create failed: ${JSON.stringify(last)}`)
  return last.result.workspaceId
}

const param = (page, name) => new URL(page.url()).searchParams.get(name)

/** Wait for the URL to settle on a project and some workspace in it. */
async function settled(page, projectId) {
  await until(page, (p) => {
    const q = new URLSearchParams(location.search)
    return q.get('project') === p && q.get('workspace') !== null
  }, projectId)
  await page.waitForTimeout(300)
  return param(page, 'workspace')
}

async function main() {
  const projects = { A: crypto.randomUUID(), B: crypto.randomUUID() }
  let staged = false
  for (const id of Object.values(projects)) {
    const paths = stagingPaths(id)
    if (!staged) stageFakeClaude(paths.claude)
    staged = true
    stageCheckout(paths)
  }
  yaac('server', 'start', '--tailnet', 'yaac.test')

  await apiAs(ADA, '/auth/fake', { kinds: ['claude-oauth'] })
  await apiAs(ADA, '/config/git-identity', { name: 'Ada', email: 'ada@example.com' }, 'PUT')
  const cred = await apiAs(ADA, '/auth/git/credentials', { name: 'gh', token: 'ghp_fake' })
  for (const [name, id] of Object.entries(projects)) {
    await apiAs(ADA, '/project/register', { id, name: `proj-${name}`, remoteUrl: `https://github.com/ada/${name}.git` })
    await apiAs(ADA, `/project/${id}/git-credential`, { credentialId: cred.id }, 'PUT')
  }
  const ws = {}
  for (const name of ['A1', 'A2', 'B1', 'B2']) ws[name] = await createAs(ADA, projects[name[0]], `ws-${name}`)
  await apiAs(BOB, '/whoami')

  const { chromium } = requirePlaywright()
  const browser = await chromium.launch()
  const contextFor = (who) => browser.newContext({ extraHTTPHeaders: headersFor(who), viewport: { width: 1400, height: 900 } })
  const adaContext = await contextFor(ADA)
  const ada = await adaContext.newPage()
  const railTo = async (page, name) => page.getByTitle(`proj-${name}`, { exact: true }).first().click()
  const rowOf = (page, id) => page.getByText(`ws-${Object.keys(ws).find((k) => ws[k] === id)}`).first()
  const other = (name, id) => (ws[`${name}1`] === id ? ws[`${name}2`] : ws[`${name}1`])

  // 1. Switching back and forth reopens each project's last workspace.
  // A first load opens no workspace, so each project's top row is learned
  // by switching into it before anything is remembered there.
  await ada.goto(`${ORIGIN}/?project=${projects.A}`)
  await ada.getByText('ws-A1').first().waitFor()
  await railTo(ada, 'B')
  const topB = await settled(ada, projects.B)
  check('a project never opened opens its top row', [ws.B1, ws.B2].includes(topB))
  await railTo(ada, 'A')
  const topA = await settled(ada, projects.A)
  const pickA = other('A', topA)
  await rowOf(ada, pickA).click()
  await until(ada, (id) => new URLSearchParams(location.search).get('workspace') === id, pickA)
  await railTo(ada, 'B')
  check('B, whose top row was open, reopens it', await settled(ada, projects.B) === topB)
  const pickB = other('B', topB)
  await rowOf(ada, pickB).click()
  await until(ada, (id) => new URLSearchParams(location.search).get('workspace') === id, pickB)
  await railTo(ada, 'A')
  check('switching back to A reopens the non-top row last open there', await settled(ada, projects.A) === pickA)
  await railTo(ada, 'B')
  check('switching back to B reopens its last workspace', await settled(ada, projects.B) === pickB)
  await ada.screenshot({ path: path.join(SHOTS, 'remembered-switch.png') })

  // 2. Across a reload.
  await ada.reload()
  check('a reload keeps the open selection', await settled(ada, projects.B) === pickB)
  await railTo(ada, 'A')
  check('after a reload, A still reopens its last workspace', await settled(ada, projects.A) === pickA)
  const stored = await ada.evaluate(() => [localStorage.getItem('yaac.lastworkspace.v1'), localStorage.getItem('yaac.lastproject.v1')])
  check('both maps are persisted', stored.every((s) => s !== null), stored.join(' | '))

  // 3. A remembered workspace that stopped falls back to the top row.
  await railTo(ada, 'B')
  await settled(ada, projects.B)
  await apiAs(ADA, '/workspace/stop', { workspaceId: pickA })
  // The stop's snapshot reaches the page before the switch.
  await ada.waitForTimeout(3000)
  await railTo(ada, 'A')
  const afterStop = await settled(ada, projects.A)
  check('a stopped remembered workspace is not reopened; the top row is', afterStop === topA, `${afterStop} vs top ${topA}`)
  await ada.screenshot({ path: path.join(SHOTS, 'remembered-after-stop.png') })

  // 4. A deep link opens what it names, and is then remembered.
  const linked = await adaContext.newPage()
  await linked.goto(`${ORIGIN}/?project=${projects.B}&workspace=${topB}`)
  check('a deep link opens the workspace it names', await settled(linked, projects.B) === topB)
  await railTo(linked, 'A')
  await settled(linked, projects.A)
  await railTo(linked, 'B')
  check('the deep-linked workspace is what B reopens', await settled(linked, projects.B) === topB)
  // A deep link to the stopped one still opens it read-only, as before.
  await linked.goto(`${ORIGIN}/?project=${projects.A}&workspace=${pickA}`)
  await linked.waitForTimeout(2000)
  check('a deep link to a stopped workspace still opens it', param(linked, 'workspace') === pickA)
  await linked.screenshot({ path: path.join(SHOTS, 'remembered-stopped-link.png') })
  await railTo(linked, 'B')
  await settled(linked, projects.B)
  await railTo(linked, 'A')
  check('switching back from a stopped view opens the top row', await settled(linked, projects.A) === topA)

  // 5. The user switcher reopens the teammate's last project.
  const bob = await (await contextFor(BOB)).newPage()
  await bob.goto(`${ORIGIN}/`)
  const switcher = bob.getByRole('button', { name: /Switch user/ })
  await switcher.click()
  await bob.getByRole('menuitem', { name: /Ada Lovelace/ }).click()
  await until(bob, () => new URLSearchParams(location.search).get('project') !== null)
  const first = param(bob, 'project')
  const otherProject = first === projects.A ? 'B' : 'A'
  await railTo(bob, otherProject)
  await settled(bob, projects[otherProject])
  await bob.getByRole('button', { name: /Switch user/ }).click()
  await bob.getByRole('menuitem', { name: /Bob Builder/ }).click()
  await until(bob, (who) => document.querySelector('[aria-label^="Switch user"]')?.getAttribute('aria-label') === who,
    'Switch user (Your projects)')
  await bob.getByRole('button', { name: /Switch user/ }).click()
  await bob.getByRole('menuitem', { name: /Ada Lovelace/ }).click()
  await until(bob, () => new URLSearchParams(location.search).get('project') !== null)
  check('picking Ada again reopens the project of hers last open', param(bob, 'project') === projects[otherProject],
    `${param(bob, 'project')} vs ${projects[otherProject]} (first was ${first})`)
  await bob.screenshot({ path: path.join(SHOTS, 'remembered-switcher.png') })

  await browser.close()
}

try {
  await main()
} finally {
  try { yaac('server', 'stop') } catch (e) { console.error(`server stop: ${e.message}`) }
}
finish()
