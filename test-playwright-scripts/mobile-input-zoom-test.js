/*
 * Verifies that no text control in the mobile shell is small enough to make
 * mobile Safari zoom the page.
 *
 * Focusing a control under 16px zooms iOS Safari and it never zooms back out;
 * what the user is left with reads as a layout bug (the pane runs off to the
 * right, the whole shell pans under a finger). `index.css` raises every
 * input/textarea/select and CodeMirror's contenteditable to 16px below the
 * mobile breakpoint, over the app's text-xs / text-[11px] utilities — this
 * walks the phone-width UI, opens everything that has a control in it, and
 * measures what actually computed.
 *
 * It is a *sweep*, so it prints the inventory it found (label, tag, px) as well
 * as passing or failing: a control that never appeared is a hole in the walk,
 * not a pass, and the printed list is how you see that. Read all three lists —
 * what was measured, what would not open (a renamed label lands here), and what
 * this walk never attempts (NOT_WALKED).
 *
 * Drives the app the server itself serves (`dist/`), reading the port + lock
 * secret from $YAAC_DATA_DIR/.server.lock — so run `pnpm build` +
 * `yaac server restart` first, or you are measuring the frontend as it was.
 *
 * Needs a running `yaac server` with at least one project and one live
 * worktree (the pane's title and find boxes are only reachable with one).
 *
 * Run: node test-playwright-scripts/mobile-input-zoom-test.js
 * (set SCREENSHOT_DIR to capture each stop; defaults to /tmp/yaac-shots,
 * APP_URL to point it elsewhere).
 * (playwright is resolved from the global npm root; browsers live under
 * /opt/playwright-browsers)
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
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
  throw new Error(`no .server.lock found (tried ${candidates.join(', ')}) — is the server running?`)
}

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
const PHONE = { width: 390, height: 844 }
/** Below this a focused control zooms mobile Safari. */
const FLOOR = 16
/** Below this a control is on screen but too narrow to type into — the failure
 *  the `min-width: 0` rule makes possible in exchange for the one it fixes. */
const USABLE = 48
/**
 * Controls the walk does not reach at all, printed with the verdict so the
 * sweep's edge is stated rather than implied. These are where an unshrinkable
 * row would still hide.
 */
const NOT_WALKED = [
  "ConnectSplash's token box (the walk mints a token, so it never sees the pre-auth screen)",
  'BranchPicker inside the new-worktree sheet (needs the picker opened)',
  'the badge popovers (unforwarded ports, blocked hosts, usage, image builds)',
  "FileEditor's expanded-editor dialog",
]

