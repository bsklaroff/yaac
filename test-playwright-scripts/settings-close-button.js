/*
 * Verifies the settings modal's top-right close X stays usable while the
 * content pane scrolls: at every scroll offset of every section it is still
 * visible and is the topmost element under its own center (nothing scrolled
 * beneath it, like the Sounds switch or a faded disabled button, paints over
 * it), and clicking it closes the modal. Also checks that at rest it covers
 * no content, that Tab reaches it right after the section nav, that Escape
 * closes, and that it keeps its accessible name. Runs at desktop, narrow
 * desktop and 390 px phone widths, in light and dark themes, screenshotting
 * each to $SCREENSHOT_DIR (default /tmp/yaac-shots).
 *
 * Needs a running `yaac server` (see lib.js) with a project added, so the
 * Project Config section has content.
 *
 * Run: node test-playwright-scripts/settings-close-button.js
 */
import { SHOTS, check, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()

const VIEWPORTS = [
  ['desktop', { width: 1400, height: 800 }],
  ['narrow', { width: 1000, height: 600 }],
  ['phone', { width: 390, height: 800 }],
]
const SECTIONS = ['General', 'Shortcuts', 'Credentials', 'Project Config', 'Skills']

/*
 * In-page: the close button's rect, and whether the element at its center
 * belongs to it. Each in-page helper finds the padded content pane as the
 * X's parent or its sibling, so the script also runs against a build where
 * the X sits inside the scroller, and fails there.
 */
function probe() {
  const x = document.querySelector('[aria-label="Close settings"]')
  const r = x.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return {
    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    visible: r.width > 0 && r.height > 0 && getComputedStyle(x).visibility !== 'hidden',
    onTop: x === hit || x.contains(hit),
  }
}

/* In-page: the pane's scroll range. */
function scroller() {
  const x = document.querySelector('[aria-label="Close settings"]')
  const s = x.parentElement.matches('.p-6') ? x.parentElement : x.nextElementSibling
  return { scrollable: s.scrollHeight > s.clientHeight + 1, max: s.scrollHeight - s.clientHeight }
}

function scrollTo(top) {
  const x = document.querySelector('[aria-label="Close settings"]')
  const pane = x.parentElement.matches('.p-6') ? x.parentElement : x.nextElementSibling
  pane.scrollTop = top
}

/*
 * In-page: content in the scroller that intersects the X: the boxes of its
 * controls and the glyph boxes of its text (a heading's block box spans the
 * row, its text does not).
 */
function covered() {
  const x = document.querySelector('[aria-label="Close settings"]')
  const xr = x.getBoundingClientRect()
  const meets = (r) => r.width > 0 && r.height > 0
    && r.right > xr.left && r.left < xr.right && r.bottom > xr.top && r.top < xr.bottom
  const hits = []
  const root = x.parentElement.matches('.p-6') ? x.parentElement : x.nextElementSibling
  for (const el of root.querySelectorAll('button, input, select, textarea, a, [role=switch]')) {
    if (!x.contains(el) && meets(el.getBoundingClientRect())) hits.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 30)}"`)
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim() || x.contains(n)) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    if ([...range.getClientRects()].some(meets)) hits.push(`text "${n.textContent.trim().slice(0, 30)}"`)
  }
  return hits
}

/*
 * Moves `selector` (in the pane) right under the X by `position: relative`
 * offsets, which the Sounds switch already has. The real layouts only bring
 * the right edge of content beneath the X; this forces the layered cases.
 */
function parkUnder(selector) {
  const x = document.querySelector('[aria-label="Close settings"]')
  const pane = x.parentElement.matches('.p-6') ? x.parentElement : x.nextElementSibling
  const el = pane.querySelector(selector)
  if (!el) return false
  const xr0 = x.getBoundingClientRect()
  const er0 = el.getBoundingClientRect()
  el.style.position = 'relative'
  el.style.left = `${xr0.left - er0.left}px`
  el.style.top = `${xr0.top - er0.top}px`
  const er = el.getBoundingClientRect()
  const xr = x.getBoundingClientRect()
  return er.right > xr.left && er.left < xr.right && er.bottom > xr.top && er.top < xr.bottom
}

