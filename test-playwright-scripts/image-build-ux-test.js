/*
 * Verifies the image-build UX end-to-end against the real stack: a live
 * image build flows through the server's build registry and the snapshot
 * WebSocket into the sidebar-header pill (ImageBuildIndicator) and the
 * fullscreen overlay (ImageBuildsOverlay).
 *
 * The build is started the way every build starts now that tags are
 * immutable — by moving a layer's content hash. The script PUTs a
 * Dockerfile.yaac carrying a unique RUN line, which gives the project layer
 * a tag nothing has built, and the prewarm sweep (every 60s) picks it up.
 *
 * IT THEREFORE MUTATES THE NAMED PROJECT'S Dockerfile.yaac, and restores it
 * on the way out (including on SIGINT — the script sits in waits of up to
 * 150s, so it invites a Ctrl-C). A run that dies without restoring leaves
 * the project layer repriced, and every worktree created afterwards builds
 * and runs the junk `RUN echo ibux-…` image until someone puts the original
 * back. The script says so loudly if its own restore fails; if it is killed
 * outright (SIGKILL), restore by hand with `yaac config edit-dockerfile
 * <project>`. Default target is the `hello-world` scratch project — a real
 * project has to be named explicitly with --project.
 *
 * Exercises, against a running server + cluster:
 *   1. auth via a one-time token (POST /tokens), lands in the webapp
 *   2. PUTs a cache-busting Dockerfile.yaac, waits for the "building"
 *      pill (scoped to the active project) — screenshot
 *   3. opens the overlay on the running build (layer + step N/M) — screenshot
 *   4. waits for the build to finish and asserts the finished rows PERSIST
 *      (no age-out) with a hide-only dismiss × on each — screenshot
 *   5. closes the overlay and asserts the pill stays in its muted "builds"
 *      history state (persisted rows remain reachable) — screenshot
 *
 * Run: node test-playwright-scripts/image-build-ux-test.js [--project hello-world]
 * Needs a running server with a wired cluster and the project registered
 * (`yaac auth fake github && curl … /project/add`). Reads port/secret from
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

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

async function readDockerfile(base, auth) {
  const res = await fetch(`${base}/project/${PROJECT}/dockerfile`, { headers: auth })
  if (!res.ok) throw new Error(`dockerfile GET failed: HTTP ${res.status}`)
  return (await res.json()).content
}

async function writeDockerfile(base, auth, content) {
  return fetch(`${base}/project/${PROJECT}/dockerfile`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

function warnManualRestore() {
  console.error(`\n!! ${PROJECT}'s Dockerfile.yaac is STILL the cache-busting stub.`)
  console.error('!! Its project layer is repriced, so every worktree created from now on')
  console.error(`!! builds and runs the junk image. Restore it: yaac config edit-dockerfile ${PROJECT}`)
}

/**
 * Put the project's Dockerfile.yaac back. A failed restore is the one
 * failure the operator MUST hear about — swallowing it exits clean while
 * leaving the project mutated — so it counts into `failures` and says how
 * to fix it by hand.
 */
async function restoreDockerfile(base, auth, original) {
  try {
    const res = await writeDockerfile(base, auth, original)
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
  const auth = { authorization: `Bearer ${lock.secret}` }

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, bypassCSP: true })
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  const originalDockerfile = await readDockerfile(base, auth)

  // Node's default SIGINT disposition terminates without unwinding, so the
  // `finally` restore below never runs on a Ctrl-C — and this script sits in
  // waits of up to 150s, which is exactly when someone reaches for one.
  process.once('SIGINT', () => {
    console.error('\ninterrupted — restoring Dockerfile.yaac...')
    void restoreDockerfile(base, auth, originalDockerfile).finally(() => process.exit(130))
  })

  try {
    const token = await mintToken(lock)
    await page.goto(`${base}/?token=${token}`)
    // Only project registered → auto-selected; the sidebar's + button proves
    // we're in the workspace (not the connect splash).
    await page.waitForSelector('[title="New session"]', { timeout: 20_000 })
    check('workspace loaded, project auto-selected', true)

    // Move the project layer's content hash so a build becomes necessary.
    // The unique RUN line is the whole point: an identical Dockerfile would
    // resolve to a tag the registry already holds and build nothing.
    const bust = `ARG BASE_IMAGE\nFROM \${BASE_IMAGE}\nRUN echo ibux-${process.pid}-${Date.now()}\n`
    const put = await writeDockerfile(base, auth, bust)
    check('cache-busting Dockerfile.yaac accepted', put.ok, `HTTP ${put.status}`)

    // 1. Building pill, scoped to the active project. The prewarm sweep runs
    // on a 60s tick, so this waits out a full interval plus the build's start.
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
    // Overlay stays mounted (kept open) — the succeeded rows are still listed.
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
    // Put the project back where it was; the busted layer's tag is left in
    // the registry for the build-cache GC to age out.
    await restoreDockerfile(base, auth, originalDockerfile)
    await browser.close()
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