async function mintToken(lock) {
  const res = await fetch(`http://127.0.0.1:${lock.port}/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (res.status !== 201) throw new Error(`mint failed: HTTP ${res.status}`)
  return (await res.json()).token
}

/**
 * Every visible text control on screen right now, with the size it computed to.
 * xterm's hidden helper textarea is excluded: it is the terminal's own input
 * sink, sized by xterm inline to line up an IME with the cursor, and it is not
 * something a finger ever lands in.
 */
function controlsOnScreen() {
  return () => {
    const out = []
    for (const el of document.querySelectorAll('input, textarea, select, .cm-content')) {
      if (el.classList.contains('xterm-helper-textarea')) continue
      // Not rendered at all (`display: none` — the file inputs behind
      // BuildFiles' upload buttons) versus rendered and crushed to nothing:
      // the second is a finding, so only the first is skipped. A zero-size
      // filter would swallow exactly the failure the width check looks for.
      if (el.getClientRects().length === 0) continue
      if (getComputedStyle(el).visibility === 'hidden') continue
      const r = el.getBoundingClientRect()
      out.push({
        tag: el.tagName.toLowerCase() + (el.type ? `[${el.type}]` : ''),
        label: (el.getAttribute('aria-label') || el.getAttribute('placeholder')
          || el.className?.toString().split(' ')[0] || '').slice(0, 34),
        px: Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10,
        // The two directions a 16px control can cost its row, one per rule.
        // Without `min-width: 0` it refuses to shrink and pushes its own submit
        // button off the right edge; with it, an overfull row can squeeze it
        // toward zero instead. Both leave the app unusable, so both are
        // measured.
        overhang: Math.round(r.right - document.documentElement.clientWidth),
        width: Math.round(r.width),
      })
    }
    return out
  }
}

/** Tap a thing if it is there; report whether the walk got that far. */
async function tapIfPresent(locator, timeout = 5000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout })
    await locator.first().tap()
    return true
  } catch {
    return false
  }
}

fs.mkdirSync(SHOTS, { recursive: true })
const { chromium } = requirePlaywright()
const lock = readServerLock()
const APP_URL = process.env.APP_URL ?? `http://127.0.0.1:${lock.port}`
const browser = await chromium.launch()
/** name -> controls found there; the inventory printed at the end. */
const seen = new Map()
/** Stops the walk could not open at all — a hole in the sweep, not a pass. */
const unreached = []
try {
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  const token = await mintToken(lock)
  await page.goto(`${APP_URL}/?token=${token}`)
  await page.waitForTimeout(5000)

  /** Measure whatever is on screen and file it under `where`. */
  const sweep = async (where) => {
    await page.waitForTimeout(600)
    const found = await page.evaluate(controlsOnScreen())
    seen.set(where, found)
    await page.screenshot({ path: path.join(SHOTS, `mobile-inputs-${where}.png`) })
    return found
  }

  const shell = page.locator('#root > div > div > div')
  const projectsLayer = shell.locator('> div').nth(0)
  const worktreesLayer = shell.locator('> div').nth(1)
  const paneLayer = shell.locator('> div').nth(2)
  // Twice, deliberately: one press closes a menu nested in a dialog only as far
  // as the dialog, and a popup left open swallows the *next* stop's tap — which
  // then reads as a stop that would not open rather than as this one not
  // closing.
  const escape = async () => {
    for (const _ of [0, 1]) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(350)
    }
  }

  /**
   * Open one stop and measure it. Every failure to get there is recorded, not
   * dropped: a renamed label or a moved button would otherwise make a stop that
   * *stopped opening* indistinguishable from one that never existed, and the
   * size check would keep passing on whatever the walk still reaches.
   */
  const stop = async (where, locator, timeout) => {
    if (!await tapIfPresent(locator, timeout)) { unreached.push(where); return false }
    await sweep(where)
    return true
  }

  // ---- projects screen: new project, settings sections ----
  if (await stop('new-project', projectsLayer.getByText('Add project', { exact: true }))) await escape()
  // The section nav is a row of chips below md; each pane owns its own
  // controls, and only some sections have any. Server is desktop-bridge only
  // (`visibleSections` drops it in a browser), so it lands in the hole list on
  // every browser run — which is the point of printing that list.
  const SECTIONS = ['Credentials', 'Server', 'Project Config', 'User Dockerfile']
  const sectionStop = (tab) => `settings-${tab.toLowerCase().replace(/ /g, '-')}`
  if (await tapIfPresent(projectsLayer.getByText('Settings', { exact: true }))) {
    for (const tab of SECTIONS) {
      await stop(sectionStop(tab), page.getByRole('button', { name: tab, exact: true }))
    }
    await escape()
  } else {
    unreached.push('settings', ...SECTIONS.map(sectionStop))
  }

  // ---- worktrees screen: project menu, skills, stopped, new worktree ----
  await projectsLayer.locator('button:has(> span.truncate)').first().tap()
  await page.waitForTimeout(1500)
  await sweep('worktrees')
  // The remove-project dialog's type-to-confirm box (ConfirmDialog's input).
  if (await tapIfPresent(worktreesLayer.locator('button:has-text("yaac")').first())) {
    await stop('remove-project', page.getByText('Remove project', { exact: true }))
    await escape()
  } else {
    unreached.push('project-menu', 'remove-project')
  }
  if (await stop('skills', worktreesLayer.getByLabel('Skills'))) await escape()
  // Only rendered once the project has a stopped worktree — absent is a fact
  // about the environment, and the hole list says so either way.
  if (await stop('stopped', worktreesLayer.getByText('Stopped worktrees', { exact: true }))) await escape()
  if (await stop('new-worktree', worktreesLayer.getByTitle('New worktree'))) await escape()

  // ---- the pane: its title rename, and the changes pane's find box ----
  await escape()
  const row = worktreesLayer
    .locator('.group.relative.mx-2:has([aria-label="Delete worktree"]) > button')
  const hasWorktree = await tapIfPresent(row, 20_000)
  check('the walk reached a live worktree (the pane controls need one)', hasWorktree)
  if (hasWorktree) {
    await page.waitForTimeout(4000)
    await sweep('pane')
    await stop('pane-rename', paneLayer.getByLabel('Rename worktree'))
    await escape()
    if (await tapIfPresent(paneLayer.getByLabel('More pane actions'))) {
      // Swept by hand rather than through `stop`: the diff has to load before
      // its find box exists to measure.
      if (await tapIfPresent(page.getByText('Review changes', { exact: true }))) {
        await page.waitForTimeout(3000)
        await sweep('changes')
      } else {
        unreached.push('changes')
      }
    } else {
      unreached.push('pane-menu', 'changes')
    }
  } else {
    unreached.push('pane', 'pane-rename', 'changes')
  }

  // ---- the verdict ----
  const all = [...seen].flatMap(([where, list]) => list.map((c) => ({ ...c, where })))
  console.log('\n  controls found:')
  for (const c of all) {
    const over = c.overhang > 0 ? `  (+${c.overhang}px past the screen)` : ''
    const thin = c.width < USABLE ? `  (${c.width}px wide)` : ''
    console.log(`    ${String(c.px).padStart(5)}px  ${c.where} — ${c.tag} ${c.label}${over}${thin}`)
  }
  const small = all.filter((c) => c.px < FLOOR)
  check(`every text control is at least ${FLOOR}px`, small.length === 0,
    small.map((c) => `${c.where}/${c.tag} ${c.px}px`).join(' '))
  const spilling = all.filter((c) => c.overhang > 0)
  check('no control is pushed off the right of the screen', spilling.length === 0,
    spilling.map((c) => `${c.where}/${c.label} +${c.overhang}px`).join(' '))
  const crushed = all.filter((c) => c.width < USABLE)
  check(`no control is squeezed below ${USABLE}px of usable width`, crushed.length === 0,
    crushed.map((c) => `${c.where}/${c.label} ${c.width}px`).join(' '))
  // A walk that opened nothing would pass the size check vacuously.
  check('the walk actually opened controls to measure', all.length >= 8, `${all.length} found`)
  const bare = [...seen].filter(([, list]) => list.length === 0).map(([where]) => where)
  if (bare.length > 0) console.log(`  (no controls on: ${bare.join(', ')})`)
  if (unreached.length > 0) console.log(`  (never opened: ${unreached.join(', ')})`)
  console.log('  (not walked at all:)')
  for (const s of NOT_WALKED) console.log(`    - ${s}`)

  console.log(`\nscreenshots: ${SHOTS}`)
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
} finally {
  await browser.close()
}
process.exit(failures === 0 ? 0 : 1)
