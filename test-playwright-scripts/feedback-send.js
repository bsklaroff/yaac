/*
 * Verifies the rail's "Send feedback" button end to end: it sits above
 * Server health, a screenshot pasted into its form and one picked with
 * "Attach image" both show as thumbnails, Send delivers the words, both
 * images and the server's and webapp's build stamps to the feedback
 * endpoint with a signature that verifies against the key it names, and
 * the form clears afterwards.
 *
 * The script is the endpoint: it listens on FEEDBACK_PORT (default 9911),
 * so the server must forward there. Start one on a scratch data dir:
 *
 *   YAAC_DATA_DIR=/tmp/fb YAAC_FEEDBACK_URL=http://127.0.0.1:9911/ \
 *     node dist/cli.js server run --port 8899
 *
 * Run: APP_URL=http://127.0.0.1:8899 node test-playwright-scripts/feedback-send.js
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHOTS, check, finish, origin, requirePlaywright } from './lib.js'

const PORT = Number(process.env.FEEDBACK_PORT ?? 9911)
const IMAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../packages/frontend/src/apple-touch-icon.png')

const received = []
const endpoint = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: req.headers['x-yaac-key'] }, format: 'jwk' })
    received.push({
      verified: crypto.verify(null, raw, key, Buffer.from(req.headers['x-yaac-signature'], 'base64url')),
      body: JSON.parse(raw.toString('utf8')),
    })
    res.writeHead(200).end()
  })
}).listen(PORT, '127.0.0.1')

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(origin)
const feedback = page.getByRole('button', { name: 'Send feedback' })
const health = page.getByRole('button', { name: 'Server health' })
check('the button sits above Server health',
  (await feedback.boundingBox()).y < (await health.boundingBox()).y)
await page.screenshot({ path: path.join(SHOTS, 'feedback-rail.png') })
await feedback.click()
const box = page.getByPlaceholder(/what's working/i)
await box.waitFor()

// A paste: the image on a synthetic clipboard event, as a browser sends it.
const png = fs.readFileSync(IMAGE).toString('base64')
await box.evaluate((el, data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  const transfer = new DataTransfer()
  transfer.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
}, png)
await page.locator('input[type=file][accept="image/*"]').setInputFiles(IMAGE)
await page.getByRole('button', { name: 'Remove image' }).nth(1).waitFor()
check('both images show as thumbnails', await page.getByRole('button', { name: 'Remove image' }).count() === 2)

await box.fill('the sidebar flickers')
await page.screenshot({ path: path.join(SHOTS, 'feedback-before-send.png') })
await page.getByRole('button', { name: 'Send', exact: true }).click()
await page.getByText('Thanks — sent.').waitFor()
for (let i = 0; received.length === 0 && i < 20; i++) await page.waitForTimeout(250)

const [got] = received
check('the endpoint verifies the signature', got?.verified === true)
check('it carries the words', got?.body.message === 'the sidebar flickers')
check('it carries both images as PNGs', got?.body.images.length === 2
  && got.body.images.every((i) => i.mimeType === 'image/png'), JSON.stringify(got?.body.images.map((i) => i.mimeType)))
const { server, client } = got?.body ?? {}
check('it names the server build', /^\d+\.\d+\.\d+/.test(server?.version ?? '') && /^[0-9a-f]{40}/.test(server?.gitCommit ?? '')
  && ['k8s', 'containerless'].includes(server?.driver), JSON.stringify(server))
check('it names the webapp build and browser', client?.version === server?.version
  && client?.gitCommit === server?.gitCommit && /Chrome/.test(client?.userAgent ?? ''), JSON.stringify(client))
check('the form clears', await box.inputValue() === ''
  && await page.getByRole('button', { name: 'Remove image' }).count() === 0)
await page.screenshot({ path: path.join(SHOTS, 'feedback-after-send.png') })

await browser.close()
endpoint.close()
finish()
