/*
 * Verifies the desktop preview pane's route into its workspace
 * (docs/port-forward-tunnel.md "The desktop preview pane") through the real
 * desktop app and server: the preload's `routePreview`, the main process's
 * listener and session proxy, and the forwarder's route over the server's
 * `/api/forward/attach`.
 *
 *  1. `routePreview` answers true for the workspace.
 *  2. A <webview> on that workspace's partition loads
 *     `http://localhost:<port>/` from the workspace's dev server, which sees
 *     `Host: localhost:<port>`.
 *  3. The same session cannot reach a port the workspace does not offer,
 *     the yaac server's own among them, though the server answers there.
 *  4. The bridge refuses a malformed workspace id.
 *
 * Needs a running server with a running workspace that offers a forwarded
 * port its dev server answers on with an HTML page; set WORKSPACE to its id,
 * else the first such workspace is used. For example, against a
 * containerless server:
 *   yaac config port-forwards <project> 3000
 *   yaac workspace create <project> --no-agent --steps steps.json
 * with a `steps.json` whose one service step serves `$YAAC_PORT_3000`. The
 * server serves the SPA it started with, so `pnpm build` and `yaac server
 * restart` first. Also needs the desktop bundle
 * (`pnpm --filter @yaac/desktop build`), the Electron binary
 * (`node packages/desktop/node_modules/electron/install.js`) and an X
 * display, e.g.
 *   Xvfb :99 &
 *   DISPLAY=:99 node test-playwright-scripts/desktop-preview-pane.js
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, check, finish, origin } from './lib.js'

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/desktop')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => (process.env.WORKSPACE ? w.workspaceId.startsWith(process.env.WORKSPACE) : true)
  && w.forwardedPorts.length > 0)
if (!workspace) throw new Error('no running workspace offers a forwarded port')
const id = workspace.workspaceId
const port = workspace.forwardedPorts[0].containerPort
const serverPort = Number(new URL(origin).port)

const electron = spawn(path.join(desktopDir, 'node_modules/electron/dist/electron'),
  ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', '.'],
  { cwd: desktopDir, stdio: ['ignore', 'ignore', 'pipe'] })
const devtools = await new Promise((resolve, reject) => {
  let err = ''
  electron.stderr.on('data', (d) => {
    err += d
    const m = /DevTools listening on ws:\/\/([^/]+)\//.exec(err)
    if (m) resolve(`http://${m[1]}`)
  })
  electron.once('exit', () => reject(new Error(`electron exited:\n${err}`)))
})

/** Evaluate in the SPA's window, over a raw DevTools connection. */
async function spaWindow(timeout = 60_000) {
  const until = Date.now() + timeout
  for (;;) {
    const target = (await (await fetch(`${devtools}/json/list`)).json()).find((t) => t.type === 'page' && /^http/.test(t.url))
    if (target) {
      const ws = new WebSocket(target.webSocketDebuggerUrl)
      await new Promise((r) => ws.addEventListener('open', r, { once: true }))
      let next = 0
      const pending = new Map()
      ws.addEventListener('message', (e) => {
        const msg = JSON.parse(e.data)
        pending.get(msg.id)?.(msg)
        pending.delete(msg.id)
      })
      const evaluate = (expression) => new Promise((resolve, reject) => {
        const n = ++next
        pending.set(n, (msg) => {
          const { result, exceptionDetails } = msg.result ?? {}
          if (msg.error || exceptionDetails) reject(new Error(msg.error?.message ?? exceptionDetails.exception?.description))
          else resolve(result.value)
        })
        ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      })
      return { evaluate, close: () => ws.close() }
    }
    if (Date.now() > until) throw new Error('the SPA never loaded')
    await sleep(250)
  }
}

/** Load `url` in a fresh <webview> on the workspace's partition; resolves
 *  its title, or the error code its load failed with. */
const load = (url) => `new Promise((resolve) => {
  const wv = document.createElement('webview')
  wv.setAttribute('partition', 'persist:preview-${id}')
  wv.src = ${JSON.stringify(url)}
  wv.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3) resolve({ failed: e.errorCode }) })
  wv.addEventListener('did-finish-load', () => resolve({ title: wv.getTitle() }))
  document.body.append(wv)
})`

try {
  const win = await spaWindow()
  for (let i = 0; !(await win.evaluate('window.yaacWindow?.routePreview !== undefined')); i++) {
    if (i > 240) throw new Error('the preload bridge has no routePreview')
    await sleep(250)
  }

  // (1)
  check('routePreview routes the workspace', await win.evaluate(`window.yaacWindow.routePreview('${id}')`) === true)

  // (2)
  const page = await win.evaluate(load(`http://localhost:${String(port)}/`))
  check(`localhost:${String(port)} loads the workspace's page`, page.title !== undefined, JSON.stringify(page))
  check('the dev server sees the pane\'s own Host', page.title?.includes(`localhost:${String(port)}`) === true, JSON.stringify(page))

  // (3)
  const server = await win.evaluate(load(`http://localhost:${String(serverPort)}/`))
  check(`the server's port ${String(serverPort)} is refused in the pane`, server.failed !== undefined, JSON.stringify(server))

  // (4)
  check('a malformed id is refused', await win.evaluate(`window.yaacWindow.routePreview('../x')`) === false)
  win.close()
} finally {
  electron.kill()
}
finish()
