/*
 * Verifies Settings → Project Config's Environment, Secrets and Egress
 * allowlist lists: secrets show masked with their hosts, the allowlist shows
 * the collapsed defaults, the project's added hosts and the closing
 * "everything else" row, and adding, removing and turning the defaults off
 * each PUT the whole list. The allowlist routes are stubbed in the page (a
 * containerless server answers them 501 and hides the panel, so run it
 * against a k8s server, or a build with `mediatedEgress` forced on). The env
 * rows are real, seeded through the API and removed at the end (a variable
 * of the same name already there is overwritten, then removed).
 * SCREENSHOT_DIR gets project-env.png and project-egress-allowlist.png.
 *
 * Needs a running `yaac server` with a project added (see lib.js).
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/project-egress-allowlist.js
 */
import path from 'node:path'
import { requirePlaywright, origin, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()

const [project] = await (await fetch(`${origin}/api/project/list`)).json()
const env = `${origin}/api/project/${project.id}/env`
const put = (body) => fetch(env, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
await put({ name: 'NODE_ENV', value: 'development' })
await put({ name: 'STRIPE_API_KEY', value: 'sk', secret: true, rule: { hosts: ['api.stripe.com'] } })
await put({ name: 'SENTRY_TOKEN', value: 'st', secret: true, rule: { hosts: ['sentry.io'] } })

let allowlist = { hosts: ['*.mycdn.example.com', 'old.example.com'], defaults: true }
const puts = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 1100 }, colorScheme: 'dark' })
page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
await page.route('**/api/project/*/allowlist', async (route) => {
  if (route.request().method() === 'PUT') {
    allowlist = route.request().postDataJSON()
    puts.push(allowlist)
    return route.fulfill({ json: { allowlist } })
  }
  return route.fulfill({ json: { allowlist, defaultHosts: ['api.anthropic.com', 'github.com', 'registry.npmjs.org'] } })
})

await page.goto(`${origin}/`)
await page.getByRole('button', { name: 'Settings' }).click()
await page.getByRole('button', { name: 'Project Config' }).click()
await page.getByText('Egress allowlist').waitFor()
await page.getByText('api.stripe.com').waitFor()

check('a secret shows masked, with its host',
  await page.getByText('••••••••').count() === 2 && await page.getByText('api.stripe.com').isVisible())
check('a plain variable shows its value', await page.getByText('development').isVisible())
check('the defaults are one collapsed row', await page.getByText('3 default hosts').isVisible()
  && !await page.getByText('registry.npmjs.org').isVisible())
await page.getByText('3 default hosts').click()
check('expanding lists each default', await page.getByText('registry.npmjs.org').isVisible())
check('everything else is blocked', await page.getByText('everything else').isVisible()
  && await page.getByText('blocked', { exact: true }).isVisible())

await page.getByPlaceholder('api.example.com or *.example.com').fill('extra.example.com')
await page.getByRole('button', { name: 'Add', exact: true }).last().click()
await page.getByText('extra.example.com').waitFor()
await page.getByLabel('Remove old.example.com').click()
await page.getByText('old.example.com').waitFor({ state: 'hidden' })
check('add and remove each PUT the whole list', JSON.stringify(puts) === JSON.stringify([
  { hosts: ['*.mycdn.example.com', 'old.example.com', 'extra.example.com'], defaults: true },
  { hosts: ['*.mycdn.example.com', 'extra.example.com'], defaults: true },
]))

await page.getByText('Environment', { exact: true }).scrollIntoViewIfNeeded()
await page.screenshot({ path: path.join(SHOTS, 'project-env.png') })
await page.getByText('Egress allowlist').scrollIntoViewIfNeeded()
await page.screenshot({ path: path.join(SHOTS, 'project-egress-allowlist.png') })

// Controlled by the saved list, so the box flips once the PUT lands.
await page.getByLabel('Allow the default hosts', { exact: false }).click()
await page.getByText('blocked', { exact: true }).first().waitFor()
check('turning the defaults off keeps the added hosts', puts.at(-1)?.defaults === false && puts.at(-1).hosts.length === 2)

await browser.close()
const seeded = ['NODE_ENV', 'STRIPE_API_KEY', 'SENTRY_TOKEN']
for (const v of (await (await fetch(env)).json()).vars) {
  if (seeded.includes(v.name)) await fetch(`${env}/${v.id}`, { method: 'DELETE' })
}
finish()
