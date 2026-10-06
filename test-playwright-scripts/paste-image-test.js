/*
 * Verifies pasting and dropping images into agent panes in real Chromium
 * (docs/agent-modes.md, "Images"):
 *
 *   1. A terminal pane intercepts an image paste, uploads a copy downscaled
 *      to at most 1568px on its long edge, and pastes the path, which claude
 *      turns into an `[Image #N]` attachment.
 *   2. A paste carrying text still goes to xterm.
 *   3. An image dropped on the terminal is handled like a paste.
 *   3b. So is Ctrl+Shift+V with an image on the clipboard: the browser's
 *      paste event has no image then, so the pane reads the clipboard.
 *   4. The chat composer shows a pasted image as a removable thumbnail and
 *      sends it; it then appears in the user's turn and the composer empties.
 *
 * Needs a running containerless `yaac server` (the upload's path is then a
 * host path) with two live claude workspaces: a terminal one (`yaac
 * workspace create <project> --tool claude`) and a chat one (`... --mode
 * acp`). Spends one small prompt turn on the chat agent.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/paste-image-test.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

/** Poll an async predicate; `page.waitForFunction` is blocked by the app's CSP. */
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
 * Dispatch a paste (or drop) with a `w`x`h` PNG and/or text at `selector`,
 * built in the page since a DataTransfer cannot be passed in.
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

const { workspaces } = await api('/workspace/list')
const live = (mode) => {
  const w = workspaces.find((w) => w.agentSessions.some((a) => a.mode === mode && a.active && a.tool === 'claude'))
  if (!w) throw new Error(`no live claude ${mode} workspace`)
  return w
}
const tui = live('tui')
const acp = live('acp')
const open = (w) => `${origin}/?project=${w.projectId}&workspace=${w.workspaceId}`

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  // ── the terminal pane ────────────────────────────────────────────────
  await page.goto(open(tui))
  await page.locator('.xterm').first().waitFor({ timeout: 30_000 })
  await eventually(async () => (await screenText(page)).includes('❯'), 60_000)
  await page.locator('.xterm').first().click()
  // Clear the input: a rerun may find earlier attachments there.
  const images = async () => ((await screenText(page)).match(/\[Image #\d+\]/g) ?? []).length
  if (await images() > 0) await page.keyboard.press('Control+C')
  await eventually(async () => (await images()) === 0)

  const upload = page.waitForResponse((r) => r.url().endsWith('/attachments') && r.request().method() === 'POST')
  await fire(page, { selector: ':focus', kind: 'paste', w: 3000, h: 2000 })
  check('a pasted image becomes a claude [Image #N]', await eventually(async () => (await images()) === 1))
  const uploaded = (await (await upload).json().catch(() => ({}))).path
  check('the image was uploaded to the workspace', uploaded !== undefined && fs.existsSync(uploaded))
  if (uploaded !== undefined && fs.existsSync(uploaded)) {
    const { width, height } = pngSize(uploaded)
    check('downscaled to 1568 px on the long edge', width === 1568 && height === 1045, `${width}x${height}`)
  }

  await fire(page, { selector: ':focus', kind: 'paste', w: 40, h: 40, text: 'pasted-words' })
  check('a paste carrying text still pastes the text',
    await eventually(async () => (await screenText(page)).includes('pasted-words')))

  await fire(page, { selector: '.xterm', kind: 'drop', w: 64, h: 48 })
  check('a dropped image becomes a second one', await eventually(async () => (await images()) === 2))

  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(32, 32)
    canvas.getContext('2d').fillRect(0, 0, 32, 32)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })
  await page.locator('.xterm').first().click()
  await page.keyboard.press('Control+Shift+V')
  check('a real Ctrl+Shift+V of a clipboard image becomes a third', await eventually(async () => (await images()) === 3))
  await page.screenshot({ path: path.join(SHOTS, 'paste-image-terminal.png') })

  // ── the chat pane ────────────────────────────────────────────────────
  await page.goto(open(acp))
  const box = page.locator('textarea[placeholder]').first()
  await box.waitFor({ timeout: 30_000 })
  await eventually(() => box.getAttribute('placeholder').then((p) => p === 'Message the agent…'), 60_000)
  await box.click()
  await fire(page, { selector: ':focus', kind: 'paste', w: 200, h: 120 })
  check('a pasted image shows as one removable thumbnail',
    await eventually(() => page.locator('[aria-label="Remove image"]').count().then((n) => n === 1)))
  // Count from here: a reused conversation replays earlier images.
  const sentImages = () => page.locator('.whitespace-pre-wrap img').count()
  const before = await sentImages()
  await box.fill('reply with just the word ok')
  await page.getByRole('button', { name: 'Send' }).click()
  const echoed = await eventually(async () => (await box.inputValue()) === ''
    && (await page.locator('[aria-label="Remove image"]').count()) === 0, 60_000)
  check('the echo empties the composer, text and image', echoed)
  check('the user\'s turn shows the image it carried',
    await eventually(async () => (await sentImages()) === before + 1))
  await page.screenshot({ path: path.join(SHOTS, 'paste-image-chat.png') })
} finally {
  await browser.close()
}
finish()
