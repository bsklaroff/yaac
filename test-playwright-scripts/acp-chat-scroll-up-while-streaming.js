/*
 * Verifies that a reader at the bottom of a chat pane can scroll up while
 * the agent is streaming. A trackpad's first few wheel steps, or a smooth
 * wheel scroll's first frames, stay near the bottom, and the pane used to
 * snap a reader there back to the tail on the next streamed event: a rapid
 * bounce, with the scroll bar stuck at the bottom.
 *
 * Needs no credentials. The script serves a mock OpenAI-compatible model on
 * MOCK_PORT that streams one long reply a word at a time, and adds it as
 * provider `mock` to PROJECT's pi models.json (PROJECT is a name or id,
 * default `yaac`). It creates a pi acp workspace on `mock/mock-1`, waits for
 * the reply to overflow the pane, then scrolls up from the bottom TRIALS
 * times as a trackpad does, in many small wheel steps, each time checking
 * the pane moved up and stayed there, and that a zoom wheel (ctrl+wheel)
 * at the bottom leaves it following. At the end it stops the workspace and
 * puts models.json back as it found it. The server must be containerless so
 * the workspace can reach the mock on the host's loopback, and must serve a
 * `dist/` built from the change under test (`pnpm build`, `yaac server
 * restart`).
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/acp-chat-scroll-up-while-streaming.js
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DATA_DIR, SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const PROJECT = (await resolveProject(process.env.PROJECT ?? 'yaac')).id
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 18798)
const TRIALS = Number(process.env.TRIALS ?? 10)
/* About two minutes of streaming, a word every 15ms. */
const WORDS = 8000

const mock = http.createServer((req, res) => {
  req.resume()
  req.on('end', async () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock-1',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`)
    send({ role: 'assistant', content: '' })
    for (let i = 0; i < WORDS && !res.destroyed; i++) {
      send({ content: i % 15 === 14 ? `word-${i}\n\n` : `word-${i} ` })
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    send({}, 'stop')
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve))

const modelsFile = path.join(DATA_DIR, 'global', 'projects', PROJECT, 'pi', 'agent', 'models.json')
fs.mkdirSync(path.dirname(modelsFile), { recursive: true })
const original = fs.existsSync(modelsFile) ? fs.readFileSync(modelsFile, 'utf8') : undefined
const models = original !== undefined ? JSON.parse(original) : {}
models.providers = {
  ...models.providers,
  mock: { baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, api: 'openai-completions', apiKey: 'x', models: [{ id: 'mock-1' }] },
}
fs.writeFileSync(modelsFile, JSON.stringify(models, null, 2) + '\n')

let workspaceId
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  workspaceId = await createWorkspace({
    project: PROJECT, tool: 'pi', mode: 'acp', model: 'mock/mock-1', title: 'PW scroll while streaming', prompt: 'talk',
  })
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}&workspace=${workspaceId}`)
  await page.getByPlaceholder('Message the agent…').waitFor({ state: 'visible', timeout: 60_000 })
  const list = page.locator('.overflow-y-auto:has(> div)').filter({ hasText: 'word-' }).first()
  await until(page, () => document.body.innerText.includes('word-600'), undefined, 60_000)

  const metrics = () => list.evaluate((el) => ({ top: el.scrollTop, fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight }))
  const box = await list.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  let bounced = 0
  for (let i = 0; i < TRIALS; i++) {
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await page.waitForTimeout(300)
    const before = await metrics()
    // A trackpad's gesture: many small wheel events, each a few pixels.
    for (let step = 0; step < 30; step++) {
      await page.mouse.wheel(0, -6)
      await page.waitForTimeout(16)
    }
    await page.waitForTimeout(600)
    const after = await metrics()
    const moved = before.top - after.top
    if (moved < 60) bounced++
    console.log(`  trial ${i + 1}: moved up ${Math.round(moved)}px, ${Math.round(after.fromBottom)}px from the bottom`)
  }
  await page.screenshot({ path: path.join(SHOTS, 'acp-chat-scroll-up-while-streaming.png') })
  const streaming = !(await page.evaluate(() => document.body.innerText.includes(`word-${8000 - 1}`)))
  check('the reply was still streaming through every trial', streaming)
  check('every wheel up from the bottom moves the pane up and leaves it there', bounced === 0, `${bounced}/${TRIALS} bounced`)

  // Back at the bottom, the pane follows the stream again.
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(1500)
  const followed = await metrics()
  check('scrolled back to the bottom, the pane follows the stream', followed.fromBottom < 60, `${Math.round(followed.fromBottom)}px`)

  // A zoom (ctrl+wheel, or a trackpad pinch) scrolls nothing, so the pane
  // must keep following.
  await list.dispatchEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true })
  await page.waitForTimeout(2000)
  const zoomed = await metrics()
  check('a zoom wheel at the bottom leaves the pane following', zoomed.fromBottom < 60, `${Math.round(zoomed.fromBottom)}px`)
} finally {
  await browser.close()
  if (workspaceId) await api('/workspace/stop', { method: 'POST', body: { workspaceId } }).catch(() => {})
  mock.close()
  if (original !== undefined) fs.writeFileSync(modelsFile, original)
  else fs.rmSync(modelsFile)
}
finish()
