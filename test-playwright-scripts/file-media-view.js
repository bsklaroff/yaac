/*
 * Verifies the file pane's media view in real Chromium (docs/file-editor.md,
 * "Media files"):
 *   1. A PNG opens (via quick-open) as an image that decodes, served from
 *      the `raw` route as image/png with nosniff and a sandboxing CSP.
 *   2. Overwriting the PNG on disk swaps the image for the new one without
 *      reopening the pane.
 *   3. A WebM opens as a <video> that loads its duration, and seeking it is
 *      answered with a 206 byte range.
 *   4. A WAV opens as an <audio> that loads.
 *   5. A PDF opens in an <iframe> served as application/pdf.
 *   6. A non-media binary still reads "Binary file, not shown", and the raw
 *      route refuses it.
 * SCREENSHOT_DIR gets media-image.png, media-video.png and media-pdf.png.
 *
 * Needs a running containerless `yaac server` with one live workspace of
 * the yaac project (see lib.js). It writes pw-media/ into the checkout and
 * removes it at the end. The WebM is recorded from a canvas in the browser,
 * so no ffmpeg is needed. It runs full Chromium (`channel: 'chromium'`),
 * since the headless shell has no PDF viewer.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/file-media-view.js <workspace-id>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requirePlaywright, origin, api, check, finish, until, SHOTS, DATA_DIR } from './lib.js'

const { chromium } = requirePlaywright()
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const { workspaces } = await api('/workspace/list')
const wt = workspaces.find((w) => w.workspaceId.startsWith(process.argv[2] ?? '\0'))
if (!wt) {
  console.error('usage: node test-playwright-scripts/file-media-view.js <live-workspace-id>')
  process.exit(1)
}
const checkout = path.join(DATA_DIR, 'global', 'projects', wt.projectId, 'workspaces', wt.workspaceId)
const dir = path.join(checkout, 'pw-media')
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir)

/** Half a second of a 440 Hz tone, 8-bit mono. */
function wav() {
  const rate = 8000
  const samples = Buffer.from(Array.from({ length: rate / 2 }, (_, i) => 128 + Math.round(100 * Math.sin(i * 2 * Math.PI * 440 / rate))))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + samples.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34)
  h.write('data', 36); h.writeUInt32LE(samples.length, 40)
  return Buffer.concat([h, samples])
}

