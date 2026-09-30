/*
 * Verifies xterm 6's own scrollbar (the 14px VS Code-style one the app's
 * 3px ::-webkit-scrollbar styling can't reach) never flashes over a terminal
 * pane, even when the pane lands on its NORMAL screen — the state where a
 * tmux attach is not holding the alternate screen and every line tmux
 * scrolls off the top would otherwise go into xterm's own scrollback.
 *
 * Real Chromium, the real xterm.js + css from packages/frontend's
 * node_modules. Two terminals built with WorktreeTerminal.tsx's options, one
 * with xterm's default scrollback (1000) and one with `scrollback: 0`; each
 * is fed the same output in two phases, and a MutationObserver records
 * whether the vertical scrollbar ever gains the `visible` class:
 *   - alt screen (\e[?1049h, a normal tmux attach): no bar either way;
 *   - normal screen after leaving alt (\e[?1049l, as a detach leaves it):
 *     the default terminal's bar flashes, the scrollback-0 one's doesn't.
 * FAILs if the scrollback-0 terminal ever shows the bar, and also if the
 * default one never does — that would mean the repro no longer reproduces.
 *
 * Run: node test-playwright-scripts/xterm-normal-screen-scrollbar-test.js
 * (playwright resolved from the global npm root; browsers under
 * /opt/playwright-browsers)
 */
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const XTERM_DIR = path.join(ROOT, 'packages/frontend/node_modules/@xterm/xterm')

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

let failures = 0
function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

async function main() {
  const { chromium } = requirePlaywright()
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  page.on('console', (msg) => console.log(`  [page ${msg.type()}] ${msg.text()}`))
  await page.setContent(
    '<!DOCTYPE html><html><body style="margin:0">'
    + '<div id="dflt" style="width:900px;height:360px"></div>'
    + '<div id="sb0" style="width:900px;height:360px;margin-top:20px"></div>'
    + '</body></html>',
  )
  await page.addStyleTag({ path: path.join(XTERM_DIR, 'css/xterm.css') })
  await page.addScriptTag({ path: path.join(XTERM_DIR, 'lib/xterm.js') })

  await page.evaluate(() => {
    const base = {
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      altClickMovesCursor: false,
    }
    window.terms = {}
    window.flashes = {}
    for (const [id, extra] of [['dflt', {}], ['sb0', { scrollback: 0 }]]) {
      const term = new window.Terminal({ ...base, ...extra })
      term.open(document.getElementById(id))
      window.terms[id] = term
      window.flashes[id] = 0
      const bar = document.querySelector(`#${id} .xterm-scrollable-element > .scrollbar.vertical`)
      if (!bar) throw new Error(`${id}: no xterm scrollbar element — xterm's DOM changed`)
      new MutationObserver(() => {
        if (bar.classList.contains('visible')) window.flashes[id]++
      }).observe(bar, { attributes: true, attributeFilter: ['class'] })
    }
  })

  const writeBoth = (data) => page.evaluate((d) => Promise.all(
    Object.values(window.terms).map((t) => new Promise((res) => t.write(d, res))),
  ), data)
  const lines = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} line ${i}\r\n`).join('')
  const takeFlashes = async () => {
    await page.waitForTimeout(300)
    return page.evaluate(() => {
      const f = { ...window.flashes }
      for (const k of Object.keys(window.flashes)) window.flashes[k] = 0
      return f
    })
  }
  const baseY = () => page.evaluate(() => Object.fromEntries(
    Object.entries(window.terms).map(([k, t]) => [k, t.buffer.active.baseY]),
  ))

  // A tmux attach: alternate screen, lots of redraw output.
  await writeBoth('\x1b[?1049h' + lines('alt', 200))
  let f = await takeFlashes()
  check('alt screen: default scrollback shows no bar', f.dflt === 0, `flashes ${f.dflt}`)
  check('alt screen: scrollback 0 shows no bar', f.sb0 === 0, `flashes ${f.sb0}`)

  // Back on the normal screen (as a graceful detach leaves it), then output.
  await writeBoth('\x1b[?1049l')
  for (let i = 0; i < 10; i++) {
    await writeBoth(lines(`normal${i}`, 20))
    await page.waitForTimeout(50)
  }
  f = await takeFlashes()
  const by = await baseY()
  check('normal screen: default scrollback flashes the bar (repro)', f.dflt > 0,
    `flashes ${f.dflt}, baseY ${by.dflt}`)
  check('normal screen: scrollback 0 never shows the bar', f.sb0 === 0,
    `flashes ${f.sb0}, baseY ${by.sb0}`)

  await browser.close()
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
