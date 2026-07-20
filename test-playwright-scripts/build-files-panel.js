/*
 * Verifies the settings-panel Build files manager (BuildFiles.tsx) against a
 * live server with real mouse/keyboard events: opens Settings → User
 * Dockerfile, creates a text file via the "New file" form, edits and saves it
 * in the CodeMirror editor, uploads a binary file through the hidden
 * file-input, confirms the list rows (path, size, binary flag), deletes both
 * rows through the per-row delete button (accepting the confirm dialog), and
 * finally screenshots the Project Config section's Build files block.
 *
 * Run: node test-playwright-scripts/build-files-panel.js
 * Needs a running server (`yaac server start` / `pnpm watch`). Screenshots
 * land in /tmp/yaac-shots/build-files-*.png.
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
  const shots = '/tmp/yaac-shots'
  fs.mkdirSync(shots, { recursive: true })

  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  page.on('dialog', (dialog) => {
    console.log(`  [dialog] ${dialog.message()} -> accept`)
    void dialog.accept()
  })

  const token = await mintToken(lock)
  await page.goto(`http://127.0.0.1:${lock.port}/?token=${token}`)
  await page.waitForFunction(() => !window.location.search.includes('token='), { timeout: 15_000 })

  // Settings → User Dockerfile section.
  await page.locator('[title="Settings"]').first().click()
  await page.locator('button', { hasText: 'User Dockerfile' }).first().click()
  await page.getByText('Build files').waitFor()

  // Create a text file via the New file form.
  await page.getByPlaceholder(/new file path/).fill('verify/hello.txt')
  await page.getByRole('button', { name: 'New file' }).click()
  await page.getByRole('button', { name: 'verify/hello.txt', exact: true }).waitFor()
  console.log('created verify/hello.txt via New file form')

  // The new file opens in a second editor below the Dockerfile.user one —
  // wait for it to mount before typing, or the keystrokes land elsewhere.
  await page.locator('.cm-content').nth(1).waitFor()
  const editor = page.locator('.cm-content').nth(1)
  await editor.click()
  await page.keyboard.type('hello from the panel')
  await page.getByRole('button', { name: 'Save' }).last().click()
  await page.getByText('Saved').waitFor()
  console.log('edited + saved through CodeMirror')

  // Upload a binary file through the hidden input.
  const tmpBin = path.join(os.tmpdir(), 'yaac-verify-blob.bin')
  fs.writeFileSync(tmpBin, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))
  await page.locator('input[aria-label="Upload files"]').setInputFiles(tmpBin)
  await page.getByText('yaac-verify-blob.bin').waitFor()
  await page.getByText(/binary · /).waitFor()
  console.log('uploaded a binary file; row shows the binary flag')

  await page.screenshot({ path: `${shots}/build-files-user.png` })

  // Delete both rows (confirm dialogs auto-accepted above).
  await page.locator('[aria-label="Delete verify/hello.txt"]').click()
  await page.locator('[aria-label="Delete verify/hello.txt"]').waitFor({ state: 'detached' })
  await page.locator('[aria-label="Delete yaac-verify-blob.bin"]').click()
  await page.locator('[aria-label="Delete yaac-verify-blob.bin"]').waitFor({ state: 'detached' })
  console.log('deleted both rows through the UI')

  // Project Config section renders the same panel per project.
  await page.locator('button', { hasText: 'Project Config' }).first().click()
  await page.getByText('Build files').waitFor()
  await page.screenshot({ path: `${shots}/build-files-project.png` })
  console.log(`screenshots -> ${shots}/build-files-user.png, ${shots}/build-files-project.png`)

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
