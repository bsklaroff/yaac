/*
 * Verifies the Changes diff viewer's syntax-highlight CSS in real Chromium.
 *
 * The tokenizer (packages/frontend/src/lib/highlight.ts) is unit-tested and the
 * SessionChanges component test asserts the right `tok-*` classes land on the
 * right tokens — but jsdom can't resolve CSS custom properties, so neither
 * proves the colors actually paint. This does: it loads the *built* stylesheet
 * (packages/frontend/dist/assets/index-*.css) over a representative `.diff-hl`
 * diff fragment (the exact DOM DiffView emits), then reads getComputedStyle for
 * a few token spans under both the dark and light palettes and asserts each is
 * the expected GitHub-prettylights color. Fails loudly on mismatch.
 *
 * Self-contained — no running server needed. Build the frontend first so the
 * stylesheet exists: `pnpm --filter @yaac/frontend build`.
 *
 * Run: node test-playwright-scripts/diff-highlight-colors-test.js
 * (set SCREENSHOT_DIR to also drop dark/light PNGs there.)
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import url from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

function builtCss() {
  const dir = path.join(repoRoot, 'packages/frontend/dist/assets')
  const file = fs.readdirSync(dir).find((f) => /^index-.*\.css$/.test(f))
  if (!file) throw new Error('built CSS not found — run `pnpm --filter @yaac/frontend build` first')
  return fs.readFileSync(path.join(dir, file), 'utf8')
}

// A representative diff fragment in the exact shape DiffView renders: a
// `.diff-hl` container with add/context rows whose text is split into tok-*
// spans. Token ids match @lezer/highlight's classHighlighter output.
const FRAGMENT = `
<div class="diff-hl" style="font-family: monospace; font-size: 13px; padding: 12px;">
  <div style="display:flex"><span style="width:40px;color:#6a6a74">1</span><span style="width:12px;color:#3fb950">+</span><span>
    <span id="kw" class="tok-keyword">const</span> <span class="tok-variableName tok-definition">answer</span><span class="tok-punctuation">:</span> <span class="tok-typeName">number</span> <span class="tok-operator">=</span> <span id="num" class="tok-number">42</span> <span id="cm" class="tok-comment">// meaning</span>
  </span></div>
  <div style="display:flex"><span style="width:40px;color:#6a6a74">2</span><span style="width:12px">&nbsp;</span><span>
    <span class="tok-keyword">return</span> <span id="str" class="tok-string">"hello world"</span>
  </span></div>
</div>`

const EXPECT = {
  dark: { kw: 'rgb(255, 123, 114)', str: 'rgb(165, 214, 255)', cm: 'rgb(139, 148, 158)', num: 'rgb(121, 192, 255)' },
  light: { kw: 'rgb(207, 34, 46)', str: 'rgb(10, 48, 105)', cm: 'rgb(110, 119, 129)', num: 'rgb(5, 80, 174)' },
}

async function main() {
  const { chromium } = requirePlaywright()
  const css = builtCss()
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const shotDir = process.env.SCREENSHOT_DIR
  const failures = []

  for (const theme of ['dark', 'light']) {
    await page.setContent(
      `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head>` +
      `<body style="background: var(--color-bg); margin:0">${FRAGMENT}</body></html>`,
      { waitUntil: 'load' },
    )
    const got = await page.evaluate(() => {
      const color = (id) => getComputedStyle(document.getElementById(id)).color
      return { kw: color('kw'), str: color('str'), cm: color('cm'), num: color('num') }
    })
    for (const [id, want] of Object.entries(EXPECT[theme])) {
      const ok = got[id] === want
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${theme}/${id}: ${got[id]}${ok ? '' : ` (expected ${want})`}`)
      if (!ok) failures.push(`${theme}/${id}`)
    }
    if (shotDir) {
      const out = path.join(shotDir, `diff-highlight-${theme}.png`)
      await page.screenshot({ path: out })
      console.log(`  screenshot → ${out}`)
    }
  }

  await browser.close()
  if (failures.length) {
    console.error(`\n${failures.length} color mismatch(es): ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log('\nAll token colors resolve correctly in both themes.')
}

main().catch((e) => { console.error(e); process.exit(1) })
