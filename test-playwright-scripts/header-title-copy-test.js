/*
 * Probe: what actually lands on the clipboard when you select+copy the session
 * header title. Issue observed in the app: copying the title yields the text
 * with a leading AND trailing newline. Hypothesis: the title <span> is a direct
 * flex child, so it's "blockified" (display:block), and copying a block box's
 * text adds boundary newlines. This drives real Chromium to compare candidate
 * DOM structures and see which one copies as a clean single line.
 *
 * Structures compared (title text = "My session title"):
 *   A current   flex > span.truncate[text]                 (span is a flex item)
 *   B innerspan flex > span.truncate > span[text]          (inline text wrapper)
 *   C wrapdiv   flex > div.truncate > span.inline[text]    (text not a flex item)
 *   D baseline  block div[text]
 *   E baseline  bare inline span[text] (no flex ancestor)
 *
 * For each, it selects the text node's contents via a Range, fires a real copy,
 * and reads navigator.clipboard.readText(), printing JSON.stringify so any
 * \n is visible. The winner is whichever returns exactly "My session title".
 *
 * Run: node test-playwright-scripts/header-title-copy-test.js
 * (playwright resolved from the global npm root; browsers under
 * /opt/playwright-browsers)
 */
import { execSync } from 'node:child_process'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

const TITLE = 'My session title'

const HTML = `<!doctype html><meta charset=utf8>
<style>
  .row { display:flex; align-items:center; gap:6px; width:280px; }
  .truncate { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .flex1 { flex:1 1 0%; }
  .inline { display:inline; }
  button { flex:0 0 auto; width:20px; height:20px; }
</style>

<!-- A: current — span.truncate is the flex item -->
<div class="row"><span id="A" class="truncate flex1">${TITLE}</span><button>·</button></div>

<!-- B: text wrapped in an inner inline span, outer span still the flex item -->
<div class="row"><span class="truncate flex1"><span id="B">${TITLE}</span></span><button>·</button></div>

<!-- C: flex item is a div; text lives in an inline span (not a flex item) -->
<div class="row"><div class="truncate flex1"><span id="C" class="inline">${TITLE}</span></div><button>·</button></div>

<!-- D: plain block div -->
<div id="D">${TITLE}</div>

<!-- E: bare inline span, no flex ancestor -->
<span id="E">${TITLE}</span>

<!-- F: real-shape flex item (block, truncate) but with a copy interceptor that
     writes the trimmed selection — the fix we intend to ship. -->
<div class="row"><span id="F" class="truncate flex1">${TITLE}</span><button>·</button></div>
<script>
  document.getElementById('F').addEventListener('copy', (e) => {
    e.clipboardData.setData('text/plain', (window.getSelection().toString() || '').trim())
    e.preventDefault()
  })
</script>
`

async function boxOf(page, id) {
  return await page.evaluate((elId) => {
    const r = document.getElementById(elId).getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, id)
}

async function readClipboardAfterCopy(page) {
  return await page.evaluate(async () => {
    document.execCommand('copy')
    await new Promise((r) => setTimeout(r, 20))
    const text = await navigator.clipboard.readText()
    window.getSelection().removeAllRanges()
    return text
  })
}

// Realistic user selection: triple-click the title (selects the "line").
async function tripleClickCopy(page, id) {
  const b = await boxOf(page, id)
  await page.mouse.click(b.x + Math.min(30, b.width / 2), b.y + b.height / 2, { clickCount: 3 })
  return await readClipboardAfterCopy(page)
}

// Realistic user selection: drag across the title from just left of the first
// glyph to a bit past where short title text ends (~150px in), staying on the
// same visual row.
async function dragCopy(page, id) {
  const b = await boxOf(page, id)
  const y = b.y + b.height / 2
  await page.mouse.move(b.x + 1, y)
  await page.mouse.down()
  await page.mouse.move(b.x + Math.min(150, b.width - 1), y, { steps: 8 })
  await page.mouse.up()
  return await readClipboardAfterCopy(page)
}

async function main() {
  // Clipboard API needs a secure context; http://127.0.0.1 qualifies (data:
  // URLs are opaque origins and expose no navigator.clipboard).
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(HTML)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const { chromium } = requirePlaywright()
  const browser = await chromium.launch()
  const context = await browser.newContext()
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${port}/`)

  const labels = {
    A: 'current   flex > span.truncate[text]',
    B: 'innerspan flex > span.truncate > span[text]',
    C: 'wrapdiv   flex > div.truncate > span.inline[text]',
    D: 'baseline  block div[text]',
    E: 'baseline  bare inline span[text]',
    F: 'FIX       flex item + copy interceptor (trim)',
  }
  console.log(`expected clean copy = ${JSON.stringify(TITLE)}\n`)
  for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const tc = await tripleClickCopy(page, id)
    const dr = await dragCopy(page, id)
    const ok = (s) => (s === TITLE ? '✅' : '❌')
    console.log(`${id}  ${labels[id]}`)
    console.log(`   ${ok(tc)} triple-click = ${JSON.stringify(tc)}`)
    console.log(`   ${ok(dr)} drag         = ${JSON.stringify(dr)}`)
  }

  await browser.close()
  server.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
