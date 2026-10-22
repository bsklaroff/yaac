/*
 * Verifies the Skills section of settings in the running server's webapp, in
 * Chromium: settings opens full-screen, the section is headed by the viewed
 * project, it lists every agent's skills at once with personal ones filed
 * under their agent and each section naming the agents that read it, clicking a
 * skill shows its full SKILL.md, and the agent filter narrows the list.
 *
 * Seeds a personal Claude skill and a Codex skill under
 * <data dir>/global/projects/<project id>/ and removes them afterwards, so it
 * is safe to re-run. The project (repo) tier is not seeded: it is read from
 * origin/<branch>, so a working-tree file would not be listed.
 *
 * Needs a running `yaac server` with a project (PROJECT, default yaac).
 *
 * Run: YAAC_DATA_DIR=... PROJECT=<name or id> node test-playwright-scripts/skills-viewer-test.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, SHOTS, check, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

/** Base dir for a project's on-disk config/repo (mirrors @yaac/shared paths). */
function projectBase(projectId) {
  return path.join(DATA_DIR, 'global', 'projects', projectId)
}

/** Seed a personal Claude skill and a Codex skill; return their dirs. */
function seedSkills(projectId) {
  const base = projectBase(projectId)
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
const project = (await resolveProject(process.env.PROJECT || 'yaac')).id
const seededDirs = seedSkills(project)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

try {
  await page.goto(`${origin}/?project=${project}`)

  const settingsBtn = page.getByTitle('Settings').first()
  await settingsBtn.waitFor({ state: 'visible', timeout: 15000 })
  await settingsBtn.click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.waitForTimeout(400) // open transition

  check('settings fills the window', await dialog.evaluate((e) => {
    const r = e.getBoundingClientRect()
    return r.width === innerWidth && r.height === innerHeight
  }))
  check('the section is headed by the viewed project',
    await dialog.getByRole('combobox', { name: 'Project' }).inputValue() === project)

  const personal = dialog.getByRole('button', { name: /\/hello-personal/ })
  const codex = dialog.getByRole('button', { name: /\/hello-codex/ })
  await personal.waitFor({ state: 'visible', timeout: 10000 })
  check('both agents\' skills are listed together', await codex.count() === 1)
  const headers = await dialog.locator('li > div').allInnerTexts()
  const header = (agent) => headers.find((h) => h.split(/\s+/)[0] === agent) ?? ''
  check('personal skills are filed under their agent', header('CLAUDE') !== '' && header('CODEX') !== '',
    headers.join(' | '))
  check('the Claude section names the agents that read it (Claude and OpenCode)',
    /Claude\s+OpenCode/.test(header('CLAUDE')), header('CLAUDE'))

  await personal.click()
  // The body loads on its own fetch after the click.
  const body = await until(page, () => document.querySelector('[role="dialog"]')?.textContent
    .includes('This is the personal skill body'), null, 10_000).then(() => true, () => false)
  check('detail pane shows the skill body', body)
  check('detail pane shows allowed-tools', await dialog.getByText(/Read, Grep/).count() >= 1)
  await page.screenshot({ path: path.join(SHOTS, 'skills-viewer-all.png') })

  await dialog.getByRole('group', { name: 'Filter by agent' }).getByRole('button', { name: 'Codex' }).click()
  check('the codex filter keeps the codex skill', await codex.count() === 1)
  check('the codex filter drops the claude skill', await personal.count() === 0)
  await page.screenshot({ path: path.join(SHOTS, 'skills-viewer-codex.png') })
} finally {
  await browser.close()
  for (const dir of seededDirs) fs.rmSync(dir, { recursive: true, force: true })
}

finish()
