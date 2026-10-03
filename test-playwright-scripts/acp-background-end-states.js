/*
 * Verifies how a claude acp chat pane shows background work ending, against
 * a live workspace: a background subagent and a background shell each get a
 * chip in the strip over the composer while they run, the strip empties once
 * both end, and each one's transcript card settles on `completed`. claude
 * lists live background tasks in `background_tasks_changed`, and the pane
 * ends a subagent or task that list drops before its own end report arrives;
 * the report then corrects it, so no card may stay `cancelled` or `stopped`.
 *
 * A MutationObserver records every state the strip and cards render, so the
 * log shows any brief `cancelled` the pane painted on the way to `completed`.
 *
 * The prompt makes a few haiku calls, so it costs a few cents. With no
 * WORKSPACE_ID it creates a claude acp workspace on PROJECT (default `yaac`)
 * and stops it at the end; with one, it sends the prompt to that workspace.
 *
 * Run: node test-playwright-scripts/acp-background-end-states.js
 */
import path from 'node:path'
import { SHOTS, api, check, createWorkspace, finish, origin, requirePlaywright, until } from './lib.js'

const PROJECT = process.env.PROJECT ?? 'yaac'
const RUN = Date.now().toString(36).slice(-4)
const AGENT = `bg agent ${RUN}`
const SHELL = `bg shell ${RUN}`
const PROMPT = [
  'Do exactly two things, both in the background, then reply "launched" and do not wait for either:',
  `1) With the Bash tool (run_in_background=true, description "${SHELL}") run: sleep 30 && echo SHELLDONE`,
  `2) With the Agent tool (run_in_background=true, subagent_type general-purpose, description "${AGENT}")`
    + ' have a subagent run the bash command `sleep 15 && echo AGENTDONE` in the foreground, then reply DONE.',
].join('\n')

const owned = !process.env.WORKSPACE_ID
const workspaceId = process.env.WORKSPACE_ID ?? await createWorkspace({
  project: PROJECT, tool: 'claude', mode: 'acp', model: 'haiku', permissionMode: 'bypass',
  title: 'PW background end states',
})
const { workspaces } = await api('/workspace/list')
const workspace = workspaces.find((w) => w.workspaceId.startsWith(workspaceId))
if (!workspace) throw new Error(`no live workspace ${workspaceId}`)

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))
  await page.goto(`${origin}/?project=${workspace.projectSlug}&workspace=${workspace.workspaceId}`)
  const composer = page.getByPlaceholder('Message the agent…')
  await composer.waitFor({ state: 'visible', timeout: 60_000 })

  // Records each change in what the strip and the two cards show, with the
  // time since the observer started.
  await page.evaluate((names) => {
    const t0 = performance.now()
    const log = []
    window.__states = log
    const markOf = (el) => el.querySelector('svg[aria-label]')?.getAttribute('aria-label')
      ?? /(cancelled|stopped|paused|unfinished)$/.exec(el.textContent ?? '')?.[1] ?? '?'
    const read = () => {
      const strip = document.querySelector('[role="group"][aria-label="Running in the background"]')
      const chips = strip ? [...strip.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).sort() : []
      const cards = names.map((name) => {
        const card = [...document.querySelectorAll('button:not([aria-label])')]
          .find((b) => b.textContent?.includes(name) && b.querySelector('span.flex-col'))
        return card ? `${name}=${markOf(card)}` : `${name}=absent`
      })
      return JSON.stringify({ chips, cards })
    }
    let last = ''
    const record = () => {
      const now = read()
      if (now !== last) log.push({ t: Math.round(performance.now() - t0), state: JSON.parse(now) })
      last = now
    }
    record()
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  }, [AGENT, SHELL])

  await composer.fill(PROMPT)
  await composer.press('Enter')

  const states = () => page.evaluate(() => window.__states)
  const strip = page.getByRole('group', { name: 'Running in the background' })
  await strip.getByRole('button', { name: `Agent: ${AGENT}` }).waitFor({ timeout: 180_000 })
  await strip.getByRole('button', { name: new RegExp(`: ${SHELL}$`) }).waitFor({ timeout: 180_000 })
  check('both show in the strip while running', true)
  await page.screenshot({ path: path.join(SHOTS, 'background-running.png') })

  await until(page, (names) => window.__states.at(-1)?.state.cards.every((c) => names.some((n) => c === `${n}=completed`)),
    [AGENT, SHELL], 240_000).catch(() => {})
  await page.waitForTimeout(3_000)
  await page.screenshot({ path: path.join(SHOTS, 'background-ended.png') })

  const log = await states()
  for (const { t, state } of log) console.log(`  ${String(t).padStart(6)}ms  chips=${JSON.stringify(state.chips)}  ${state.cards.join('  ')}`)
  const end = log.at(-1).state
  check('the strip empties once both end', end.chips.length === 0, JSON.stringify(end.chips))
  check('the subagent card settles on completed', end.cards.includes(`${AGENT}=completed`), end.cards.join(' '))
  check('the shell card settles on completed', end.cards.includes(`${SHELL}=completed`), end.cards.join(' '))
  check('the subagent stays running until it ends',
    !log.some(({ state }) => state.chips.includes(`Agent: ${AGENT}`) && !state.cards.includes(`${AGENT}=running`)))
  // An end the live set reports first shows as cancelled/stopped until the
  // end report lands, normally in the same tick.
  const interim = log.flatMap(({ t, state }, i) => state.cards.filter((c) => /=(cancelled|stopped)$/.test(c))
    .map((c) => `${c} for ${(log[i + 1]?.t ?? t) - t}ms`))
  check('no card stays cancelled or stopped', interim.every((s) => Number(/(\d+)ms$/.exec(s)[1]) < 1_000), interim.join(', '))
} finally {
  await browser.close()
  if (owned) await api('/workspace/stop', { method: 'POST', body: { workspaceId } }).catch(() => {})
}
finish()
