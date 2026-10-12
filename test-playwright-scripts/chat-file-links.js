/*
 * Verifies file links in the ACP chat pane and the terminal in real Chromium
 * (docs/agent-modes.md "File links", docs/file-editor.md):
 *   1. Each link style in an agent reply opens the file pane with the cursor
 *      on the named line, the line centered and the editor focused (a link
 *      with no line opens at the top and leaves focus alone): a plain
 *      path, inline code with `:12`, a link target `#L40`, a link whose label
 *      is inline code, a Read call's label and an Edit call's label.
 *   2. An external URL stays a normal `<a target=_blank>`, and a fenced code
 *      block holds no file links.
 *   3. A link to a file already open and scrolled away moves the cursor; a
 *      line past the end lands on the last line.
 *   4. Inline code inside a link is not a second link: a link labelled with
 *      a file's path opens that link's target only.
 *   5. Ctrl-click on a `path:line` printed in a terminal opens it at the line.
 * SCREENSHOT_DIR gets chat-file-links-*.png.
 *
 * Needs a running containerless `yaac server` with a live claude ACP
 * workspace of the yaac project whose transcript holds the reply the prompt
 * below asks for: the agent reads files.ts, edits README.md and answers with
 * every link style. The script sends one more message, for the past-the-end
 * and code-labelled external links.
 *
 *   Use the Read tool on packages/frontend/src/lib/files.ts with offset 270
 *   and limit 20, append "<!-- link test -->" to README.md with the Edit tool,
 *   then reply with exactly:
 *     Plain path: see packages/frontend/src/lib/store.ts for the store.
 *     Inline code with a line: `packages/frontend/src/lib/files.ts:12`
 *     Link target: [files.ts:40](packages/frontend/src/lib/files.ts#L40)
 *     External URL: https://github.com/bsklaroff/yaac/blob/main/README.md
 *     Link with code label: [`packages/frontend/src/lib/store.ts`](packages/frontend/src/lib/store.ts#L100)
 *     Absolute path outside checkout: /usr/lib/node_modules/foo/package.json
 *     a fenced ts block importing 'packages/frontend/src/lib/store.ts'
 *
 * Run: node test-playwright-scripts/chat-file-links.js <workspace-id>
 * (set PLAYWRIGHT_BROWSERS_PATH on a host without /opt/playwright-browsers)
 */
