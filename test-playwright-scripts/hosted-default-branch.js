/*
 * Verifies the "Default branch" setting of a yaac-hosted repo, reached from
 * a project's Repos section ("Manage repo") in Settings → Repos: it opens
 * on the repository's default, a change reaches the server, and both the
 * hosted remote's HEAD and the repo's branch list then name the new branch.
 *
 * PROJECT names a project whose first repo is hosted and has at least two
 * branches (default `default-branch-demo`); the script switches its default
 * to TO (default `develop`) and back, leaving it as it found it.
 *
 * Run: node test-playwright-scripts/hosted-default-branch.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'default-branch-demo'
const TO = process.env.TO ?? 'develop'

const { id } = await resolveProject(PROJECT)
const [repo] = (await api('/project/list')).find((p) => p.id === id).repos
const before = (await api(`/repo/${repo.id}/branches`)).defaultBranch

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
try {
  await page.goto(origin)
  await page.click('[title="Settings"]')
  await page.click('text=Project Config')
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(id)
  await page.getByRole('button', { name: 'Manage repo' }).first().click()

  const select = page.getByRole('combobox', { name: 'Default branch' })
  await select.waitFor()
  await until(page, (b) => [...document.querySelectorAll('select')].some((s) => s.value === b), before)
  check('opens on the current default', (await select.inputValue()) === before, before)

  await select.selectOption(TO)
  await until(page, () => ![...document.querySelectorAll('select')].some((s) => s.disabled && s.value !== ''), undefined)
  const after = await api(`/repo/${repo.id}/branches`)
  check('the server takes the new default', after.defaultBranch === TO, after.defaultBranch)
  check('the select shows it', (await select.inputValue()) === TO)
  await select.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(SHOTS, 'hosted-default-branch.png') })

  await api(`/repo/${repo.id}/default-branch`, { method: 'PUT', body: { branch: before } })
} finally {
  await browser.close()
}
finish()
