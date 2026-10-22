/*
 * Verifies that a chat workspace's pane never says it is disconnected while
 * the workspace starts, in real Chromium: from the new-workspace pane's
 * create through the chat pane's first attach, while it stops, and again
 * across a restart of the stopped workspace, where it also reports how long
 * the chat pane took to attach once mounted.
 *
 * A MutationObserver logs every change of the pane's state text (the
 * disconnect notice, the composer placeholder, the starting captions) with
 * a timestamp, alongside the ACP socket's frames, so a failure shows the
 * timeline that produced it.
 *
 * Needs a containerless server with a claude credential and a project.
 * Creates one workspace and stops it at the end.
 *
 * Run: PROJECT=<name or id> node test-playwright-scripts/acp-start-disconnected-flash.js
 */
import { SHOTS, api, check, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const { chromium } = requirePlaywright()
const project = await resolveProject(process.env.PROJECT ?? 'yaac')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const t0 = Date.now()
const stamp = () => `${String(Date.now() - t0).padStart(6)}ms`
let workspaceId

page.on('websocket', (ws) => {
  if (!ws.url().includes('/api/acp/')) return
  console.log(`${stamp()}  ws open ${ws.url().replace(/^.*\/api/, '/api')}`)
  ws.on('framereceived', (f) => {
    const type = typeof f.payload === 'string' ? f.payload.match(/"type":"([^"]+)"/)?.[1] : 'binary'
    if (type !== 'event') console.log(`${stamp()}  ws <- ${type} ${type === 'health' ? f.payload : ''}`)
  })
  ws.on('close', () => console.log(`${stamp()}  ws closed`))
})
/** Each connection state the composer shows, shot the first time it
 *  appears, for a look at how it reads. */
const shot = new Set()
await page.exposeFunction('logState', (s) => {
  console.log(`${stamp()}  state: ${s}`)
  const name = s.includes('Disconnected') ? 'disconnected' : s.startsWith('[Connecting…]') ? 'connecting' : undefined
  if (name === undefined || shot.has(name)) return
  shot.add(name)
  void page.screenshot({ path: `${SHOTS}/acp-start-${name}.png` }).catch(() => {})
})

/** Log the pane's state text whenever it changes; collected in
 *  `window.states` for the checks. */
const watch = () => {
  window.states = []
  let last = ''
  const read = () => {
    const text = document.body.innerText
    const box = document.querySelector('textarea[placeholder]')?.getAttribute('placeholder') ?? '-'
    const flags = ['Disconnected —', 'Connecting to the agent', 'The chat opens once', 'Starting ', 'Restarting ']
      .filter((f) => text.includes(f))
    const s = `[${box}] ${flags.join(' | ')}`
    if (s !== last) {
      last = s
      window.states.push(s)
      void window.logState(s)
    }
  }
  new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  read()
}

const sawDisconnected = () => window.states.some((s) => s.includes('Disconnected —') || s.includes('[Reconnecting…]'))

try {
  await page.goto(`${origin}/?project=${project.id}`)
  const box = page.getByLabel('Prompt')
  await box.waitFor()
  await box.fill('Reply with the single word pong, and do nothing else.')
  await page.getByLabel('UI').selectOption('acp')
  await until(page, () => document.querySelector('button[aria-label="Create"]')?.disabled === false)
  await page.evaluate(watch)
  // The ids already running, so the URL is read only once it names the new
  // workspace rather than one the app had open.
  const before = (await api('/workspace/list')).workspaces.map((w) => w.workspaceId)
  await box.press('Enter')
  await until(page, (ids) => {
    const id = new URL(location.href).searchParams.get('workspace')
    return id !== null && !ids.includes(id)
  }, before, 60_000)
  workspaceId = await page.evaluate(() => new URL(location.href).searchParams.get('workspace'))
  await page.getByText('pong', { exact: true }).waitFor({ timeout: 180_000 })
  check('create: never shown as disconnected', !(await page.evaluate(sawDisconnected)))
  await page.screenshot({ path: `${SHOTS}/acp-start-created.png` })

  await page.evaluate(watch)
  console.log(`${stamp()}  stopping ${workspaceId}`)
  await api('/workspace/stop', { method: 'POST', body: { workspaceId } })
  await page.waitForTimeout(3000)
  check('stop: never shown as disconnected', !(await page.evaluate(sawDisconnected)))
  await page.evaluate(watch)
  console.log(`${stamp()}  restarting`)
  // An NDJSON progress stream; read it out without waiting on it.
  void fetch(`${origin}/api/workspace/restart`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId }),
  }).then((r) => r.text())
  await until(page, () => document.querySelector('textarea[placeholder="Connecting…"]') !== null, undefined, 180_000)
  const mounted = Date.now()
  await until(page, () => document.querySelector('textarea[placeholder="Message the agent…"]') !== null, undefined, 180_000)
  console.log(`  restart: chat pane attached ${String(Date.now() - mounted)}ms after it mounted`)
  await page.waitForTimeout(3000)
  check('restart: never shown as disconnected', !(await page.evaluate(sawDisconnected)))
  await page.screenshot({ path: `${SHOTS}/acp-start-restarted.png` })
} finally {
  await browser.close()
  if (workspaceId) await api('/workspace/stop', { method: 'POST', body: { workspaceId } }).catch(() => {})
}
finish()
