/*
 * Verifies pasting and dropping images into agent panes in real Chromium
 * (docs/agent-modes.md, "Images") — the parts jsdom cannot answer, since it
 * decodes no images and has no xterm:
 *
 *   1. A terminal pane claims an image paste before xterm sees it, uploads a
 *      downscaled copy (a 3000x2000 screenshot lands at most 1568 px on its
 *      long edge), and pastes the path back — which claude turns into an
 *      `[Image #N]` attachment.
 *   2. A paste that carries text is still xterm's: the text reaches the pane.
 *   3. An image dropped on the terminal takes the same path.
 *   3b. So does a real Ctrl+Shift+V with an image on the system clipboard —
 *      the chord browsers run as paste-as-plain-text, whose own paste event
 *      carries no image, so the pane reads the clipboard for it.
 *   4. The chat composer shows a pasted image as a removable thumbnail, sends
 *      it with the message, and the conversation shows it in the user's turn
 *      once the echo lands — with the composer emptied.
 *
 * Needs a running containerless `yaac server` with two live claude worktrees
 * of one project: a terminal one and a chat one, e.g. `yaac project add
 * https://github.com/octocat/Hello-World.git <cred>`, then `yaac worktree
 * create hello-world --tool claude` and `... --tool claude --mode acp`
 * (in a yaac worktree, `yaac auth fake claude-oauth github` supplies the
 * credentials). Run `pnpm build && yaac server restart` first, or you are
 * looking at the frontend `dist/` held when the server started. Spends one
 * small prompt turn on the chat agent.
 *
 * Run: node test-playwright-scripts/paste-image-test.js <tui-worktree-id> <acp-worktree-id>
 * (set SCREENSHOT_DIR to change where screenshots land; defaults to
 * /tmp/yaac-shots. YAAC_DATA_DIR defaults to ~/.yaac.)
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

const { chromium } = requirePlaywright()
const DATA_DIR = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')
const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'

function readServerLock() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'server-local', '.server.lock'), 'utf8'))
}

const [tuiId, acpId] = process.argv.slice(2)
if (!tuiId || !acpId) {
  console.error('usage: node test-playwright-scripts/paste-image-test.js <tui-worktree-id> <acp-worktree-id>')
  process.exit(1)
}

const failures = []
function check(ok, label, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** Poll with `page.evaluate` rather than `waitForFunction`: the served app's
 *  CSP forbids the `new Function` that API compiles its predicate with. */
async function eventually(fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value || Date.now() > deadline) return value
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Everything the page's mounted terminals show. */
const screenText = (page) => page.evaluate(() => [...(window.__xterms ?? [])].map((t) => {
  const buf = t.buffer.active
  const rows = []
  for (let y = 0; y < buf.length; y++) rows.push(buf.getLine(y)?.translateToString(true) ?? '')
  return rows.join('\n')
}).join('\n'))

/**
 * Dispatch a paste (or drop) carrying a freshly drawn PNG of `w`x`h`, and/or
 * text, at `selector` — built in the page, since a DataTransfer cannot cross
 * the protocol boundary.
 */
async function fire(page, { selector, kind, w, h, text }) {
  await page.evaluate(async ({ selector, kind, w, h, text }) => {
    const data = new DataTransfer()
    if (text !== undefined) data.setData('text/plain', text)
    if (w !== undefined) {
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#c33'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#fff'
      ctx.fillRect(w / 4, h / 4, w / 2, h / 2)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      data.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
    }
    const target = selector === ':focus' ? document.activeElement : document.querySelector(selector)
    const event = kind === 'paste'
      ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      : new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
  }, { selector, kind, w, h, text })
}

