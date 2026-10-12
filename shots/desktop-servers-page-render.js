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
 *  4. Off the tailnet: the Tailscale banner shows while a remote server is
 *     saved (light and dark), not with only local servers saved, and a
 *     Connect that goes unanswered shows the real probe error with the
 *     Tailscale sentence (applyServerSwitch over the real probeServer).
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
    import { applyServerSwitch } from '#server-switch'
    import { probeServer, withServerSelected } from '@yaac/shared/server-config'
    const status = (s) => ({ kind: 'status', status: { running: true, driver: 'containerless', serverBuildId: 'b1',
      cliBuildId: 'b1', origin: 'http://127.0.0.1:8787', ...s } })
    const view = (local) => localView({ local, busy: null, setup: null, unfinished: [], brew: true, clusterSupported: true })
    const saved = ['http://127.0.0.1:8787', 'https://dead.ts.net', 'https://tagged.ts.net', 'https://up.ts.net']
    const overState = (tailnet) => ({
      targets: { current: 'http://127.0.0.1:8787', saved },
      local: view({ server: status({}), cluster: status({ driver: 'k8s', origin: 'http://127.0.0.1:8790', running: false }) }),
      tailnet,
    })
    const cfg = { url: 'http://127.0.0.1:8787', saved: saved.map((url) => ({ url })) }
    const switchError = await applyServerSwitch({ url: 'https://dead.ts.net' }, {
      readServerConfig: async () => cfg, writeServerConfig: async () => {}, select: withServerSelected,
      probeServer: () => probeServer('https://dead.invalid'), normalizeUrl: (u) => u, tailnetUp: () => false,
    })
    console.log(JSON.stringify({
      switchError: switchError.error,
      over: serversPageHtml(overState(true)),
      offTailnet: serversPageHtml(overState(false)),
      localOnlyOffTailnet: serversPageHtml({ ...overState(false), targets: { current: 'http://127.0.0.1:8787', saved: ['http://127.0.0.1:8787', 'http://localhost:9000', 'http://[::1]:9001'] } }),
      unreachable: serversPageHtml({
        error: { title: 'Could not connect to http://127.0.0.1:8787', detail: 'cannot reach http://127.0.0.1:8787: fetch failed' },
        targets: { current: 'http://127.0.0.1:8787', saved },
        local: view({ server: status({ running: false, serverBuildId: null }), cluster: status({ driver: null, running: false, origin: null }) }),
        tailnet: true,
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
    switchTo: (arg) => window.switchError
      ? (window.calls.push(['switchTo', arg]), Promise.resolve({ ok: false, error: window.switchError }))
      : ok('switchTo')(arg), addRemote: ok('addRemote'), remove: ok('remove'), disconnect: ok('disconnect'),
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
  check('on the tailnet, no banner', (await page.locator('.banner').count()) === 0)
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

  console.log('4. off the tailnet')
  await load(page, pages.offTailnet)
  check('the banner shows under the Servers heading',
    (await page.textContent('.banner')).includes('Tailscale does not seem to be running on this Mac'))
  check('remote rows still offer Connect', await page.isVisible('button.connect[data-url="https://dead.ts.net"]'))
  await page.screenshot({ path: path.join(SHOTS, 'servers-page-off-tailnet.png'), fullPage: true })
  await page.evaluate((e) => { window.switchError = e }, pages.switchError)
  await page.click('button.connect[data-url="https://dead.ts.net"]')
  await page.waitForFunction(() => document.querySelector('.status.error'), null, { timeout: 5000 })
  const shown = await page.textContent('.status.error')
  check('a Connect that goes unanswered names Tailscale', shown.includes('Tailscale does not seem to be running'), shown)
  await page.screenshot({ path: path.join(SHOTS, 'servers-page-off-tailnet-connect-failed.png'), fullPage: true })
  const dark = await browser.newPage({ viewport: { width: 900, height: 900 }, colorScheme: 'dark' })
  await dark.addInitScript(STUB)
  await load(dark, pages.offTailnet)
  await dark.screenshot({ path: path.join(SHOTS, 'servers-page-off-tailnet-dark.png'), fullPage: true })
  await load(page, pages.localOnlyOffTailnet)
  check('with only loopback origins saved (127.0.0.1, localhost, [::1]), no banner', (await page.locator('.banner').count()) === 0)
} finally {
  await browser.close()
}
finish()
