/*
 * Verifies downloads from the file explorer in real Chromium
 * (docs/file-editor.md, "Downloads"):
 *   1. A file row's menu "Download" saves the file under its own name with
 *      its bytes.
 *   2. A folder row's menu "Download as zip" saves `<folder>.zip`, holding
 *      the folder's files and empty folders under its own name.
 *   3. The header's "Download workspace" saves the whole workspace as
 *      `<project>-<id prefix>.zip`, leaving out what git ignores.
 *   4. A folder of over 10,000 files is refused, and the refusal shows above
 *      the tree instead of starting a download.
 *   5. Under the iPhone app's bridge (faked), whose web view saves no
 *      downloads, neither the header nor a row's menu offers one.
 * SCREENSHOT_DIR gets file-download.png (the folder's menu).
 *
 * Needs a running containerless `yaac server` with one live workspace (see
 * lib.js), and bsdtar on PATH to list the zip. It writes pw-dl-* into the
 * checkout and removes them at the end.
 *
 * Run: YAAC_DATA_DIR=... node test-playwright-scripts/file-download.js <workspace-id>
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requirePlaywright, origin, api, check, finish, SHOTS, DATA_DIR } from './lib.js'

const { chromium } = requirePlaywright()

const { workspaces } = await api('/workspace/list')
const wt = workspaces.find((w) => w.workspaceId.startsWith(process.argv[2] ?? '\0'))
if (!wt) {
  console.error('usage: node test-playwright-scripts/file-download.js <live-workspace-id>')
  process.exit(1)
}
const checkout = path.join(DATA_DIR, 'global', 'projects', wt.projectId, 'workspaces', wt.workspaceId)
const put = (rel, content = '') => {
  fs.mkdirSync(path.dirname(path.join(checkout, rel)), { recursive: true })
  fs.writeFileSync(path.join(checkout, rel), content)
}
put('pw-dl-dir/top.txt', 'top\n')
put('pw-dl-dir/nested/deep.txt', 'deep\n')
fs.mkdirSync(path.join(checkout, 'pw-dl-dir/empty'), { recursive: true })
const saved = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dl-'))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const query = new URLSearchParams({ project: wt.projectId, workspace: wt.workspaceId })
await page.goto(`${origin}/?${query}`)
await page.locator('[aria-label="Browse files"]').first().click({ timeout: 20000 })
const folder = page.locator('button[title="pw-dl-dir"]')
await folder.waitFor({ timeout: 20000 })

/** Open `row`'s context menu and pick `item`, returning the download. */
async function download(row, item, shot) {
  await row.click({ button: 'right' })
  const pick = page.getByRole('menuitem', { name: item, exact: true })
  await pick.waitFor({ timeout: 5000 })
  if (shot) await page.screenshot({ path: path.join(SHOTS, shot) })
  const started = page.waitForEvent('download', { timeout: 10000 })
  await pick.click()
  const dl = await started
  const to = path.join(saved, dl.suggestedFilename())
  await dl.saveAs(to)
  return { name: dl.suggestedFilename(), to }
}

// 1. A file.
await folder.click()
const file = await download(page.locator('button[title="pw-dl-dir/top.txt"]'), 'Download')
check('a file saves under its own name', file.name === 'top.txt')
check('a file saves its bytes', fs.readFileSync(file.to, 'utf8') === 'top\n')

// 2. A folder.
const zip = await download(folder, 'Download as zip', 'file-download.png')
check('a folder saves as <name>.zip', zip.name === 'pw-dl-dir.zip')
const listed = execFileSync('bsdtar', ['-tf', zip.to], { encoding: 'utf8' }).trim().split('\n').sort()
check('the zip holds the folder under its own name', JSON.stringify(listed)
  === JSON.stringify(['pw-dl-dir/empty/', 'pw-dl-dir/nested/deep.txt', 'pw-dl-dir/top.txt']))

// 3. The whole workspace.
const project = (await api('/project/list')).find((p) => p.id === wt.projectId)
const started = page.waitForEvent('download', { timeout: 30000 })
await page.getByRole('button', { name: 'Download workspace', exact: true }).click()
const whole = await started
const wholeTo = path.join(saved, whole.suggestedFilename())
await whole.saveAs(wholeTo)
const top = `${project.name}-${wt.workspaceId.slice(0, 8)}`
check('the workspace saves as <project>-<id>.zip', whole.suggestedFilename() === `${top}.zip`)
const wholeListed = execFileSync('bsdtar', ['-tf', wholeTo], { encoding: 'utf8' }).trim().split('\n')
check('the workspace zip holds its files under one top folder', wholeListed.includes(`${top}/pw-dl-dir/top.txt`)
  && wholeListed.every((n) => n.startsWith(`${top}/`)))
check('the workspace zip leaves out what git ignores', !wholeListed.some((n) => n.includes('/node_modules/')))

// 4. A folder too large to pack.
// Made only now, since the whole workspace's zip would hold it.
for (let i = 0; i <= 10_000; i++) put(`pw-dl-huge/${i}`)
await page.locator('button[title="pw-dl-huge"]').waitFor({ timeout: 20000 })
let downloads = 0
page.on('download', () => { downloads++ })
await page.locator('button[title="pw-dl-huge"]').click({ button: 'right' })
await page.getByRole('menuitem', { name: 'Download as zip', exact: true }).click()
await page.getByText('pw-dl-huge holds over 10,000 files').waitFor({ timeout: 20000 })
check('a refused folder shows why above the tree', true)
check('a refused folder starts no download', downloads === 0)

// 5. The iPhone app.
const ios = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await ios.addInitScript(() => {
  window.yaacWindow = { app: { kind: 'ios' }, openExternal: () => {}, showServers: () => {} }
})
await ios.goto(`${origin}/?${query}`)
await ios.locator('[aria-label="Browse files"]').first().click({ timeout: 20000 })
await ios.locator('button[title="pw-dl-dir"]').click({ button: 'right', timeout: 20000 })
await ios.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor({ timeout: 5000 })
check('the iPhone app offers no download in a row\'s menu',
  await ios.getByRole('menuitem', { name: /^Download/ }).count() === 0)
check('the iPhone app offers no workspace download in the header',
  await ios.getByRole('button', { name: 'Download workspace', exact: true }).count() === 0)

await browser.close()
for (const rel of ['pw-dl-dir', 'pw-dl-huge']) fs.rmSync(path.join(checkout, rel), { recursive: true, force: true })
fs.rmSync(saved, { recursive: true, force: true })
finish()
