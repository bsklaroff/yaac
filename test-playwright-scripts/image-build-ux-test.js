/*
 * Verifies the image-build UX against the real k8s stack: a live build
 * reaches the sidebar-header pill (ImageBuildIndicator) and the fullscreen
 * overlay (ImageBuildsOverlay) through the snapshot.
 *
 * To force a build, it PUTs a Dockerfile.yaac with a unique RUN line, which
 * gives the project layer a new content-hash tag; the prewarm sweep (every
 * 60s) builds it.
 *
 * This changes the named project's Dockerfile.yaac. The script restores it
 * on exit, including on Ctrl-C, and reports loudly if that fails. If killed
 * outright, restore it with `yaac config edit-dockerfile <project>`, or new
 * workspaces keep using the junk image. The default target is the
 * `hello-world` scratch project; name a real one with --project.
 *
 * Against a running server and cluster, it:
 *   1. opens the webapp at the server's loopback origin;
 *   2. PUTs the changed Dockerfile.yaac and waits for the "building" pill
 *      for the active project (screenshot);
 *   3. opens the overlay on the running build, showing layer and step N/M
 *      (screenshot);
 *   4. waits for the build to finish; finished rows stay listed, each with a
 *      hide-only dismiss × (screenshot);
 *   5. closes the overlay; the pill stays in its muted "builds" history
 *      state (screenshot).
 *
 * Run: node test-playwright-scripts/image-build-ux-test.js [--project hello-world]
 * Needs a running server with a wired cluster and the project registered
 * (`yaac auth fake github && yaac project add <url> fake-github`). Reads port from
 * $YAAC_DATA_DIR/.server.lock. Screenshots go to $SCREENSHOT_DIR (or $TMPDIR).
 * playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execFileSync('npm', ['root', '-g']).toString().trim()
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
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

const PROJECT = process.argv.includes('--project')
  ? process.argv[process.argv.indexOf('--project') + 1]
  : 'hello-world'
const SHOT_DIR = process.env.SCREENSHOT_DIR || process.env.TMPDIR || os.tmpdir()

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

async function readDockerfile(base) {
  const res = await fetch(`${base}/api/project/${PROJECT}/dockerfile`)
  if (!res.ok) throw new Error(`dockerfile GET failed: HTTP ${res.status}`)
  return (await res.json()).content
}

async function writeDockerfile(base, content) {
  return fetch(`${base}/api/project/${PROJECT}/dockerfile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

function warnManualRestore() {
  console.error(`\n!! ${PROJECT}'s Dockerfile.yaac is STILL the cache-busting stub.`)
  console.error('!! Its project layer is repriced, so every workspace created from now on')
  console.error(`!! builds and runs the junk image. Restore it: yaac config edit-dockerfile ${PROJECT}`)
}

/**
 * Put the project's Dockerfile.yaac back. A failed restore counts as a
 * failure and prints how to fix it by hand.
 */
async function restoreDockerfile(base, original) {
  try {
    const res = await writeDockerfile(base, original)
    check('Dockerfile.yaac restored', res.ok, `HTTP ${res.status}`)
    if (!res.ok) warnManualRestore()
  } catch (err) {
    check('Dockerfile.yaac restored', false, err.message)
    warnManualRestore()
  }
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, name) })
  console.log(`  shot → ${path.join(SHOT_DIR, name)}`)
}

const BUILDING = '[aria-label="Show image build progress"]'
const HISTORY = '[aria-label="Show image build history"]'
const DISMISS = '[aria-label="Dismiss build entry"]'

async function main() {
  const { chromium } = requirePlaywright()
  const lock = readServerLock()
  const base = `http://127.0.0.1:${lock.port}`

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, bypassCSP: true })
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  const originalDockerfile = await readDockerfile(base)

  // Node's default SIGINT handling skips `finally`, so restore explicitly.
  process.once('SIGINT', () => {
    console.error('\ninterrupted — restoring Dockerfile.yaac...')
    void restoreDockerfile(base, originalDockerfile).finally(() => process.exit(130))
  })

  try {
    await page.goto(`${base}/`)
    // The only project is auto-selected; the sidebar's + button shows the
    // app has loaded.
    await page.waitForSelector('[title="New session"]', { timeout: 20_000 })
    check('workspace loaded, project auto-selected', true)

    // A unique RUN line gives the layer a tag the registry does not hold.
    const bust = `ARG BASE_IMAGE\nFROM \${BASE_IMAGE}\nRUN echo ibux-${process.pid}-${Date.now()}\n`
    const put = await writeDockerfile(base, bust)
    check('cache-busting Dockerfile.yaac accepted', put.ok, `HTTP ${put.status}`)

    // 1. The building pill. The prewarm sweep runs every 60s, so this may
    // wait a full interval.
    await page.waitForSelector(BUILDING, { timeout: 150_000 })
    check('scoped "building" pill appears', await page.locator(BUILDING).count() === 1)
    await shot(page, 'ibux-1-building-pill.png')

    // 2. Open the overlay on the running build — layer + step.
    await page.locator(BUILDING).click()
    await page.waitForSelector('text=Image builds', { timeout: 5_000 })
    await page.waitForSelector('text=/layer/', { timeout: 10_000 })
    check('overlay lists a build row with a layer label',
      (await page.locator('text=/layer/').count()) >= 1)
    await shot(page, 'ibux-2-overlay-running.png')

    // 3. Wait for completion; finished rows persist with a hide-only dismiss ×.
    await page.waitForSelector(BUILDING, { state: 'detached', timeout: 180_000 })
    // The overlay stays open with the finished rows listed.
    const dismissCount = await page.locator(DISMISS).count()
    check('finished rows persist with a dismiss × (no age-out)', dismissCount >= 1, `${dismissCount} rows`)
    await shot(page, 'ibux-3-overlay-history.png')

    // 4. Close the overlay → pill stays in the muted "builds" history state.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    const hasHistory = await page.locator(HISTORY).count() === 1
    check('pill stays as a muted history entry point after close', hasHistory)
    await shot(page, 'ibux-4-history-pill.png')
  } finally {
    // Restore the project; registry GC removes the extra tag later.
    await restoreDockerfile(base, originalDockerfile)
    await browser.close()
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
