/*
 * Verifies the edges of a chat pane's tail-following while the agent streams:
 * that a reader at the bottom stays there at fractional device scale factors
 * and page zooms (a sub-pixel layout reads the bottom up to 2px off), that a
 * small scroll up is left alone, that the jump-to-latest arrow is dotted for
 * what arrives while the reader is away and undotted once they are back (by
 * scroll, `End`, or the arrow), that sending a message follows the tail with
 * no dot, and, on a touch phone, that a tap's jitter or a sideways swipe on a
 * code block keeps the pane following while a downward swipe unpins it.
 *
 * Needs no credentials. Like acp-chat-scroll-up-while-streaming.js, it serves
 * a mock OpenAI-compatible model on MOCK_PORT that streams a long reply (with
 * a wide code block every so often), adds it as provider `mock` to PROJECT's
 * pi models.json, and creates a pi acp workspace on `mock/mock-1`, which it
 * stops at the end. The server must be containerless and serve a `dist/`
 * built from the change under test (`pnpm build`, `yaac server restart`).
 *
 * Run: [WORD_MS=40] YAAC_DATA_DIR=... node test-playwright-scripts/acp-chat-follow-tail-edges.js
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DATA_DIR, api, check, createWorkspace, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const PROJECT = (await resolveProject(process.env.PROJECT ?? 'yaac')).id
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 18799)
/* A word every WORD_MS, for about eight minutes at the default 10ms. */
const WORD_MS = Number(process.env.WORD_MS ?? 10)
const WORDS = 50000 * 10 / WORD_MS
const WIDE = `\n\n\`\`\`\n${'x'.repeat(400)}\n\`\`\`\n\n`

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
      send({ content: i % 40 === 39 ? WIDE : i % 15 === 14 ? `word-${i}\n\n` : `word-${i} ` })
      await new Promise((resolve) => setTimeout(resolve, WORD_MS))
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let workspaceId
const { chromium } = requirePlaywright()
const browser = await chromium.launch()