import { requirePlaywright, origin, api, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()

const { workspaces } = await api('/workspace/list')
const wt = workspaces.find((w) => w.workspaceId.startsWith(process.argv[2] ?? '\0'))
if (!wt) {
  console.error('usage: node test-playwright-scripts/chat-file-links.js <live-workspace-id>')
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await page.goto(`${origin}/?${new URLSearchParams({ project: wt.projectId, workspace: wt.workspaceId })}`)
await page.waitForSelector('[role=link][title="packages/frontend/src/lib/files.ts:40"]', { timeout: 30000 })

/** The visible editor: its file, cursor line, whether it has focus, and
 *  whether the cursor line sits near the middle of the scroller. */
const editor = () => page.evaluate(() => {
  const ed = [...document.querySelectorAll('.cm-editor')].find((e) => e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && e.querySelector('.cm-lineNumbers'))
  if (!ed) return null
  const scroller = ed.querySelector('.cm-scroller').getBoundingClientRect()
  const active = ed.querySelector('.cm-activeLineGutter')?.getBoundingClientRect()
  return {
    line: Number(ed.querySelector('.cm-activeLineGutter')?.textContent),
    focused: ed.contains(document.activeElement),
    centered: active ? Math.abs((active.top + active.bottom) / 2 - (scroller.top + scroller.bottom) / 2) < scroller.height / 4 : false,
  }
})

async function clickAndCheck(name, locator, want) {
  await locator.click()
  await page.waitForTimeout(800)
  const got = await editor()
  check(`${name}: opens at line ${want.line}`, got?.line === want.line, JSON.stringify(got))
  if (want.line > 1) check(`${name}: editor focused, line centered`, got?.focused && (want.line < 20 || want.line > 85 || got?.centered), JSON.stringify(got))
}

const link = (title, nth = 0) => page.locator(`[role=link][title="${title}"]`).nth(nth)
await clickAndCheck('plain path', link('packages/frontend/src/lib/store.ts'), { line: 1 })
await clickAndCheck('inline code :12', link('packages/frontend/src/lib/files.ts:12'), { line: 12 })
await clickAndCheck('link target #L40', link('packages/frontend/src/lib/files.ts:40'), { line: 40 })
await page.screenshot({ path: `${SHOTS}/chat-file-links-L40.png` })
// [`store.ts`](store.ts#L100): the label is inline code that is itself a path.
await clickAndCheck('link whose label is inline code', page.locator('[role=link][title="packages/frontend/src/lib/store.ts:100"] code'), { line: 100 })
check('no file link nests inside another', await page.evaluate(() =>
  [...document.querySelectorAll('[role=link]')].every((l) => !l.parentElement.closest('[role=link], a'))))

// Tool rows, in the condensed run of calls.
await page.locator('text=/\\d+ tool calls/').first().click()
await page.screenshot({ path: `${SHOTS}/chat-file-links-expanded.png` })
await clickAndCheck('Read call label', link('packages/frontend/src/lib/files.ts:270'), { line: 270 })
await clickAndCheck('Edit call label', link('README.md:90').last(), { line: 90 })
await page.screenshot({ path: `${SHOTS}/chat-file-links-tools.png` })

// External links and fenced code.
const external = page.locator('a[href="https://github.com/bsklaroff/yaac/blob/main/README.md"]')
check('external URL is an <a target=_blank>', await external.getAttribute('target') === '_blank')
check('fenced code holds no file link', await page.evaluate(() =>
  [...document.querySelectorAll('pre, .cm-editor')].every((p) => !p.closest('[role=log], main') || !p.querySelector('[role=link]'))))
const outside = await page.locator('[role=link]', { hasText: '/usr/lib/node_modules/foo/package.json' }).count()
check('a path outside the checkout is not a link', outside === 0, `${outside} link(s) to the root package.json`)

// Already open and scrolled away, then a line past the end.
await clickAndCheck('re-open files.ts at :12 after :40', link('packages/frontend/src/lib/files.ts:12'), { line: 12 })
// The view keeps another workspace's chat pane mounted off-screen, so take
// the visible composer.
const box = page.locator('textarea[placeholder^="Message the agent"]').locator('visible=true').first()
await box.fill('Reply with exactly this markdown and nothing else, without using tools: '
  + '[past end](README.md#L9999) and [`README.md`](https://example.com/readme) and docs/file-editor.md:20')
await box.press('Enter')
await page.waitForSelector('[role=link][title="README.md:9999"]', { timeout: 120000 })
await clickAndCheck('line past the end', link('README.md:9999'), { line: (await api(`/workspace/${wt.workspaceId}/file?path=README.md`)).content.split('\n').length })

// Inline code that names a file, as the label of an external link: one
// click should do one thing.
const popups = []
page.context().on('page', (p) => popups.push(p.url()))
await link('packages/frontend/src/lib/files.ts:12').click()
await page.locator('a[href="https://example.com/readme"] code').last().click()
await page.waitForTimeout(1500)
const openedReadme = await page.evaluate(() => [...document.querySelectorAll('.cm-editor')]
  .some((e) => e.checkVisibility({ visibilityProperty: true }) && e.textContent.includes('yaac is released under the')))
check('code-labelled external link: only one action', !(popups.length > 0 && openedReadme),
  `popups=${JSON.stringify(popups)} openedReadme=${openedReadme}`)

// Terminal Ctrl-click.
await page.getByRole('button', { name: 'New Shell' }).click()
await page.waitForSelector('.xterm-screen', { timeout: 20000 })
await page.waitForTimeout(2500)
await page.locator('.xterm-screen').last().click()
// A fresh zsh may open its new-user menu; q leaves it, and bash has none.
await page.keyboard.type('q')
await page.waitForTimeout(500)
await page.keyboard.type('exec bash --norc --noprofile')
await page.keyboard.press('Enter')
await page.waitForTimeout(1000)
await page.keyboard.type("clear; printf 'README.md:30\\n'")
await page.keyboard.press('Enter')
await page.waitForTimeout(1500)
const screen = await page.locator('.xterm-screen').last().boundingBox()
await page.mouse.move(screen.x + 40, screen.y + 7)
await page.waitForTimeout(500)
await page.keyboard.down('Control')
await page.mouse.click(screen.x + 40, screen.y + 7)
await page.keyboard.up('Control')
await page.waitForTimeout(1000)
const term = await editor()
check('terminal Ctrl-click opens README.md at :30', term?.line === 30, JSON.stringify(term))
await page.screenshot({ path: `${SHOTS}/chat-file-links-terminal.png` })

await browser.close()
finish()
