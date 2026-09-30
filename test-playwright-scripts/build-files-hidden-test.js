/*
 * Verifies dotfile handling in the settings panel's Build files manager:
 * (1) "Upload folder" includes dotfiles, even though a picker may hide them;
 * (2) the "New file" form accepts a dotfile path such as `.vimrc`. Drives
 * the running server's webapp in real Chromium and cleans up after itself.
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

  await page.goto(`http://127.0.0.1:${lock.port}/`)

  await page.locator('[title="Settings"]').first().click()
  await page.locator('button', { hasText: 'User Dockerfile' }).first().click()
  await page.getByText('Build files').waitFor()

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

  await page.getByPlaceholder(/new file path/).fill('.vimrc')
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByRole('button', { name: '.vimrc', exact: true }).waitFor()
  console.log('PASS: New file form created .vimrc')

  // Clean up everything this run created.
  for (const rel of [base, '.vimrc']) {
    await page.locator(`[aria-label="Delete ${rel === base ? `${base}/.config/nested.conf` : rel}"]`).first().waitFor()
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
