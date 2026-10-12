/*
 * Renders the desktop shell's Servers page (packages/desktop/src/servers-page.ts)
 * in headless Chromium with a stub `window.yaacServer` bridge, and checks
 * what needs no Electron:
 *
 *  1. Opened over a connected local server: the local installs are rows
 *     named "Local containerless server (origin)" and "Local Kubernetes
 *     cluster (origin)", the selected one with Disconnect and Stop, and
 *     saved remotes that do not answer or refuse this device are marked
 *     "(stopped)" or "(refused)", with the reason, once the probe comes back.
 *  2. Disconnect and Stop reach the bridge.
 *  3. Unreachable, on a Mac with only the host install: the failure on top,
 *     Try again, and the cluster's setup folded under the list.
 *
 * Screenshots go to $SCREENSHOT_DIR (default /tmp/yaac-shots).
 *
 * Run: node test-playwright-scripts/desktop-servers-page-render.js
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { check, finish, requirePlaywright, SHOTS } from './lib.js'

const REPO = path.resolve(import.meta.dirname, '..')

/** The page's HTML for each named state, rendered by the real module under tsx. */
function renderPages() {
  const code = `
    import { serversPageHtml } from '#servers-page'
    import { localView } from '#local-setup'
    const status = (s) => ({ kind: 'status', status: { running: true, driver: 'containerless', serverBuildId: 'b1',
      cliBuildId: 'b1', origin: 'http://127.0.0.1:8787', ...s } })
    const view = (local) => localView({ local, busy: null, setup: null, unfinished: [], brew: true, clusterSupported: true })
    const saved = ['http://127.0.0.1:8787', 'https://dead.ts.net', 'https://tagged.ts.net', 'https://up.ts.net']
    console.log(JSON.stringify({
      over: serversPageHtml({
        targets: { current: 'http://127.0.0.1:8787', saved },
        local: view({ server: status({}), cluster: status({ driver: 'k8s', origin: 'http://127.0.0.1:8790', running: false }) }),
      }),
      unreachable: serversPageHtml({
        error: { title: 'Could not connect to http://127.0.0.1:8787', detail: 'cannot reach http://127.0.0.1:8787: fetch failed' },
        targets: { current: 'http://127.0.0.1:8787', saved },
        local: view({ server: status({ running: false, serverBuildId: null }), cluster: status({ driver: null, running: false, origin: null }) }),
      }),
    }))
  `
  const out = execFileSync('pnpm', ['--filter', '@yaac/desktop', 'exec', 'tsx', '--input-type=module', '-e', code],
    { cwd: REPO, encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('{')))
}

const STUB = `
  window.calls = []
  const ok = (name) => (arg) => { window.calls.push([name, arg]); return Promise.resolve({ ok: true }) }
  window.yaacServer = {
    switchTo: ok('switchTo'), addRemote: ok('addRemote'), remove: ok('remove'), disconnect: ok('disconnect'),
    retry: ok('retry'), startLocal: ok('startLocal'), stopLocal: ok('stopLocal'), setupLocal: ok('setupLocal'),
    cancelSetup: ok('cancelSetup'),
    localState: () => new Promise(() => {}),
    serverHealth: () => new Promise((r) => setTimeout(() => r({
      'https://dead.ts.net': { kind: 'stopped' },
      'https://tagged.ts.net': { kind: 'refused', reason: 'https://tagged.ts.net refused to identify this device' },
    }), 300)),
  }
`

const pages = renderPages()
/** Load a page as the shell does, from a data: URL, so the stub bridge is in place first. */
const load = (page, html) => page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.addInitScript(STUB)

  console.log('1. opened over a connected local server')
  await load(page, pages.over)
  const host = await page.textContent('#install-server')
  check('the host install is named with its origin', host.includes('Local containerless server (http://127.0.0.1:8787)'), host.trim())
  check('it is selected, with Disconnect and Stop',
    await page.isVisible('#install-server button.disconnect') && await page.isVisible('#install-server button.stop'))
  const cluster = await page.textContent('#install-cluster')
  check('the cluster install is named with its origin, with Start',
    cluster.includes('Local Kubernetes cluster (http://127.0.0.1:8790)') && await page.isVisible('#install-cluster button.start'),
    cluster.trim())
  check('the local origin is not listed a second time', (await page.locator('.origin', { hasText: '127.0.0.1:8787' }).count()) === 0)
  await page.waitForSelector('.tag.health[data-url="https://dead.ts.net"]:not([hidden])', { timeout: 5000 })
  check('a remote that does not answer is marked (stopped)',
    (await page.textContent('.tag.health[data-url="https://dead.ts.net"]')) === '(stopped)')
  const refused = page.locator('.tag.health[data-url="https://tagged.ts.net"]')
  check('one that refuses this device is marked (refused), with the reason',
    (await refused.textContent()) === '(refused)' && (await refused.getAttribute('title')).includes('refused to identify'))
  check('one that answers is not marked', await page.isHidden('.tag.health[data-url="https://up.ts.net"]'))
  check('Back, not Try again', (await page.textContent('#retry')).trim() === 'Back')
  await page.screenshot({ path: path.join(SHOTS, 'servers-page-over.png'), fullPage: true })

  console.log('2. Disconnect and Stop reach the bridge')
  await page.click('#install-server button.disconnect')
  check('Disconnect calls the bridge', JSON.stringify(await page.evaluate(() => window.calls)) === '[["disconnect",null]]',
    JSON.stringify(await page.evaluate(() => window.calls)))
  await load(page, pages.over)
  await page.click('#install-server button.stop')
  check('Stop stops the host server', JSON.stringify(await page.evaluate(() => window.calls)) === '[["stopLocal","server"]]',
    JSON.stringify(await page.evaluate(() => window.calls)))

  console.log('3. unreachable, only the host install')
  await load(page, pages.unreachable)
  check('states the failure', (await page.textContent('h1')).includes('Could not connect'))
  check('Try again', (await page.textContent('#retry')).trim() === 'Try again')
  check('the selected install, though stopped, has Start and Disconnect but no Connect',
    await page.isVisible('#install-server button.start') && await page.isVisible('#install-server button.disconnect')
    && await page.isHidden('#install-server button.connect'))
  check('the cluster setup is folded under the list',
    await page.isVisible('#choice-cluster summary') && !(await page.evaluate(() => document.getElementById('choice-cluster').open)))
  await page.screenshot({ path: path.join(SHOTS, 'servers-page-unreachable.png'), fullPage: true })
} finally {
  await browser.close()
}
finish()
