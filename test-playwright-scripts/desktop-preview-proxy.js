/*
 * Verifies the desktop preview pane's proxy (docs/port-forward-tunnel.md
 * "The desktop preview pane") in real Electron: a session whose proxy is
 * fixed rules `socks5://…` with bypass rules `<-loopback>`, pointed at the
 * real `startSocksTunnel`, which tunnels over a stand-in
 * `/api/forward/attach` to a local dev server.
 *
 *  1. A proxy set before a <webview> guest's first navigation applies to
 *     it, and so does one set from `will-attach-webview` without awaiting.
 *  2. `localhost`, `127.0.0.1`, `*.localhost` and `[::1]` all reach the
 *     workspace port, so Chromium hands the proxy names rather than
 *     resolving them itself.
 *  2b. A page cannot reach a server of this machine's around the tunnel,
 *     through `0.0.0.0`, `[::]` or the machine's own non-loopback address,
 *     as an iframe or a fetch. (That public hosts still load needs a network
 *     this script does not assume.)
 *  3. A WebSocket from the guest goes through the proxy, and the dev server
 *     sees the page's own `Host` and `Origin`.
 *  4. A port the route does not offer fails to load and reaches nothing.
 *  5. Under a PAC script loopback goes direct whatever the script answers,
 *     which is why the pane does not use one.
 *
 * Needs no yaac server or workspace. Needs the Electron binary
 * (`node packages/desktop/node_modules/electron/install.js`), a machine
 * with a non-loopback IPv4 address, and an X display. Run from the repo
 * root, e.g.
 *   Xvfb :99 &
 *   DISPLAY=:99 node test-playwright-scripts/desktop-preview-proxy.js
 * Run under node, it relaunches itself as Electron's main process, with tsx
 * loaded so it can import the TypeScript source.
 */
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)

if (!process.versions.electron) {
  const electron = path.resolve(path.dirname(self), '../packages/desktop/node_modules/electron/dist/electron')
  const run = spawnSync(electron, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', self], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import tsx` },
  })
  process.exit(run.status ?? 1)
}

/* Electron fires `ready` only once the main module has finished loading,
 * so nothing here may await it at the top level. */
void main().catch((err) => {
  console.error(err)
  process.exit(1)
})