/** Open the workspace in a new context and wait for the reply to overflow. */
async function open(options, zoom) {
  const ctx = await browser.newContext(options)
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${PROJECT}&workspace=${workspaceId}`)
  await page.getByPlaceholder('Message the agent…').waitFor({ state: 'visible', timeout: 60_000 })
  if (zoom) await page.evaluate((z) => { document.documentElement.style.zoom = z }, zoom)
  const list = page.locator('.overflow-y-auto:has(> div)').filter({ hasText: 'word-' }).first()
  await list.waitFor({ timeout: 60_000 })
  await until(page, () => document.body.innerText.includes('word-'), undefined, 60_000)
  const metrics = () => list.evaluate((el) => ({ top: el.scrollTop, fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight }))
  const arrow = async () => {
    if (await page.getByRole('button', { name: 'Jump to the latest (new activity)' }).count()) return 'dotted'
    return await page.getByRole('button', { name: 'Jump to the latest' }).count() ? 'plain' : 'none'
  }
  /** Sample for `ms`: the largest distance from the bottom, and whether the
   *  arrow ever showed. */
  const follow = async (ms) => {
    let worst = 0
    let arrows = 0
    for (const end = Date.now() + ms; Date.now() < end;) {
      worst = Math.max(worst, (await metrics()).fromBottom)
      if (await arrow() !== 'none') arrows++
      await sleep(100)
    }
    return { worst, arrows }
  }
  return { ctx, page, list, metrics, arrow, follow }
}

try {
  workspaceId = await createWorkspace({
    project: PROJECT, tool: 'pi', mode: 'acp', model: 'mock/mock-1', title: 'PW follow tail edges', prompt: 'talk',
  })

  // 1. Pinned at the bottom across scale factors and page zooms.
  for (const [dsf, zoom, height] of [[1, '', 800], [0.8, '', 799], [0.9, '', 800], [1.1, '', 800], [1.25, '', 800], [1.33, '', 803], [1.5, '', 801], [1.67, '', 800], [1.75, '', 777], [2.25, '', 811], [1.5, '1.1', 800], [1.75, '0.9', 777]]) {
    const { ctx, list, metrics, follow } = await open({ viewport: { width: 1200, height }, deviceScaleFactor: dsf }, zoom)
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await sleep(500)
    const { worst, arrows } = await follow(4000)
    const end = await metrics()
    check(`dsf ${dsf}, zoom ${zoom || 1}, height ${height}: stays pinned while streaming`,
      end.fromBottom < 2 && worst < 2 && arrows === 0,
      `worst ${worst.toFixed(2)}px, end ${end.fromBottom.toFixed(2)}px, arrow seen ${arrows}x`)
    await ctx.close()
  }

  // 2. Desktop at 1.5: a small scroll up, the dot, and the ways back.
  {
    const { ctx, page, list, metrics, arrow, follow } = await open({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1.5 })
    const box = await list.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const toBottom = () => list.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await toBottom()
    await sleep(500)

    await page.mouse.wheel(0, -6)
    await sleep(300)
    const nudged = await metrics()
    await sleep(1500)
    const later = await metrics()
    check('a 6px wheel up is left in place', nudged.fromBottom >= 4 && Math.abs(later.top - nudged.top) < 1,
      `${nudged.fromBottom.toFixed(1)}px up, top ${nudged.top.toFixed(1)} → ${later.top.toFixed(1)}`)
    check('the arrow is dotted for what arrived since', await arrow() === 'dotted', await arrow())

    await toBottom()
    await sleep(300)
    check('scrolled back to the bottom, the dot is gone', await arrow() === 'none', await arrow())
    check('and the pane follows again', (await follow(2000)).worst < 2)

    // Each way back, many times over: the stream grows the list every frame,
    // so the scroll that reaches the bottom can be read a few pixels short.
    // The wheel goes to the list's middle, since the arrows swallow it.
    const ways = {
      'set scrollTop (a scrollbar drag)': toBottom,
      'End': async () => {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await page.keyboard.press('End')
      },
      'wheel down': async () => {
        for (let i = 0; i < 8; i++) {
          await page.mouse.wheel(0, 300)
          await sleep(30)
        }
      },
      'the arrow': () => page.getByRole('button', { name: /Jump to the latest/ }).click(),
    }
    for (const [name, back] of Object.entries(ways)) {
      const left = []
      let dotted = 0
      for (let i = 0; i < 8; i++) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.wheel(0, -400)
        await sleep(1000)
        if (await arrow() === 'dotted') dotted++
        await back()
        await sleep(1000)
        left.push(Math.round((await metrics()).fromBottom))
      }
      check(`scrolled up before going back by ${name}, the arrow is dotted`, dotted === 8, `${dotted}/8`)
      check(`back at the bottom by ${name}, the pane re-pins and the dot clears`, left.every((d) => d < 2) && await arrow() === 'none',
        `px from the bottom a second later: ${left.join(' ')}`)
    }

    await page.mouse.wheel(0, -400)
    await sleep(1500)
    const input = page.getByPlaceholder('Message the agent…')
    await input.fill('hello from the reader')
    await input.press('Enter')
    await sleep(500)
    const sent = await follow(3000)
    check('sending a message follows the tail with no dot', sent.worst < 2 && sent.arrows === 0 && await arrow() === 'none',
      `worst ${sent.worst.toFixed(1)}px, arrow ${await arrow()}`)
    await ctx.close()
  }

  // 3. A touch phone: jitter and sideways swipes keep following; a swipe
  //    down unpins.
  {
    const { ctx, page, list, metrics, arrow, follow } = await open({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    })
    const cdp = await ctx.newCDPSession(page)
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
    /** One finger from (x, y) by (dx, dy) in `steps` moves. */
    const drag = async (x, y, dx, dy, steps = 10) => {
      await touch('touchStart', [{ x, y, id: 1 }])
      for (let i = 1; i <= steps; i++) {
        await touch('touchMove', [{ x: x + dx * i / steps, y: y + dy * i / steps, id: 1 }])
        await sleep(16)
      }
      await touch('touchEnd', [])
    }
    const toBottom = () => list.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await toBottom()
    await sleep(500)

    // Chromium holds back touchmoves inside its touch slop, so only WebKit,
    // which sends them all, can fail this one.
    await drag(195, 400, 0, 2, 2)
    const jitter = await follow(2500)
    check('a tap with 2px of downward jitter keeps the pane following', jitter.worst < 2 && jitter.arrows === 0,
      `worst ${jitter.worst.toFixed(1)}px, arrow seen ${jitter.arrows}x`)

    await toBottom()
    await sleep(300)
    const pre = await list.evaluate((el) => {
      const view = el.getBoundingClientRect()
      const hit = [...el.querySelectorAll('pre')].reverse().find((p) => {
        const r = p.getBoundingClientRect()
        return r.top > view.top && r.bottom < view.bottom
      })
      if (!hit) return null
      const r = hit.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    if (pre) {
      await drag(pre.x, pre.y, -150, 8, 10)
      const sideways = await follow(2500)
      check('a sideways swipe on a code block keeps the pane following', sideways.worst < 2 && sideways.arrows === 0,
        `worst ${sideways.worst.toFixed(1)}px, arrow seen ${sideways.arrows}x`)
    } else {
      check('a code block is on screen for the sideways swipe', false)
    }

    await toBottom()
    await sleep(300)
    await drag(195, 300, 0, 250, 15)
    await sleep(300)
    const swiped = await metrics()
    await sleep(1500)
    const after = await metrics()
    check('a swipe down scrolls up and stays', swiped.fromBottom > 50 && Math.abs(after.top - swiped.top) < 1,
      `${swiped.fromBottom.toFixed(0)}px up, top ${swiped.top.toFixed(0)} → ${after.top.toFixed(0)}`)
    check('and dots the arrow', await arrow() === 'dotted', await arrow())

    await drag(195, 700, 0, -600, 8)
    await sleep(1500)
    await toBottom()
    await sleep(300)
    check('back at the bottom, the dot clears and the pane follows', await arrow() === 'none' && (await follow(2000)).worst < 2, await arrow())
    await ctx.close()
  }
} finally {
  await browser.close()
  if (workspaceId) await api('/workspace/stop', { method: 'POST', body: { workspaceId } }).catch(() => {})
  mock.close()
  if (original !== undefined) fs.writeFileSync(modelsFile, original)
  else fs.rmSync(modelsFile)
}
finish()
