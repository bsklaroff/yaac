/*
 * Verifies the settings panel's Build files manager (BuildFiles.tsx) in real
 * Chromium, under Settings → User Dockerfile:
 *   1. "New file" creates verify/hello.txt; typing in its CodeMirror editor
 *      and pressing Save shows "Saved".
 *   2. "Upload files" takes a binary file, and its row says "binary · ".
 *   3. "Upload folder" includes dotfiles and nested dot-dirs, and "New file"
 *      accepts a dotfile path (`.vimrc`).
 *   4. Each row's delete button (confirm accepted) removes it, leaving the
 *      build dir as it was.
 * SCREENSHOT_DIR gets build-files-user.png.
 *
 * k8s only: a containerless server builds no images, so it hides the
 * Dockerfile sections and its build-files routes answer NOT_SUPPORTED.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/build-files-panel.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requirePlaywright, origin, check, finish, SHOTS } from './lib.js'

const { chromium } = requirePlaywright()

// A folder holding a dotfile, a nested dotfile and a visible file, plus a
// loose binary file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-build-files-'))
const base = path.basename(dir)
fs.writeFileSync(path.join(dir, '.hidden-rc'), 'set -x\n')
fs.writeFileSync(path.join(dir, 'visible.txt'), 'v\n')
fs.mkdirSync(path.join(dir, '.config'))
fs.writeFileSync(path.join(dir, '.config', 'nested.conf'), 'n\n')
const bin = path.join(os.tmpdir(), 'yaac-verify-blob.bin')
fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
page.on('dialog', (dialog) => void dialog.accept())
await page.goto(`${origin}/`)
await page.locator('[title="Settings"]').first().click()
await page.getByRole('button', { name: 'User Dockerfile' }).click()
await page.getByText('Build files').waitFor()
const row = (rel) => page.getByRole('button', { name: rel, exact: true })
const shown = (loc) => loc.waitFor({ timeout: 10_000 }).then(() => true, () => false)

// 1. New file, edit, save.
await page.getByPlaceholder(/new file path/).fill('verify/hello.txt')
await page.getByRole('button', { name: 'New file' }).click()
await row('verify/hello.txt').waitFor()
const editor = page.locator('.cm-content').nth(1) // the first is Dockerfile.user
await editor.waitFor()
await editor.click()
await page.keyboard.type('hello from the panel')
await page.getByRole('button', { name: 'Save' }).last().click()
check('an edit to a new file saves', await shown(page.getByText('Saved')))

// 2. Binary upload.
await page.locator('input[aria-label="Upload files"]').setInputFiles(bin)
check('an uploaded binary file is flagged', await shown(page.getByText(/binary · /)))

// 3. Dotfiles.
await page.locator('input[aria-label="Upload folder"]').setInputFiles(dir)
await row(`${base}/visible.txt`).waitFor()
for (const rel of [`${base}/.hidden-rc`, `${base}/.config/nested.conf`]) {
  check(`folder upload includes ${rel}`, await row(rel).count() === 1)
}
await page.getByPlaceholder(/new file path/).fill('.vimrc')
await page.getByRole('button', { name: 'New file' }).click()
check('New file accepts a dotfile path', await shown(row('.vimrc')))
await page.screenshot({ path: path.join(SHOTS, 'build-files-user.png') })

// 4. Delete every row this run made.
for (const rel of ['verify/hello.txt', 'yaac-verify-blob.bin', '.vimrc',
  `${base}/.hidden-rc`, `${base}/.config/nested.conf`, `${base}/visible.txt`]) {
  const del = page.locator(`[aria-label="Delete ${rel}"]`)
  await del.click()
  check(`deleting ${rel} removes its row`,
    await del.waitFor({ state: 'detached' }).then(() => true, () => false))
}

await browser.close()
fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(bin, { force: true })
finish()