async function main() {
  const { check, finish } = await import('./lib.js')
  const { app, BrowserWindow, session } = await import('electron')
  const { WebSocketServer } = await import('ws')
  const { startSocksTunnel } = await import('../packages/shared/src/port-tunnel.ts')

  const external = Object.values(os.networkInterfaces()).flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address
  if (!external) throw new Error('no non-loopback IPv4 address to test direct connections with')

  const listen = (server, host = '127.0.0.1') => new Promise((r) => server.listen(0, host, () => r(server.address().port)))

  /** What the proxy was asked for and the servers saw, reset per scenario. */
  let routed = []
  let hits = []

  // The dev server: a page that opens a WebSocket back to its own origin
  // and tries to reach a server of this machine's around the tunnel.
  let hostPort = 0
  const around = ['0.0.0.0', '[::]', external]
  const dev = http.createServer((req, res) => {
    hits.push(`page ${req.url} ${req.headers.host}`)
    res.end(`<script>new WebSocket('ws://' + location.host + '/ws')</script>`
      + around.map((h) => `<iframe src="http://${h}:${String(hostPort)}/frame"></iframe>`
        + `<script>fetch('http://${h}:${String(hostPort)}/fetch', { mode: 'no-cors' }).catch(() => {})</script>`).join(''))
  })
  dev.on('upgrade', (req, socket) => {
    hits.push(`ws ${req.headers.host} ${req.headers.origin}`)
    socket.end()
  })
  const devPort = await listen(dev)
  // On every address this machine has.
  hostPort = await listen(http.createServer((req, res) => {
    hits.push(`host ${req.url} ${req.headers.host}`)
    res.end()
  }), '::')

  // The server's `/api/forward/attach`: each tunnel dials the dev server.
  const attach = http.createServer()
  new WebSocketServer({ server: attach }).on('connection', (ws) => {
    const socket = net.connect(devPort, '127.0.0.1')
    socket.on('data', (chunk) => ws.send(chunk))
    socket.on('close', () => ws.close())
    ws.on('message', (data) => socket.write(data))
    ws.on('close', () => socket.destroy())
  })
  const baseUrl = `http://127.0.0.1:${String(await listen(attach))}`

  // The pane's listener, offering workspace port 3000 only.
  const proxy = await startSocksTunnel((port) => {
    routed.push(port)
    return Promise.resolve(port === 3000 ? { target: { baseUrl }, spec: { session: 'ws-1', containerPort: port } } : undefined)
  })
  const FIXED = { proxyRules: `socks5://127.0.0.1:${String(proxy.hostPort)}`, proxyBypassRules: '<-loopback>' }
  const PAC = {
    mode: 'pac_script',
    pacScript: `data:text/plain,${encodeURIComponent(
      `function FindProxyForURL(u, h) { return "SOCKS5 127.0.0.1:${String(proxy.hostPort)}" }`)}`,
  }
  const LOOPBACK = ['http://localhost:3000/a', 'http://127.0.0.1:3000/b', 'http://app.localhost:3000/c', 'http://[::1]:3000/d']

  await app.whenReady()
  const win = new BrowserWindow({ show: false, webPreferences: { webviewTag: true } })
  let onAttach = () => {}
  win.webContents.on('will-attach-webview', (_e, _prefs, params) => onAttach(params.partition))
  await win.loadURL('data:text/html,<body></body>')

  /** Load each URL in a fresh <webview> on `partition`; resolves the failed
   *  loads' error codes. */
  async function loadAll(partition, urls) {
    routed = []
    hits = []
    return win.webContents.executeJavaScript(`(async () => {
      const failed = []
      for (const url of ${JSON.stringify(urls)}) {
        await new Promise((resolve) => {
          const wv = document.createElement('webview')
          wv.setAttribute('partition', ${JSON.stringify(partition)})
          wv.src = url
          wv.addEventListener('did-fail-load', (e) => { if (e.isMainFrame) failed.push(e.errorCode) })
          wv.addEventListener('did-stop-loading', () => setTimeout(resolve, 1000))
          document.body.append(wv)
        })
      }
      return failed
    })()`)
  }

  for (const how of ['before', 'will-attach-webview']) {
    const partition = `persist:proxy-${how}`
    if (how === 'before') await session.fromPartition(partition).setProxy(FIXED)
    else onAttach = (p) => { if (p === partition) void session.fromPartition(p).setProxy(FIXED) }
    const failed = await loadAll(partition, LOOPBACK)
    check(`[${how}] every loopback load succeeds`, failed.length === 0, JSON.stringify(failed))
    check(`[${how}] every loopback name reaches the workspace port with its own Host`,
      ['localhost:3000', '127.0.0.1:3000', 'app.localhost:3000', '[::1]:3000']
        .every((host) => hits.some((h) => h.startsWith('page ') && h.endsWith(` ${host}`))),
      JSON.stringify(hits))
    check(`[${how}] the proxy is asked only for the workspace port`, routed.every((p) => p === 3000), JSON.stringify(routed))
    check(`[${how}] nothing reaches this machine around the tunnel`, !hits.some((h) => h.startsWith('host ')),
      JSON.stringify(hits))
    check(`[${how}] the WebSocket is proxied with the page's Host and Origin`,
      hits.includes('ws localhost:3000 http://localhost:3000') && hits.includes('ws 127.0.0.1:3000 http://127.0.0.1:3000'),
      JSON.stringify(hits))
  }
  onAttach = () => {}

  const refused = await loadAll('persist:proxy-before', ['http://localhost:4000/'])
  check('a port the route does not offer fails to load', refused.length > 0, JSON.stringify(refused))
  check('and reaches nothing', routed.includes(4000) && hits.length === 0, JSON.stringify({ routed, hits }))

  await session.fromPartition('persist:proxy-pac').setProxy(PAC)
  await loadAll('persist:proxy-pac', LOOPBACK)
  check('[pac] loopback goes direct whatever the script answers', routed.length === 0, JSON.stringify(routed))

  proxy.close()
  finish()
}