/** A one-page PDF saying "yaac media view", with a correct xref table. */
function pdf() {
  const text = 'BT /F1 36 Tf 72 700 Td (yaac media view) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((body, i) => {
    const at = out.length
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// Full Chromium, not the headless shell, which has no PDF viewer.
const browser = await chromium.launch({ channel: 'chromium' })
try {
  // Record a two-second WebM from an animated canvas.
  const recorder = await browser.newPage()
  const webm = await recorder.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const ctx = canvas.getContext('2d')
    const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' })
    const chunks = []
    rec.ondataavailable = (e) => chunks.push(e.data)
    const stopped = new Promise((r) => { rec.onstop = r })
    rec.start()
    const start = performance.now()
    await new Promise((done) => {
      const frame = () => {
        const t = (performance.now() - start) / 2000
        ctx.fillStyle = `hsl(${t * 360}, 70%, 50%)`
        ctx.fillRect(0, 0, 320, 180)
        if (t < 1) requestAnimationFrame(frame)
        else done()
      }
      frame()
    })
    rec.stop()
    await stopped
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
    return Array.from(bytes)
  })
  await recorder.close()
  fs.writeFileSync(path.join(dir, 'clip.webm'), Buffer.from(webm))
  fs.copyFileSync(path.join(repo, 'packages/desktop/build/icon.png'), path.join(dir, 'shot.png'))
  fs.writeFileSync(path.join(dir, 'tone.wav'), wav())
  fs.writeFileSync(path.join(dir, 'doc.pdf'), pdf())
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  const raw = []
  page.on('response', (res) => {
    if (res.url().includes('/raw?')) raw.push({ url: res.url(), status: res.status(), headers: res.headers() })
  })
  const query = new URLSearchParams({ project: wt.projectId, workspace: wt.workspaceId })
  await page.goto(`${origin}/?${query}`)
  await page.waitForSelector('[aria-label="Browse files"]', { timeout: 30_000 })

  const open = async (name) => {
    await page.locator('body').press('Alt+KeyE')
    const filter = page.locator('[aria-label="Filter files"]')
    await filter.waitFor()
    await filter.fill(`pw-media/${name}`)
    await page.waitForTimeout(300)
    await filter.press('Enter')
  }

  // 1. Image.
  await open('shot.png')
  const img = page.getByAltText('pw-media/shot.png')
  await img.waitFor({ timeout: 10_000 })
  await until(page, () => {
    const el = document.querySelector('img[alt="pw-media/shot.png"]')
    return el?.complete && el.naturalWidth > 0
  })
  const first = await img.evaluate((el) => ({ src: el.getAttribute('src'), w: el.naturalWidth }))
  check('a PNG opens as a decoded image', first.w > 0)
  const imgRes = raw.find((r) => r.url.includes('shot.png'))
  check('the raw route serves it as image/png with nosniff and a sandboxing CSP',
    imgRes?.status === 200 && imgRes.headers['content-type'] === 'image/png'
      && imgRes.headers['x-content-type-options'] === 'nosniff'
      && /(^|; )sandbox(;|$)/.test(imgRes.headers['content-security-policy'] ?? ''))
  await page.screenshot({ path: path.join(SHOTS, 'media-image.png') })

  // 2. Regenerated on disk.
  const smaller = await page.screenshot({ clip: { x: 0, y: 0, width: 64, height: 48 } })
  fs.writeFileSync(path.join(dir, 'shot.png'), smaller)
  await until(page, (before) => {
    const el = document.querySelector('img[alt="pw-media/shot.png"]')
    return el && el.getAttribute('src') !== before && el.complete && el.naturalWidth === 64
  }, first.src, 15_000)
  check('a PNG rewritten on disk reloads in the open pane', true)

  // 3. Video.
  await open('clip.webm')
  const video = page.locator('video')
  await video.waitFor({ timeout: 10_000 })
  await until(page, () => {
    const el = document.querySelector('video')
    return el && el.readyState >= 1
  })
  // A MediaRecorder WebM carries no duration until the browser seeks to its
  // end, so ask for a seek and wait for a finite one.
  await video.evaluate((el) => { el.currentTime = 1e9 })
  await until(page, () => Number.isFinite(document.querySelector('video').duration), undefined, 10_000)
  const duration = await video.evaluate((el) => el.duration)
  check(`a WebM opens as a video that loads (duration ${duration.toFixed(2)}s)`, duration > 1)
  await video.evaluate((el) => { el.currentTime = 0.5 })
  await page.waitForTimeout(500)
  check('the video is fetched with byte ranges (206)', raw.some((r) => r.url.includes('clip.webm') && r.status === 206
    && /^bytes \d+-\d+\/\d+$/.test(r.headers['content-range'] ?? '')))
  await page.screenshot({ path: path.join(SHOTS, 'media-video.png') })

  // 4. Audio.
  await open('tone.wav')
  await page.locator('audio').waitFor({ timeout: 10_000 })
  await until(page, () => document.querySelector('audio')?.readyState >= 1)
  const tone = await page.locator('audio').evaluate((el) => el.duration)
  check(`a WAV opens as audio that loads (duration ${tone.toFixed(2)}s)`, Math.abs(tone - 0.5) < 0.05)

  // 5. PDF.
  await open('doc.pdf')
  await page.locator('iframe[title="pw-media/doc.pdf"]').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(2000)
  const pdfRes = raw.find((r) => r.url.includes('doc.pdf'))
  check('a PDF opens in an iframe served as application/pdf',
    pdfRes?.status === 200 && pdfRes.headers['content-type'] === 'application/pdf')
  // The viewer must still run under the sandboxing CSP: its frame is the
  // viewer's, not Chromium's error page.
  const viewer = page.frames().find((f) => f.url().includes('doc.pdf'))
  check('the PDF viewer runs under the sandboxing CSP', viewer !== undefined
    && !page.frames().some((f) => f.url().startsWith('chrome-error://')))
  await page.screenshot({ path: path.join(SHOTS, 'media-pdf.png') })

  // 6. Not media.
  await open('blob.bin')
  await page.getByText('Binary file, not shown').waitFor({ timeout: 10_000 })
  check('a non-media binary is still not shown', true)
  const refused = await page.evaluate(async (id) => (await fetch(`/api/workspace/${id}/raw?path=pw-media/blob.bin`)).status, wt.workspaceId)
  check('the raw route refuses a non-media file', refused === 400)
} finally {
  await browser.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
finish()
