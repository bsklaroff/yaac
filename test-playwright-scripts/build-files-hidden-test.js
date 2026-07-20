/*
 * Verifies dotfile (hidden-file) handling in the settings-panel Build files
 * manager: (1) selecting a folder through the "Upload folder" input includes
 * hidden files (dotfiles) inside it — the picker dialog may not display
 * them, but the traversal must still upload them; (2) the "New file" form
 * accepts a dotfile path (e.g. `.vimrc`) directly. Drives the running yaac
 * server's webapp in real Chromium and cleans up everything it created.
 *
 * Run: node test-playwright-scripts/build-files-hidden-test.js
 * Needs a running server (`yaac server start` / `pnpm watch`).
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

function readServerLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.server.lock'),
    path.join(os.homedir(), '.yaac', '.server.lock'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error('no .server.lock found — is the server running?')
}

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`token mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

async function main() {
  const { chromium } = requirePlaywright()
  const lock = readServerLock()

  // A folder holding a dotfile, a nested dotfile, and a visible file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvim-hidden-'))
  fs.writeFileSync(path.join(dir, '.hidden-rc'), 'set -x\n')
  fs.writeFileSync(path.join(dir, 'visible.txt'), 'v\n')
  fs.mkdirSync(path.join(dir, '.config'))
  fs.writeFileSync(path.join(dir, '.config', 'nested.conf'), 'n\n')

  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  page.on('dialog', (dialog) => void dialog.accept())

  const token = await mintToken(lock)
  await page.goto(`http://127.0.0.1:${lock.port}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })

  await page.locator('[title="Settings"]').first().click()
  await page.locator('button', { hasText: 'User Dockerfile' }).first().click()
  await page.getByText('Build files').waitFor()

  // Folder upload: the input traverses the directory programmatically, so
  // dotfiles must come through even though a picker wouldn't display them.
  const base = path.basename(dir)
  await page.locator('input[aria-label="Upload folder"]').setInputFiles(dir)
  await page.getByRole('button', { name: `${base}/visible.txt`, exact: true }).waitFor()
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('button[title^="Edit "], button[title^="Binary"]')]
      .map((el) => el.textContent))
  const listed = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label^="Delete "]')]
      .map((el) => el.getAttribute('aria-label').replace('Delete ', '')))
  console.log('uploaded rows:', JSON.stringify(listed))
  for (const expected of [`${base}/.hidden-rc`, `${base}/.config/nested.conf`, `${base}/visible.txt`]) {
    if (!listed.includes(expected)) throw new Error(`missing ${expected} — hidden files did NOT upload (rows: ${rows})`)
  }
  console.log('PASS: folder upload included dotfiles and nested dotdirs')

  // New file form accepts a dotfile path directly.
  await page.getByPlaceholder(/new file path/).fill('.vimrc')
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByRole('button', { name: '.vimrc', exact: true }).waitFor()
  console.log('PASS: New file form created .vimrc')

  // Clean up everything this run created.
  for (const rel of [base, '.vimrc']) {
    await page.locator(`[aria-label="Delete ${rel === base ? `${base}/.config/nested.conf` : rel}"]`).first().waitFor()
    // Delete the folder rows via their common top dir where possible.
  }
  for (const rel of listed.concat(['.vimrc'])) {
    const btn = page.locator(`[aria-label="Delete ${rel}"]`)
    if (await btn.count()) {
      await btn.first().click()
      await btn.first().waitFor({ state: 'detached' })
    }
  }
  console.log('cleaned up')

  await browser.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
