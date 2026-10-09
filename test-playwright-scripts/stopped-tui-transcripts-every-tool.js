/*
 * Verifies in Chromium (1400x900) that the read-only pane shows the whole
 * conversation of a stopped `tui` workspace for codex, pi and
 * opencode, translated from each tool's own history: the user prompt, every
 * tool call (title and, once expanded, its output) and the agent's final
 * text. Not just the opening prompt, and not "This conversation has no
 * messages." A fourth case checks that an opencode tool call that failed
 * shows as failed with its error.
 *
 * Nothing is stubbed: the sidebar's Stopped section and the pane fetch the
 * real list-stopped and transcript routes. It needs a running containerless server with these
 * stopped workspaces (matched by title), each a `tui` workspace whose agent
 * was told to run `echo hello-from-<tool>`, write `note-<tool>.txt` and end
 * with a reply containing `FINAL-<TOOL>-REPLY`:
 *
 *   codex tui transcript       two shell calls (echo, then printf > file)
 *   pi tui transcript          bash call, then its `write` tool
 *   opencode tui transcript 2  shell call, then its `write` tool
 *   opencode tui transcript    as above, but the write was sent bad
 *                              arguments and failed
 *
 * No model credentials are needed to make them: point each tool at a local
 * fake model server (codex through a `model_providers` entry in the project's
 * codex `config.toml`, pi through `models.json`, opencode through an
 * `@ai-sdk/openai-compatible` provider) that answers with the tool calls
 * above and then the final text. Override a title with TITLE_CODEX,
 * TITLE_PI, TITLE_OPENCODE or TITLE_OPENCODE_FAILED; set one to '' to skip
 * that case.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/stopped-tui-transcripts-every-tool.js
 * Screenshots land in $SCREENSHOT_DIR (default /tmp/yaac-shots).
 */
import path from 'node:path'
import { SHOTS, check, finish, origin, requirePlaywright } from './lib.js'

const title = (name, fallback) => process.env[name] ?? fallback

const CASES = [
  {
    tool: 'codex',
    title: title('TITLE_CODEX', 'codex tui transcript'),
    tools: [
      { title: 'echo hello-from-codex', output: 'hello-from-codex' },
      { title: 'note-codex.txt', output: 'written by codex' },
    ],
  },
  {
    tool: 'pi',
    title: title('TITLE_PI', 'pi tui transcript'),
    tools: [
      { title: 'echo hello-from-pi', output: 'hello-from-pi' },
      // pi's write becomes an edit whose diff is the new file.
      { title: 'write', output: 'written by pi' },
    ],
  },
  {
    tool: 'opencode',
    title: title('TITLE_OPENCODE', 'opencode tui transcript 2'),
    tools: [
      // opencode titles a shell call with the description the model gave it.
      { title: /hello-from-opencode/i, output: 'hello-from-opencode' },
      { title: 'write', output: 'Created file successfully' },
    ],
  },
  {
    tool: 'opencode',
    title: title('TITLE_OPENCODE_FAILED', 'opencode tui transcript'),
    reply: 'FINAL-OPENCODE-REPLY',
    tools: [
      { title: /hello-from-opencode/i, output: 'hello-from-opencode' },
      { title: 'write', output: 'Invalid arguments for tool', failed: true },
    ],
  },
].filter((c) => c.title !== '')

const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/`)
  const section = page.getByRole('group', { name: 'Stopped workspaces' })
  const header = section.getByRole('button', { name: /^Stopped/ }).first()
  await header.waitFor({ timeout: 15_000 })
  if (await header.getAttribute('aria-expanded') === 'false') await header.click()

  for (const c of CASES) {
    console.log(`\n${c.title} (${c.tool})`)
    const row = section.getByText(c.title, { exact: true }).first()
    await row.waitFor({ timeout: 10_000 }).catch(() => {})
    if (await row.count() === 0) {
      check(`${c.title}: listed as a stopped workspace`, false)
      continue
    }
    await row.click()
    // The read-only pane is the <main> holding Restart.
    const pane = page.locator('main', { has: page.getByRole('button', { name: 'Restart' }) })
      .locator('.overflow-y-auto').last()
    const reply = c.reply ?? `FINAL-${c.tool.toUpperCase()}-REPLY`
    try {
      await pane.getByText(reply).first().waitFor({ timeout: 15_000 })
    } catch { /* reported by the checks below */ }

    const text = await pane.innerText()
    check(`${c.title}: not empty`, !text.includes('This conversation has no messages.'))
    check(`${c.title}: user prompt`, text.includes(`echo hello-from-${c.tool}`) && text.includes(`note-${c.tool}.txt`))
    check(`${c.title}: final agent text`, text.includes(reply))

    // Tool rows start collapsed (an edit with a diff opens by itself); open
    // every one so its output is in the DOM.
    const closed = pane.locator('button[aria-expanded="false"]')
    for (let i = 0; i < 20 && await closed.count() > 0; i++) await closed.first().click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(SHOTS, `stopped-tui-${c.title.replaceAll(' ', '-')}.png`) })

    const rows = pane.locator('button[aria-expanded]')
    for (const t of c.tools) {
      const tr = rows.filter({ hasText: t.title }).first()
      const found = await tr.count() > 0
      check(`${c.title}: tool call ${String(t.title)}`, found)
      if (!found) continue
      // A row's output sits in the element right after its toggle.
      const block = tr.locator('xpath=..')
      const out = await block.innerText()
      check(`${c.title}: ${String(t.title)} output shows "${t.output}"`, out.includes(t.output),
        out.replace(/\s+/g, ' ').slice(0, 120))
      if (t.failed) {
        check(`${c.title}: ${String(t.title)} marked failed`, await tr.locator('[aria-label="failed"]').count() > 0)
      } else {
        check(`${c.title}: ${String(t.title)} not marked failed`, await tr.locator('[aria-label="failed"]').count() === 0)
      }
    }

    // Order: prompt, then the tool calls, then the final reply. The text is
    // read again since the expanded rows now hold their output.
    const text2 = await pane.innerText()
    const iPrompt = text2.indexOf('then summarize.')
    const iReply = text2.lastIndexOf(reply)
    const iFirstOut = text2.indexOf(c.tools[0].output, iPrompt + 1)
    check(`${c.title}: prompt, tool output, final text in order`,
      iPrompt >= 0 && iFirstOut > iPrompt && iReply > iFirstOut, `${iPrompt} < ${iFirstOut} < ${iReply}`)
  }
} finally {
  await browser.close()
}
finish()