const browser = await chromium.launch()
try {
  for (const theme of ['light', 'dark']) {
    for (const [name, viewport] of VIEWPORTS) {
      const tag = `${theme}/${name}`
      const page = await browser.newPage({ viewport, colorScheme: theme })
      await page.goto(`${origin}/`)
      const open = async () => {
        await page.getByTitle('Settings').first().click()
        await page.getByLabel('Close settings').waitFor({ timeout: 10_000 })
        await page.waitForTimeout(250)
      }
      await open()
      const close = page.getByRole('button', { name: 'Close settings' })
      // A real mouse click at the X's center; Playwright refuses to click
      // when another element would receive it, which is the bug.
      const clickCloses = async () => {
        try {
          await close.click({ timeout: 3_000 })
          await close.waitFor({ state: 'detached', timeout: 3_000 })
          return true
        } catch {
          await page.keyboard.press('Escape')
          await close.waitFor({ state: 'detached', timeout: 3_000 })
          return false
        }
      }
      check(`${tag}: X has its accessible name`, await close.count() === 1)

      for (const section of SECTIONS) {
        await page.getByRole('button', { name: section, exact: true }).click()
        await page.waitForTimeout(400)
        const atRest = await page.evaluate(covered)
        check(`${tag} ${section}: X covers no content at rest`, atRest.length === 0, atRest.join(', '))
        const { scrollable, max } = await page.evaluate(scroller)
        const home = (await page.evaluate(probe)).rect
        let worst = null
        for (let top = 0; top <= max + 20; top += 8) {
          await page.evaluate(scrollTo, top)
          const p = await page.evaluate(probe)
          if (!p.visible || !p.onTop || p.rect.top !== home.top || p.rect.left !== home.left) { worst = top; break }
        }
        check(`${tag} ${section}: X stays put, visible and on top at every scroll offset`, worst === null,
          `${scrollable ? `max ${max}` : 'not scrollable'}${worst !== null ? `, lost at ${worst}` : ''}`)
        if (section === 'General') {
          await page.evaluate(scrollTo, max)
          await page.screenshot({ path: `${SHOTS}/settings-close-${theme}-${name}-bottom.png` })
        }
      }

      // The layered cases from the bug: a `relative` switch and a disabled,
      // faded button, each parked beneath the X, then clicked through.
      await page.getByRole('button', { name: 'General', exact: true }).click()
      await page.waitForTimeout(300)
      check(`${tag}: Sounds switch parked under X`, await page.evaluate(parkUnder, '[role=switch]'))
      check(`${tag}: X on top of Sounds switch`, (await page.evaluate(probe)).onTop)
      await page.screenshot({ path: `${SHOTS}/settings-close-${theme}-${name}-switch.png` })
      check(`${tag}: X click over switch closes`, await clickCloses())

      await open()
      await page.getByPlaceholder('Your Name').fill('')
      const save = page.getByRole('button', { name: 'Save', exact: true })
      check(`${tag}: Save is disabled`, await save.isDisabled())
      check(`${tag}: disabled Save parked under X`,
        await page.evaluate(parkUnder, 'form button[type=submit]'))
      check(`${tag}: X on top of disabled Save`, (await page.evaluate(probe)).onTop)
      await page.screenshot({ path: `${SHOTS}/settings-close-${theme}-${name}-disabled.png` })
      check(`${tag}: X click over disabled button closes`, await clickCloses())

      // Scrolled to the bottom, a plain click closes.
      await open()
      const { max } = await page.evaluate(scroller)
      await page.evaluate(scrollTo, max)
      check(`${tag}: X click at bottom closes`, await clickCloses())

      // Tab from the last nav section lands on the X; Escape closes.
      await open()
      await page.getByRole('button', { name: 'Skills', exact: true }).focus()
      await page.keyboard.press('Tab')
      check(`${tag}: Tab after nav reaches X`,
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Close settings'))
      await page.keyboard.press('Escape')
      check(`${tag}: Escape closes`,
        await close.waitFor({ state: 'detached', timeout: 3_000 }).then(() => true, () => false))
      await page.close()
    }
  }
} finally {
  await browser.close()
}
finish()
