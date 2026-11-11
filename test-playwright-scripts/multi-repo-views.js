/*
 * Verifies the webapp's views of a project with several repos
 * (docs/project-repos.md):
 *
 *  1. the create form shows one row per repo, each with its branch, and a
 *     "Start in" picker;
 *  2. a workspace with several checkouts offers a repo switcher beside its
 *     changes;
 *  3. Settings → Repos lists the project's repos;
 *  4. Settings → Project Config has a Repos section naming each folder.
 *
 * PROJECT (default `multi`) must link at least two repos, and WORKSPACE_ID
 * must be a running workspace of it created with both. To make them:
 *
 *   yaac project create multi && yaac project repo add multi --hosted --dir web
 *   yaac workspace create multi --no-session
 *
 * Run: WORKSPACE_ID=<id> node test-playwright-scripts/multi-repo-views.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject } from './lib.js'

const project = await resolveProject(process.env.PROJECT ?? 'multi')
const repos = (await api('/project/list')).find((p) => p.id === project.id).repos
const workspaceId = process.env.WORKSPACE_ID

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `multi-repo-${name}.png`) })

try {
  await page.goto(`${origin}/?project=${project.id}`)
  await page.locator('[aria-label="New workspace"]').first().click()
  await page.getByText('Start in').waitFor({ timeout: 15_000 })
  for (const repo of repos) {
    check(`the create form has a row for ${repo.dir}`, await page.getByLabel(repo.dir, { exact: true }).count() > 0
      || await page.getByText(repo.dir, { exact: true }).count() > 0)
  }
  await shot('create')

  if (workspaceId) {
    await page.goto(`${origin}/?project=${project.id}&workspace=${workspaceId}`)
    await page.getByText('Changes').first().click()
    const switcher = page.locator('select[aria-label="Repo"]').first()
    await switcher.waitFor({ timeout: 15_000 })
    const options = await switcher.locator('option').allTextContents()
    check('the changes view offers each checkout', repos.every((r) => options.some((o) => o.includes(r.dir))), options.join(', '))
    await shot('changes')
  }

  await page.goto(`${origin}/?project=${project.id}`)
  await page.locator('[title="Settings"]').first().click()
  await page.getByRole('button', { name: 'Repos', exact: true }).first().click()
  await page.getByRole('button', { name: 'Manage' }).first().waitFor({ timeout: 15_000 })
  check('Settings → Repos lists hosted repos', await page.getByText(/hosted by yaac/i).count() >= 1)
  await page.waitForTimeout(300)
  await shot('settings-repos')

  await page.getByRole('button', { name: 'Project Config', exact: true }).first().click()
  await page.getByText('Repos', { exact: true }).first().waitFor({ timeout: 15_000 })
  for (const repo of repos) {
    check(`Project Config names the folder ${repo.dir}`,
      await page.locator(`input[value="${repo.dir}"]`).count() + await page.getByText(repo.dir, { exact: true }).count() > 0)
  }
  await shot('project-repos')
} finally {
  await browser.close()
}
finish()
