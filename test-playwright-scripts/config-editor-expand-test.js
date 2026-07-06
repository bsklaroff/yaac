/*
 * Verifies the expand button on the settings file editors (FileEditor):
 * Settings → Project Config / User Dockerfile each show a small expand
 * button in the top-right of the CodeMirror frame; clicking it opens a
 * near-fullscreen overlay (nested dialog, inset ~16px from the viewport)
 * where the editor fills the available height and the Save button stays
 * below it. Edits made in the overlay must survive collapsing (Escape),
 * which must close only the overlay — the settings dialog stays open.
 *
 * Drives the running yaac daemon's webapp in real Chromium: opens settings,
 * expands the project yaac-config.json editor, checks overlay geometry,
 * types into the expanded CodeMirror to see Save enable, escapes back, then
 * repeats the expand check on the User Dockerfile section. Nothing is saved.
 *
 * Run: node test-playwright-scripts/config-editor-expand-test.js
 * (set SCREENSHOT_DIR to also capture inline/expanded screenshots there)
 * Needs a running daemon (`yaac daemon start`) with a project configured;
 * reads the port/secret from $YAAC_DATA_DIR/.daemon.lock (or ~/.yaac).
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
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

function readDaemonLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.daemon.lock'),
    path.join(os.homedir(), '.yaac', '.daemon.lock'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error(`no .daemon.lock found (tried ${candidates.join(', ')}) — is the daemon running?`)
}

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

/** The overlay dialog is the one hosting the collapse button. */
function overlay(page) {
  return page.getByRole('dialog').filter({ has: page.getByLabel('Collapse editor') })
}

async function expectExpandedOverlay(page, viewport, label) {
  const pop = overlay(page)
  await pop.waitFor({ state: 'visible' })
  // Let the open transition (scale-95 → 1, 150ms) settle before measuring.
  await page.waitForTimeout(400)
  const box = await pop.boundingBox()
  // inset-4 → 16px margins all around (within a couple px of rendering slack).
  const nearFull =
    Math.abs(box.x - 16) <= 2 && Math.abs(box.y - 16) <= 2 &&
    Math.abs(box.width - (viewport.width - 32)) <= 4 &&
    Math.abs(box.height - (viewport.height - 32)) <= 4
  check(`${label}: overlay is near-fullscreen`, nearFull,
    `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`)

  const editorBox = await pop.locator('.cm-editor').boundingBox()
  check(`${label}: editor fills most of the overlay height`,
    editorBox.height > box.height * 0.7, `editor ${Math.round(editorBox.height)}px of ${Math.round(box.height)}px`)

  const save = pop.getByRole('button', { name: /^(Save|Saving…)$/ })
  const saveBox = await save.boundingBox()
  check(`${label}: Save button visible below the editor`,
    saveBox !== null && saveBox.y > editorBox.y + editorBox.height,
    saveBox ? `save at y=${Math.round(saveBox.y)}` : 'missing')
  return { pop, save }
}

async function main() {
  const { chromium } = requirePlaywright()
  const lock = readDaemonLock()
  const base = `http://127.0.0.1:${lock.port}`
  const auth = { authorization: `Bearer ${lock.secret}` }

  const codeRes = await fetch(`${base}/auth/bootstrap-code`, { headers: auth })
  if (!codeRes.ok) throw new Error(`bootstrap-code failed: HTTP ${codeRes.status}`)
  const { code } = await codeRes.json()

  const browser = await chromium.launch()
  const viewport = { width: 1400, height: 900 }
  const page = await browser.newPage({ viewport, bypassCSP: true })
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  try {
    await page.goto(`${base}/?bootstrap=${code}`)

    // Settings → Project Config; wait for the config editor to load.
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Project Config' }).click()
    await page.locator('.cm-editor').first().waitFor({ state: 'visible' })

    const expandButtons = page.getByLabel('Expand editor')
    check('project section shows two expand buttons (config + dockerfile)',
      await expandButtons.count() === 2, `${await expandButtons.count()}`)
    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'config-editor-inline.png') })
    }

    // Expand yaac-config.json and check overlay geometry.
    await expandButtons.first().click()
    const { pop, save } = await expectExpandedOverlay(page, viewport, 'config')
    check('config: overlay titled with the config file',
      await pop.getByText('yaac-config.json').count() === 1)
    check('config: Save starts disabled (not dirty)', await save.isDisabled())

    // Type in the expanded editor → Save enables; screenshot the state.
    await pop.locator('.cm-content').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' ')
    check('config: editing in the overlay enables Save', await save.isEnabled())
    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'config-editor-expanded.png') })
    }

    // Escape closes only the overlay; the edit survives inline.
    await page.keyboard.press('Escape')
    await pop.waitFor({ state: 'hidden' })
    check('config: settings dialog still open after collapse',
      await page.getByRole('button', { name: 'Project Config' }).isVisible())
    const inlineSave = page.getByRole('button', { name: /^(Save|Saving…)$/ }).first()
    check('config: dirty state survives collapsing', await inlineSave.isEnabled())

    // Same affordance on the User Dockerfile section.
    await page.getByRole('button', { name: 'User Dockerfile' }).click()
    await page.locator('.cm-editor').first().waitFor({ state: 'visible' })
    await page.getByLabel('Expand editor').click()
    const { pop: dockerPop } = await expectExpandedOverlay(page, viewport, 'user dockerfile')
    check('user dockerfile: overlay titled Dockerfile.user',
      await dockerPop.getByText('Dockerfile.user').count() === 1)
    await dockerPop.getByLabel('Collapse editor').click()
    await dockerPop.waitFor({ state: 'hidden' })
    check('user dockerfile: settings dialog still open after collapse',
      await page.getByRole('button', { name: 'User Dockerfile' }).isVisible())
  } finally {
    await browser.close()
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
