/*
 * Verifies the project Skills viewer (SkillsButton + overlay) in the running
 * server's webapp, in Chromium: the Skills button in the sidebar header opens
 * a dialog listing the personal/plugin/project SKILL.md files for the
 * selected agent, clicking a skill shows its full SKILL.md, and the agent
 * selector (Claude/Codex/OpenCode/Pi) rescans that tool's dirs.
 *
 * Seeds a personal Claude skill and a Codex skill under
 * <data dir>/global/projects/<slug>/ and removes them afterwards, so it
 * is safe to re-run. The project (repo) tier is not seeded: it is read from
 * origin/<branch>, so a working-tree file would not be listed.
 *
 * Needs a running `yaac server` with a project (PROJECT, default yaac).
 *
 * Run: YAAC_DATA_DIR=... PROJECT=<slug> node test-playwright-scripts/skills-viewer-test.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, SHOTS, check, finish, origin, requirePlaywright, until } from './lib.js'

/** Base dir for a project's on-disk config/repo (mirrors @yaac/shared paths). */
function projectBase(slug) {
  return path.join(DATA_DIR, 'global', 'projects', slug)
}

/** Seed a personal Claude skill and a Codex skill; return their dirs. */
function seedSkills(slug) {
  const base = projectBase(slug)
  const fixtures = [
    [path.join(base, 'claude', 'skills', 'hello-personal'),
      '---\nname: hello-personal\ndescription: A live-test personal skill\nallowed-tools: [Read, Grep]\n---\n# Hello\nThis is the personal skill body.\n'],
    [path.join(base, 'codex', 'skills', 'hello-codex'),
      '---\nname: hello-codex\ndescription: A live-test codex skill\n---\nCodex body.\n'],
  ]
  for (const [dir, contents] of fixtures) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), contents)
  }
  return fixtures.map(([dir]) => dir)
}

const { chromium } = requirePlaywright()
const project = process.env.PROJECT || 'yaac'
const seededDirs = seedSkills(project)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

try {
  await page.goto(`${origin}/?project=${project}`)

  const skillsBtn = page.getByRole('button', { name: 'Skills', exact: true })
  await skillsBtn.waitFor({ state: 'visible', timeout: 15000 })
  await skillsBtn.click()

  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ state: 'visible' })
  await page.waitForTimeout(400) // open transition

  const personal = dialog.getByRole('button', { name: /\/hello-personal/ })
  await personal.waitFor({ state: 'visible', timeout: 10000 })
  check('claude: personal skill listed', await personal.count() >= 1)

  await personal.first().click()
  // The body loads on its own fetch after the click.
  const body = await until(page, () => document.querySelector('[role="dialog"]')?.textContent
    .includes('This is the personal skill body'), null, 10_000).then(() => true, () => false)
  check('detail pane shows the skill body', body)
  check('detail pane shows allowed-tools',
    await dialog.getByText(/Read, Grep/).count() >= 1)

  await page.screenshot({ path: path.join(SHOTS, 'skills-viewer-claude.png') })

  await dialog.getByRole('button', { name: 'Codex', exact: true }).click()
  const codex = dialog.getByRole('button', { name: /\/hello-codex/ })
  await codex.waitFor({ state: 'visible', timeout: 10000 })
  check('codex: selector re-scans and lists the codex skill', await codex.count() >= 1)
  check('codex: claude skill no longer listed',
    await dialog.getByRole('button', { name: /\/hello-personal/ }).count() === 0)

  await page.screenshot({ path: path.join(SHOTS, 'skills-viewer-codex.png') })
} finally {
  await browser.close()
  for (const dir of seededDirs) fs.rmSync(dir, { recursive: true, force: true })
}

finish()
