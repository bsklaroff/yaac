/*
 * Verifies a pi acp chat pane shows a bash call's output, each line once.
 * pi-acp sends that output as `tool_call_update._meta.terminal_output`, not
 * the `terminal_output_delta` codex sends, and the command prints more than
 * pi's 2000-line tail window, past which only yaac's pi-acp patch keeps the
 * chunks appends. The check runs twice: on the live pane, then after a
 * reload, when the conversation is replayed from its record.
 *
 * Needs no credentials. The script serves a mock OpenAI-compatible model on
 * MOCK_PORT that answers the first request with a bash call and the next
 * with "done", and adds it as provider `mock` to PROJECT's pi models.json.
 * The project defaults to `yaac`. It then creates a pi acp workspace on
 * `mock/mock-1`. At the end it stops the workspace and puts models.json back
 * as it found it, deleting it if the script created it. The server must be
 * containerless so the workspace can reach the mock on the host's loopback.
 *
 * Run: node test-playwright-scripts/acp-pi-bash-output.js
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DATA_DIR, SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, until } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 18799)
const COMMAND = 'echo hello-from-bash; for i in $(seq 1 6000); do echo line-$i; [ $((i % 500)) = 0 ] && sleep 0.4; done; echo $((6 * 7))-answer'

const mock = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const answered = (JSON.parse(body).messages ?? []).some((m) => m.role === 'tool')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock-1',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`)
    if (answered) {
      send({ role: 'assistant', content: 'done' })
      send({}, 'stop')
    } else {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: COMMAND }) } }] })
      send({}, 'tool_calls')
    }
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
    project: PROJECT, tool: 'pi', mode: 'acp', model: 'mock/mock-1', title: 'PW pi bash output', prompt: 'run it',
  })
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}&workspace=${workspaceId}`)
  for (const when of ['live', 'replayed']) {
    await page.getByPlaceholder('Message the agent…').waitFor({ state: 'visible', timeout: 60_000 })
    // The condensed view hides tool calls.
    const expand = page.getByRole('button', { name: 'Show every step' })
    if (await expand.isVisible()) await expand.click()
    const row = page.locator('button[aria-expanded]:has(svg.lucide-square-terminal)').filter({ hasText: 'hello-from-bash' }).first()
    await row.waitFor({ timeout: 60_000 })
    await until(page, () => document.body.innerText.includes('done'), undefined, 60_000)
    if (await row.getAttribute('aria-expanded') !== 'true') await row.click()
    const shown = await until(page, () => document.body.innerText.includes('42-answer'), undefined, 10_000)
      .then(() => true, () => false)
    check(`the ${when} pane shows the bash call's output`, shown)
    const repeats = await page.evaluate(() => document.body.innerText.split('line-5000\n').length - 1)
    check(`the ${when} pane shows each line once`, repeats === 1, `line-5000 x${String(repeats)}`)
    await page.screenshot({ path: path.join(SHOTS, `pi-bash-output-${when}.png`) })
    if (when === 'live') await page.reload()
  }
} finally {
  await browser.close()
  if (workspaceId) await api('/workspace/stop', { method: 'POST', body: { workspaceId } }).catch(() => {})
  mock.close()
  if (original !== undefined) fs.writeFileSync(modelsFile, original)
  else fs.rmSync(modelsFile)
}
finish()