/** A PNG's pixel size, from its IHDR. */
function pngSize(file) {
  const b = fs.readFileSync(file)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  const lock = readServerLock()
  const origin = `http://127.0.0.1:${lock.port}`
  const auth = { authorization: `Bearer ${lock.secret}` }
  const { worktrees } = await (await fetch(`${origin}/api/worktree/list`, { headers: auth })).json()
  const find = (id) => {
    const wt = worktrees.find((w) => w.worktreeId.startsWith(id))
    if (!wt) throw new Error(`no running worktree ${id}`)
    return wt
  }
  const tui = find(tuiId)
  const acp = find(acpId)
  const attachments = path.join(DATA_DIR, 'global', 'projects', tui.projectSlug, 'sessions', tui.worktreeId, 'attachments')
  const token = () => fetch(`${origin}/tokens`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  }).then((r) => r.json()).then((b) => b.token)

  const browser = await chromium.launch()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
    const page = await ctx.newPage()
    page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

    // ── the terminal pane ────────────────────────────────────────────────
    await page.goto(`${origin}/?${new URLSearchParams({ project: tui.projectSlug, worktree: tui.worktreeId, token: await token() })}`)
    await page.locator('.xterm').first().waitFor({ timeout: 30_000 })
    await eventually(async () => (await screenText(page)).includes('❯'), 60_000)
    await page.locator('.xterm').first().click()
    // Start from an empty input: a rerun finds its predecessor's attachments
    // still in it, and claude numbers images per session.
    const images = async () => ((await screenText(page)).match(/\[Image #\d+\]/g) ?? []).length
    if (await images() > 0) await page.keyboard.press('Control+C')
    await eventually(async () => (await images()) === 0)

    const upload = page.waitForResponse((r) => r.url().endsWith('/attachments') && r.request().method() === 'POST')
    await fire(page, { selector: ':focus', kind: 'paste', w: 3000, h: 2000 })
    check(await eventually(async () => (await images()) === 1), 'a pasted image becomes a claude [Image #N]')
    // The file the pane was answered with — a rerun finds its predecessor's
    // uploads still there, so nothing about the directory says which is new.
    const answered = await (await upload).json().catch(() => ({}))
    const uploaded = answered.path && path.join(attachments, path.basename(answered.path))
    check(uploaded !== undefined && fs.existsSync(uploaded), 'the image was uploaded to the worktree')
    if (uploaded !== undefined && fs.existsSync(uploaded)) {
      const { width, height } = pngSize(uploaded)
      check(width === 1568 && height === 1045, 'downscaled to 1568 px on the long edge', `${width}x${height}`)
    }

    await fire(page, { selector: ':focus', kind: 'paste', w: 40, h: 40, text: 'pasted-words' })
    check(
      await eventually(async () => (await screenText(page)).includes('pasted-words')),
      'a paste carrying text still pastes the text',
    )

    await fire(page, { selector: '.xterm', kind: 'drop', w: 64, h: 48 })
    check(await eventually(async () => (await images()) === 2), 'a dropped image becomes a second one')

    await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(32, 32)
      canvas.getContext('2d').fillRect(0, 0, 32, 32)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    })
    await page.locator('.xterm').first().click()
    await page.keyboard.press('Control+Shift+V')
    check(await eventually(async () => (await images()) === 3), 'a real Ctrl+Shift+V of a clipboard image becomes a third')
    await page.screenshot({ path: path.join(SHOTS, 'paste-image-terminal.png') })

    // ── the chat pane ────────────────────────────────────────────────────
    await page.goto(`${origin}/?${new URLSearchParams({ project: acp.projectSlug, worktree: acp.worktreeId, token: await token() })}`)
    const box = page.locator('textarea[placeholder]').first()
    await box.waitFor({ timeout: 30_000 })
    await eventually(() => box.getAttribute('placeholder').then((p) => p === 'Message the agent…'), 60_000)
    await box.click()
    await fire(page, { selector: ':focus', kind: 'paste', w: 200, h: 120 })
    check(
      await eventually(() => page.locator('[aria-label="Remove image"]').count().then((n) => n === 1)),
      'a pasted image shows as one removable thumbnail',
    )
    // Counted from here: a conversation reused across runs replays its
    // earlier images too.
    const sentImages = () => page.locator('.whitespace-pre-wrap img').count()
    const before = await sentImages()
    await box.fill('reply with just the word ok')
    await page.getByRole('button', { name: 'Send' }).click()
    const echoed = await eventually(async () => (await box.inputValue()) === ''
      && (await page.locator('[aria-label="Remove image"]').count()) === 0, 60_000)
    check(echoed, 'the echo empties the composer, text and image')
    check(
      await eventually(async () => (await sentImages()) === before + 1),
      'the user\'s turn shows the image it carried',
    )
    await page.screenshot({ path: path.join(SHOTS, 'paste-image-chat.png') })
  } finally {
    await browser.close()
  }
  console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} check(s) failed`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
