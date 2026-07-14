/*
 * Verifies the project Skills viewer (SkillsButton + overlay) end-to-end in the
 * real webapp: the ✨ button in the sidebar header opens a near-fullscreen
 * dialog that lists the project's personal/plugin/project SKILL.md files for the
 * selected agent, and clicking a skill loads its full SKILL.md into a detail
 * pane. A per-agent selector (Claude/Codex/OpenCode) re-scans that tool's dirs.
 *
 * Drives the running yaac server's webapp in real Chromium. Self-contained: it
 * seeds a personal + project Claude skill and one Codex skill into the project's
 * on-disk skill dirs (under $YAAC_DATA_DIR/projects/<slug>/…), runs the checks,
 * then removes them again — so it is safe to re-run and leaves no residue.
 *
 * Run: PROJECT=<slug> node test-playwright-scripts/skills-viewer-test.js
 * (set SCREENSHOT_DIR to also capture a screenshot of the open overlay)
 * Needs a running server (`yaac server start`) with a project configured;
 * authenticates the browser via `yaac open --no-browser` (a one-time ?token=
 * URL the SPA exchanges for its session cookie).
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

function readServerLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

/** Base dir for a project's on-disk config/repo (mirrors @yaac/shared paths). */
function projectBase(slug) {
  const dataDir = process.env.YAAC_DATA_DIR || path.join(os.homedir(), '.yaac')
  return path.join(dataDir, 'projects', slug)
}

/** Seed a personal + project Claude skill and a Codex skill; return their dirs. */
function seedSkills(slug) {
  const base = projectBase(slug)
  const fixtures = [
    [path.join(base, 'claude', 'skills', 'hello-personal'),
      '---\nname: hello-personal\ndescription: A live-test personal skill\nallowed-tools: [Read, Grep]\n---\n# Hello\nThis is the personal skill body.\n'],
    [path.join(base, 'repo', '.claude', 'skills', 'hello-project'),
      '---\ndescription: A live-test project skill\ndisable-model-invocation: true\n---\nProject skill body here.\n'],
    [path.join(base, 'codex', 'skills', 'hello-codex'),
      '---\nname: hello-codex\ndescription: A live-test codex skill\n---\nCodex body.\n'],
  ]
  for (const [dir, contents] of fixtures) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), contents)
  }
  return fixtures.map(([dir]) => dir)
}

async function main() {
  const { chromium } = requirePlaywright()
  const project = process.env.PROJECT || 'yaac'
  readServerLock() // fail fast with a clear message if no server is running
  const seededDirs = seedSkills(project)

  // Fresh one-time exchange token → authed URL (?token=…); the SPA exchanges
  // it for the session cookie on load.
  const openOut = execSync('yaac open --no-browser', { encoding: 'utf8' }).trim()
  const authedUrl = openOut.split('\n').map((l) => l.trim()).find((l) => l.startsWith('http'))
  if (!authedUrl) throw new Error(`could not parse authed URL from: ${openOut}`)

  const browser = await chromium.launch()
  const viewport = { width: 1400, height: 900 }
  const page = await browser.newPage({ viewport, bypassCSP: true })
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  try {
    await page.goto(`${authedUrl}&project=${project}`)

    // Open the Skills overlay from the sidebar header.
    const skillsBtn = page.getByRole('button', { name: 'Skills', exact: true })
    await skillsBtn.waitFor({ state: 'visible', timeout: 15000 })
    await skillsBtn.click()

    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible' })
    await page.waitForTimeout(400) // open transition

    // Claude tier: the two seeded skills should be listed.
    const personal = dialog.getByRole('button', { name: /\/hello-personal/ })
    const project_ = dialog.getByRole('button', { name: /\/hello-project/ })
    await personal.waitFor({ state: 'visible', timeout: 10000 })
    check('claude: personal skill listed', await personal.count() >= 1)
    check('claude: project skill listed', await project_.count() >= 1)

    // Clicking a skill loads its full SKILL.md body into the detail pane.
    await personal.first().click()
    await page.waitForTimeout(300)
    check('detail pane shows the skill body',
      await dialog.getByText('This is the personal skill body').count() >= 1)
    check('detail pane shows allowed-tools',
      await dialog.getByText(/Read, Grep/).count() >= 1)

    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'skills-viewer-claude.png') })
    }

    // Switch the per-agent selector to Codex → its own dir is scanned.
    await dialog.getByRole('button', { name: 'Codex', exact: true }).click()
    const codex = dialog.getByRole('button', { name: /\/hello-codex/ })
    await codex.waitFor({ state: 'visible', timeout: 10000 })
    check('codex: selector re-scans and lists the codex skill', await codex.count() >= 1)
    // The claude-only skill should no longer be present under Codex.
    check('codex: claude skill no longer listed',
      await dialog.getByRole('button', { name: /\/hello-project/ }).count() === 0)

    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'skills-viewer-codex.png') })
    }
  } finally {
    await browser.close()
    for (const dir of seededDirs) fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
