/*
 * Verifies workspace hostnames (docs/workspace-hostnames.md) in a real
 * Chromium. It checks that Chromium resolves `<port>.<id8>.localhost` to
 * this machine's loopback on its own, and that a page loaded through a
 * hostname router can open a WebSocket back to its own origin, as an HMR
 * client does. Both routers are checked:
 *  - the server's (`routeWorkspaceHosts`), over a stand-in driver whose
 *    `dialPort` connects to a local dev server;
 *  - a remote client's (`createForwardSet` with `hostsPort`), over a
 *    stand-in `/api/forward/attach` that does the same.
 *
 * Needs no yaac server. Run from the repo root:
 *   pnpm exec tsx test-playwright-scripts/workspace-hostnames.js
 */
import http from 'node:http'
import net from 'node:net'
import { WebSocketServer } from 'ws'
import { check, finish, requirePlaywright } from './lib.js'
import { routeWorkspaceHosts } from '../packages/server/src/api/http/workspace-hosts.ts'
import { setWorkspaceDriver } from '../packages/server/src/drivers/driver.ts'
import { createForwardSet } from '../packages/shared/src/port-tunnel-set.ts'
import { workspaceHostUrl } from '../packages/shared/src/workspace-hosts.ts'

const ID = 'ab12cd34-0000-4000-8000-000000000000'
const PAGE = `<!doctype html><script>
  const ws = new WebSocket('ws://' + location.host + '/hmr')
  ws.onopen = () => ws.send('ping')
  ws.onmessage = (e) => { document.title = 'echo ' + e.data }
</script>`

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const dialDev = (port) => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => resolve(socket))
  socket.once('error', reject)
})

// The dev server: the page, its Host, and a WebSocket echo.
const seenHosts = []
const dev = http.createServer((req, res) => {
  seenHosts.push(req.headers.host)
  res.setHeader('content-type', 'text/html')
  res.end(PAGE)
})
new WebSocketServer({ server: dev }).on('connection', (ws) => ws.on('message', (m) => ws.send(String(m))))
const devPort = await listen(dev)

// The server's router, over a driver that reaches the dev server.
setWorkspaceDriver({
  list: () => Promise.resolve([{ workspaceId: ID, running: true, prewarmed: false }]),
  dialPort: (_id, port) => port === devPort ? dialDev(devPort) : Promise.reject(new Error('not listening')),
})
const api = http.createServer((_req, res) => res.end('the yaac API'))
routeWorkspaceHosts(api, () => 'local')
const apiPort = await listen(api)

// A stand-in server for a remote client: each tunnel dials the dev server.
const attach = http.createServer()
new WebSocketServer({ server: attach }).on('connection', async (ws) => {
  const socket = await dialDev(devPort)
  socket.on('data', (chunk) => ws.send(chunk))
  ws.on('message', (data) => socket.write(data))
  ws.on('close', () => socket.destroy())
  socket.on('close', () => ws.close())
})
const attachPort = await listen(attach)
const set = createForwardSet({ baseUrl: `http://127.0.0.1:${attachPort}` }, { hostsPort: 0 })
await set.reconcile([{ session: ID, containerPort: devPort, hostPort: 0 }])

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  for (const [router, port] of [['server', apiPort], ['client forwarder', set.hostsPort()]]) {
    const url = workspaceHostUrl(ID, devPort, port)
    await page.goto(url)
    const title = await page.waitForFunction(() => document.title.startsWith('echo'), null, { timeout: 10_000 })
      .then(() => page.title(), () => page.title())
    check(`${router}: the page loads at ${url}`, seenHosts.at(-1) === new URL(url).host, seenHosts.at(-1))
    check(`${router}: its WebSocket echoes through the same name`, title === 'echo ping', title)
  }
  // The server's own hosts still reach the API.
  await page.goto(`http://localhost:${apiPort}/`)
  check('server: localhost still reaches the API', (await page.textContent('body')) === 'the yaac API')
} finally {
  await browser.close()
  set.close()
  for (const server of [api, dev, attach]) server.closeAllConnections()
}
finish()
