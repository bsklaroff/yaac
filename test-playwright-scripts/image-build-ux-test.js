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
 * k8s only: a containerless server builds no images (its Dockerfile route
 * answers 501), so this cannot run in a yaac dev workspace. The pill and
 * overlay states themselves are unit-tested in packages/frontend/test.
 *
 * Run: node test-playwright-scripts/image-build-ux-test.js [--project hello-world]
 * Needs a server with a wired cluster (see lib.js) and the project
 * registered. Screenshots: $SCREENSHOT_DIR/ibux-*.png.
 */
import path from 'node:path'
import { api, check, finish, origin, requirePlaywright, SHOTS } from './lib.js'

const PROJECT = process.argv.includes('--project')
  ? process.argv[process.argv.indexOf('--project') + 1]
  : 'hello-world'
const dockerfileRoute = `/project/${PROJECT}/dockerfile`
const writeDockerfile = (content) => api(dockerfileRoute, { method: 'PUT', body: { content } })

function warnManualRestore() {
  console.error(`\n!! ${PROJECT}'s Dockerfile.yaac is STILL the cache-busting stub.`)
  console.error('!! Its project layer is repriced, so every workspace created from now on')
  console.error(`!! builds and runs the junk image. Restore it: yaac config edit-dockerfile ${PROJECT}`)
}

/**
 * Put the project's Dockerfile.yaac back. A failed restore counts as a
 * failure and prints how to fix it by hand.
 */
async function restoreDockerfile(original) {
  try {
    await writeDockerfile(original)
    check('Dockerfile.yaac restored', true)
  } catch (err) {
    check('Dockerfile.yaac restored', false, err.message)
    warnManualRestore()
  }
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name) })
}

const BUILDING = '[aria-label="Show image build progress"]'
const HISTORY = '[aria-label="Show image build history"]'
const DISMISS = '[aria-label="Dismiss build entry"]'

async function main() {
  const originalDockerfile = (await api(dockerfileRoute)).content
  const { chromium } = requirePlaywright()
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  // Node's default SIGINT handling skips `finally`, so restore explicitly.
  process.once('SIGINT', () => {
    console.error('\ninterrupted — restoring Dockerfile.yaac...')
    void restoreDockerfile(originalDockerfile).finally(() => process.exit(130))
  })

  try {
    await page.goto(`${origin}/?project=${PROJECT}`)
    await page.locator('aside').waitFor({ timeout: 20_000 })

    // A unique RUN line gives the layer a tag the registry does not hold.
    const bust = `ARG BASE_IMAGE\nFROM \${BASE_IMAGE}\nRUN echo ibux-${process.pid}-${Date.now()}\n`
    await writeDockerfile(bust)

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
    await restoreDockerfile(originalDockerfile)
    await browser.close()
  }

  finish()
}

main().catch((err) => { console.error(err); process.exit(1) })
