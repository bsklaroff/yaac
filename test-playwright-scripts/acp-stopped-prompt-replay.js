/*
 * Reproduces the ways an acp turn can be stopped, then restarts the workspace
 * so the pane rebuilds the conversation from the tool's own history (TOOL,
 * default claude; MODEL, default haiku for claude and the tool's default
 * otherwise):
 *
 *  (a) a prompt stopped a fraction of a second after it is sent, which claude
 *      may leave out of its transcript while still writing its interrupt
 *      marker (tried at several delays, since it depends on timing, and
 *      after a `/compact`), and another tool may leave out of its history;
 *  (b) a prompt stopped mid-reply: while the model thinks, while its text
 *      streams, during a tool call, during a tool call after some text,
 *      while a PreToolUse hook runs, and after a message steered into it.
 *
 * Give PROJECT a `.claude/settings.json` whose hooks add context to every
 * prompt and Bash call and sleep 20 s on a command containing `slowhook`,
 * so the transcript holds hook attachments where a stop can land among them.
 *
 * Each stop is followed by another prompt that runs to the end. After the
 * restart the script prints the pane's text and checks each stopped turn.
 * Under claude a "turn ended: cancelled" divider shows exactly when the
 * turn's prompt does, so a missing (a) prompt leaves no lone divider after
 * the turn before it; other tools' histories keep no stop, so they show
 * none. Every (b) turn keeps its prompt.
 *
 * The run's history files that name the run (in the history the server keeps
 * under its data dir, YAAC_DATA_DIR or ~/.yaac-server) are copied to SHOTS
 * for inspecting the raw entries around each stop. Costs a few cents. The
 * hooks below are claude's. Creates an acp workspace on PROJECT (default `tiny`, e.g.
 * made with `yaac project create tiny`) and leaves it stopped. The (a)
 * delays and c-double's DOUBLE_STOP_MS (default 170) race claude, so a run
 * may keep every prompt; around 90-200 ms most are left out.
 *
 * Run: [TOOL=pi] [CASES=a0,a1] node test-playwright-scripts/acp-stopped-prompt-replay.js
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, resolveProject, until } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'tiny'
const TOOL = process.env.TOOL ?? 'claude'
const MODEL = process.env.MODEL ?? (TOOL === 'claude' ? 'haiku' : undefined)
const RUN = Date.now().toString(36).slice(-4)
const STORY = `Write a 1500-word story about a lighthouse keeper named Odile (${RUN}). No tools, no headings.`
/** claude's Bash tool refuses a plain `sleep` in the foreground, so the
 *  long-running command is a `tail` cut off by `timeout`. */
const SLEEP = (lead) => `${lead}Run \`timeout 30 tail -f /dev/null || true\` with the Bash tool (${RUN}), then reply DONE.`

/** The stopped turns, in order: each sends `prompt` and calls `stopWhen`
 *  (given the page and the time Send was clicked) before clicking Stop.
 *  `delay` cases are claude's timing race, so the prompt may go missing. */
