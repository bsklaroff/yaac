/*
 * Verifies uploads into the file explorer in real Chromium
 * (docs/file-editor.md, "Uploads"):
 *   1. "Upload files" in the header uploads picked files into the root; one
 *      already there (README.md) is offered in a "Replace?" confirm, and
 *      replacing it writes the picked bytes.
 *   2. "Upload folder" uploads a whole folder, nested files included, under
 *      its own name.
 *   3. Files dragged over a folder row tint it, and dropping them there
 *      uploads into that folder.
 * SCREENSHOT_DIR gets file-upload.png.
 *
 * Needs a running containerless `yaac server` with one live workspace of the
 * yaac project (see lib.js). It writes pw-up-* into the checkout, edits
 * README.md, and reverts both at the end.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/file-upload.js <workspace-id>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS, DATA_DIR } from './lib.js'

const { chromium } = requirePlaywright()

async function eventually(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value || Date.now() > deadline) return value
    await new Promise((r) => setTimeout(r, 100))
  }
}

const { workspaces } = await api('/workspace/list')
const wt = workspaces.find((w) => w.workspaceId.startsWith(process.argv[2] ?? '\0'))
if (!wt) {
  console.error('usage: node test-playwright-scripts/file-upload.js <live-workspace-id>')
  process.exit(1)
}
const checkout = path.join(DATA_DIR, 'global', 'projects', wt.projectId, 'workspaces', wt.workspaceId)
const onDisk = (rel) => (fs.existsSync(path.join(checkout, rel)) ? fs.readFileSync(path.join(checkout, rel), 'utf8') : null)
const readme = onDisk('README.md')

// What the file pickers hand over.
const local = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-up-'))
fs.writeFileSync(path.join(local, 'pw-up-a.txt'), 'picked a\n')
fs.writeFileSync(path.join(local, 'README.md'), 'replaced readme\n')
fs.mkdirSync(path.join(local, 'pw-up-dir', 'nested'), { recursive: true })
fs.writeFileSync(path.join(local, 'pw-up-dir', 'top.txt'), 'top\n')
fs.writeFileSync(path.join(local, 'pw-up-dir', 'nested', 'deep.txt'), 'deep\n')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const query = new URLSearchParams({ project: wt.projectId, workspace: wt.workspaceId })
await page.goto(`${origin}/?${query}`)
await page.locator('[aria-label="Browse files"]').first().click({ timeout: 20000 })
await page.locator('button[title="README.md"]').waitFor({ timeout: 20000 })

// 1. Pick files into the root, replacing one.
let chooser = page.waitForEvent('filechooser')
await page.getByRole('button', { name: 'Upload files', exact: true }).click()
await (await chooser).setFiles([path.join(local, 'pw-up-a.txt'), path.join(local, 'README.md')])
await page.getByText('Replace “README.md”?').waitFor({ timeout: 10000 })
check('a picked file lands in the root', onDisk('pw-up-a.txt') === 'picked a\n')
check('a file already there is left alone until confirmed', onDisk('README.md') === readme)
await page.getByRole('button', { name: 'Replace', exact: true }).click()
check('replacing writes the picked bytes', await eventually(() => onDisk('README.md') === 'replaced readme\n'))

// 2. Pick a folder.
chooser = page.waitForEvent('filechooser')
await page.getByRole('button', { name: 'Upload folder', exact: true }).click()
await (await chooser).setFiles(path.join(local, 'pw-up-dir'))
check('a picked folder lands with its nested files', await eventually(() => onDisk('pw-up-dir/nested/deep.txt') === 'deep\n'
  && onDisk('pw-up-dir/top.txt') === 'top\n'))

// 3. Drop on a folder row.
const target = page.locator('button[title="pw-up-dir"]')
await target.waitFor({ timeout: 10000 })
const dataTransfer = await page.evaluateHandle(() => {
  const dt = new DataTransfer()
  dt.items.add(new File(['dropped\n'], 'pw-up-dropped.txt'))
  return dt
})
await target.dispatchEvent('dragover', { dataTransfer })
const tinted = await target.evaluate((el) => el.closest('[data-drop-folder]').className.includes('bg-accent/15'))
check('dragging over a folder tints it', tinted)
await page.screenshot({ path: path.join(SHOTS, 'file-upload.png') })
await target.dispatchEvent('drop', { dataTransfer })
check('a drop lands in the folder under it', await eventually(() => onDisk('pw-up-dir/pw-up-dropped.txt') === 'dropped\n'))

await browser.close()
fs.writeFileSync(path.join(checkout, 'README.md'), readme)
for (const rel of ['pw-up-a.txt', 'pw-up-dir']) fs.rmSync(path.join(checkout, rel), { recursive: true, force: true })
fs.rmSync(local, { recursive: true, force: true })
finish()