const at = (ms) => async (page, sentAt) => page.waitForTimeout(Math.max(0, ms - (Date.now() - sentAt)))
const allCases = [
  ...[400, 250, 120, 40].map((ms, i) => ({ name: `a${i}`, prompt: `Reply with just the word QUICK${i} (${RUN}).`, race: true, stopWhen: at(ms) })),
  // A local command's output, which claude writes as a user entry, then a
  // prompt stopped at once. Only one: a second `/compact` in the session
  // makes claude rewrite the conversation before it from a fresh chain,
  // which the replay shows in place of the turns after the first.
  {
    name: 'a-compact', prompt: `Reply with just the word COMPACTED (${RUN}).`, race: true,
    before: async (page) => { await send(page, '/compact'); await idle(page) }, stopWhen: at(190),
  },
  { name: 'b-thinking', prompt: STORY, stopWhen: at(2500) },
  {
    name: 'b-text', prompt: STORY,
    stopWhen: (page) => until(page, () => document.body.innerText.split('Odile').length > 4, undefined, 120_000),
  },
  // The command runs 30 s, so 8 s in is during it.
  { name: 'b-tool', prompt: SLEEP(''), stopWhen: at(8000) },
  { name: 'b-text-tool', prompt: SLEEP('Write one sentence about the sea, then '), stopWhen: at(8000) },
  {
    name: 'b-slow-hook', prompt: `Run \`echo slowhook\` with the Bash tool (${RUN}), then reply DONE.`,
    stopWhen: async (page) => {
      await until(page, () => document.body.innerText.split('slowhook').length > 2, undefined, 60_000)
      await page.waitForTimeout(3000)
    },
  },
  {
    name: 'b-steered', prompt: STORY,
    stopWhen: async (page) => {
      await until(page, () => document.body.innerText.split('Odile').length > 4, undefined, 120_000)
      await send(page, `Also give Odile a cat (${RUN}).`)
      await page.waitForTimeout(1500)
    },
  },
  {
    // A turn stopped while it thinks, then the next prompt stopped at once:
    // two stopped turns with no completed one between.
    name: 'c-double', prompt: STORY, race: true, extra: `Reply with just the word QUICKER (${RUN}).`,
    stopWhen: async (page, sentAt) => {
      await at(1500)(page, sentAt)
      await stopButton(page).click()
      await stopButton(page).waitFor({ state: 'hidden', timeout: 60_000 })
      const quickAt = await send(page, `Reply with just the word QUICKER (${RUN}).`)
      await stopButton(page).waitFor({ state: 'visible', timeout: 10_000 })
      await at(Number(process.env.DOUBLE_STOP_MS ?? 170))(page, quickAt)
    },
  },
]
/** CASES (comma-separated names, e.g. `a0,a1,c-double`) runs only those. */
const cases = process.env.CASES ? allCases.filter((c) => process.env.CASES.split(',').includes(c.name)) : allCases
const after = (i) => `Reply with just the word BRAVO${i} (${RUN}).`

const workspaceId = await createWorkspace({
  project: PROJECT, tool: TOOL, mode: 'acp', model: MODEL, permissionMode: 'bypass',
  title: `PW stopped prompt ${RUN}`,
})
const url = `${origin}/?project=${(await resolveProject(PROJECT)).id}&workspace=${workspaceId}`
console.log(`workspace ${workspaceId}`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()

async function openPane() {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(url)
  await page.getByPlaceholder('Message the agent…').filter({ visible: true }).waitFor({ state: 'visible', timeout: 180_000 })
  return page
}

const stopButton = (page) => page.getByRole('button', { name: 'Stop turn' }).filter({ visible: true })

/** Type `text` and send it. The pane clears the composer when it connects
 *  to the agent, so the text is typed again until Send takes it. */
async function send(page, text) {
  const composer = page.getByPlaceholder('Message the agent…').filter({ visible: true })
  const sendButton = page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true })
  const deadline = Date.now() + 60_000
  for (;;) {
    await composer.fill(text)
    if (await sendButton.isEnabled()) break
    if (Date.now() > deadline) throw new Error(`Send never took "${text}"`)
    await page.waitForTimeout(250)
  }
  await sendButton.click()
  return Date.now()
}

async function idle(page) {
  await stopButton(page).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
  await stopButton(page).waitFor({ state: 'hidden', timeout: 180_000 })
}

/** The pane's whole text. It loads older history in pages as it scrolls
 *  up, so it is scrolled until the run's first prompt shows. */
async function bodyText(page) {
  const box = await page.getByPlaceholder('Message the agent…').filter({ visible: true }).boundingBox()
  for (let i = 0; i < 40; i++) {
    const text = await page.evaluate(() => document.body.innerText)
    if (text.includes(`ALPHA (${RUN})`)) return text
    await page.mouse.move(box.x + box.width / 2, box.y - 200)
    await page.mouse.wheel(0, -20_000)
    await page.waitForTimeout(500)
  }
  throw new Error('the first prompt never loaded')
}

try {
  let page = await openPane()

  await send(page, `Reply with just the word ALPHA (${RUN}).`)
  await idle(page)
  for (const [i, c] of cases.entries()) {
    await c.before?.(page)
    const sentAt = await send(page, c.prompt)
    await stopButton(page).waitFor({ state: 'visible', timeout: 10_000 })
    await c.stopWhen(page, sentAt)
    const streaming = await stopButton(page).isVisible()
    check(`${c.name}: the turn is still running at the stop`, streaming)
    if (streaming) await stopButton(page).click()
    console.log(`${c.name}: stopped ${Date.now() - sentAt} ms after send`)
    await stopButton(page).waitFor({ state: 'hidden', timeout: 60_000 })
    await send(page, after(i))
    await idle(page)
  }
  await page.waitForTimeout(2000)
  const live = await bodyText(page)
  await page.screenshot({ path: path.join(SHOTS, `stopped-prompt-${TOOL}-${RUN}-live.png`), fullPage: true })
  await page.context().close()

  execFileSync('yaac', ['workspace', 'restart', workspaceId], { stdio: 'ignore', timeout: 300_000 })
  page = await openPane()
  await until(page, (w) => document.body.innerText.includes(w), after(cases.length - 1), 60_000)
  await page.waitForTimeout(2000)
  const restored = await bodyText(page)
  await page.screenshot({ path: path.join(SHOTS, `stopped-prompt-${TOOL}-${RUN}-restored.png`), fullPage: true })

  /** The conversation's lines, from the first prompt on. */
  const lines = (text) => {
    const all = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    return all.slice(all.findIndex((l) => l.includes(`ALPHA (${RUN})`)))
  }
  console.log('\n--- live ---\n' + lines(live).join('\n'))
  console.log('\n--- restored ---\n' + lines(restored).join('\n'))

  // Each stopped turn's stretch of the restored pane runs from the prompt
  // after the turn before it to its own follow-up prompt.
  const ls = lines(restored)
  let from = 0
  for (const [i, c] of cases.entries()) {
    const to = ls.findIndex((l, j) => j > from && l === after(i))
    check(`${c.name}: its follow-up prompt shows`, to !== -1)
    if (to === -1) continue
    const stretch = ls.slice(from + 1, to)
    from = to
    const prompts = [c.prompt, c.extra].filter(Boolean).map((p) => stretch.some((l) => l === p))
    const dividers = stretch.filter((l) => l === 'turn ended: cancelled').length
    const prompt = prompts[0]
    console.log(`${c.name}: prompts ${JSON.stringify(prompts)} shown, ${dividers} divider(s)`)
    check(`${c.name}: ${TOOL === 'claude' ? 'a divider shows exactly when its prompt does' : 'no divider shows'}`,
      dividers === (TOOL === 'claude' ? prompts.filter(Boolean).length : 0))
    if (!c.race) check(`${c.name}: its prompt shows`, prompt)
  }

  const found = execFileSync('find', [process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac-server'), '-type', 'f', '-path', `*/history/${workspaceId}/*`],
    { encoding: 'utf8' }).split('\n').filter((f) => f && !f.includes('/subagents/'))
  for (const f of found) {
    if (!fs.readFileSync(f).includes(`ALPHA (${RUN})`)) continue
    const copy = path.join(SHOTS, `stopped-prompt-${RUN}-${path.basename(f)}`)
    fs.copyFileSync(f, copy)
    console.log(`history ${f} -> ${copy}`)
  }
} finally {
  await browser.close()
  await api('/workspace/stop', { method: 'POST', body: { workspaceId } }).catch(() => {})
}
finish()
