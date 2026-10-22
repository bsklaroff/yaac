/*
 * Verifies the webapp pads its chrome by non-zero `env(safe-area-inset-*)`,
 * as the iPhone app's web view reports them (ios/README.md "Layout"): an
 * iPhone 14 portrait (390x844, top 47 / bottom 34) and landscape (844x390,
 * left/right 47, bottom 21). Insets are injected with CDP's
 * Emulation.setSafeAreaInsetsOverride, so `env()` itself resolves non-zero;
 * nothing in the page is patched. Checks that the visible content stays
 * inside the safe area, and that the env() values reached the page. The
 * shell's own children (the phone shell's absolutely positioned screens) must
 * clear it too, except that their top edge may sit TOP_SLACK into it, the
 * empty edge `safe-area-inset` gives back (index.css).
 * Then opens the settings and new-workspace dialogs, which are
 * portaled outside the shell, and checks each of them the same way.
 * Screenshots go to $SCREENSHOT_DIR (default /tmp/yaac-shots).
 *
 * Needs a running server with at least one project (see lib.js):
 *   node test-playwright-scripts/ios-safe-area-test.js
 */
import { SHOTS, api, check, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()
const project = (await api('/project/list'))[0]?.name
if (!project) throw new Error('no project — add one first')

const TOP_SLACK = 6

/* Whether a box stays inside the insets, the top one less `slack`. */
const clears = (r, insets, viewport, slack = 0) =>
  r.top >= Math.max(0, insets.top - slack) && r.left >= insets.left
    && r.right <= viewport.width - insets.right && r.bottom <= viewport.height - insets.bottom

const cases = [
  { name: 'portrait', viewport: { width: 390, height: 844 }, insets: { top: 47, bottom: 34, left: 0, right: 0 } },
  { name: 'landscape', viewport: { width: 844, height: 390 }, insets: { top: 0, bottom: 21, left: 47, right: 47 } },
]

const browser = await chromium.launch()
try {
  for (const { name, viewport, insets } of cases) {
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets })
    await page.goto(origin)
    await page.waitForSelector('#root *', { timeout: 20_000 })
    await page.waitForTimeout(1500)

    const probe = await page.evaluate(() => {
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
      document.body.append(el)
      const s = getComputedStyle(el)
      const env = { top: s.paddingTop, right: s.paddingRight, bottom: s.paddingBottom, left: s.paddingLeft }
      el.remove()
      const shell = document.querySelector('.safe-area-inset')
      const ss = shell && getComputedStyle(shell)
      /* The bounding box of every visible, non-empty match. */
      const extent = (selector) => {
        const boxes = [...document.querySelectorAll(selector)]
          .filter((e) => {
            const st = getComputedStyle(e)
            const r = e.getBoundingClientRect()
            return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && !e.closest('[inert]')
          })
          .map((e) => e.getBoundingClientRect())
        return {
          top: Math.min(...boxes.map((r) => r.top)),
          left: Math.min(...boxes.map((r) => r.left)),
          bottom: Math.max(...boxes.map((r) => r.bottom)),
          right: Math.max(...boxes.map((r) => r.right)),
        }
      }
      return {
        env,
        shellInset: ss && { top: ss.borderTopWidth, right: ss.borderRightWidth, bottom: ss.borderBottomWidth, left: ss.borderLeftWidth },
        screens: extent('.safe-area-inset > *'),
        content: extent('#root button, #root a, #root input, #root textarea, #root h1, #root h2, #root span, #root svg'),
      }
    })
    console.log(name, JSON.stringify(probe))
    check(`${name}: env() reports the injected insets`,
      probe.env.top === `${insets.top}px` && probe.env.left === `${insets.left}px` && probe.env.bottom === `${insets.bottom}px`)
    check(`${name}: the shell's screens clear the insets`, clears(probe.screens, insets, viewport, TOP_SLACK))
    check(`${name}: content clears every inset`, clears(probe.content, insets, viewport))
    await page.screenshot({ path: `${SHOTS}/ios-safe-area-${name}.png` })

    /* The first visible match: some openers exist once per layout. */
    const visible = (selector) => page.locator(selector).locator('visible=true').first()
    const dialogs = [
      ['settings', '[title="Settings"]'],
      ['new-workspace', '[title="New workspace"]'],
    ]
    for (const [dialog, opener] of dialogs) {
      /* On the phone the workspace openers are on the project's screen. */
      if (!await visible(opener).isVisible()) await visible(`button:has(> span.truncate):has-text("${project}")`).tap()
      await visible(opener).tap()
      await page.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForTimeout(500)
      /*
       * The popup's box inside any inset border, and the extent of its
       * visible content: each leaf clipped to the scrolling boxes it sits in.
       */
      const box = await page.evaluate(() => {
        const popup = document.querySelector('[role="dialog"]')
        const inner = (e) => {
          const r = e.getBoundingClientRect()
          const st = getComputedStyle(e)
          return {
            top: r.top + parseFloat(st.borderTopWidth),
            left: r.left + parseFloat(st.borderLeftWidth),
            bottom: r.bottom - parseFloat(st.borderBottomWidth),
            right: r.right - parseFloat(st.borderRightWidth),
          }
        }
        const visibleRect = (e) => {
          const r = e.getBoundingClientRect()
          let v = { top: r.top, left: r.left, bottom: r.bottom, right: r.right }
          for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
            if (getComputedStyle(a).overflow === 'visible') continue
            const c = inner(a)
            v = {
              top: Math.max(v.top, c.top), left: Math.max(v.left, c.left),
              bottom: Math.min(v.bottom, c.bottom), right: Math.min(v.right, c.right),
            }
          }
          return v
        }
        const rects = [...popup.querySelectorAll('button, a, input, textarea, select, h1, h2, span, svg')]
          .filter((e) => getComputedStyle(e).visibility !== 'hidden')
          .map(visibleRect)
          .filter((r) => r.right > r.left && r.bottom > r.top)
        return {
          popup: inner(popup),
          content: {
            top: Math.min(...rects.map((b) => b.top)),
            left: Math.min(...rects.map((b) => b.left)),
            bottom: Math.max(...rects.map((b) => b.bottom)),
            right: Math.max(...rects.map((b) => b.right)),
          },
        }
      })
      console.log(name, dialog, JSON.stringify(box))
      check(`${name}: the ${dialog} dialog clears the insets`, clears(box.popup, insets, viewport, TOP_SLACK))
      check(`${name}: the ${dialog} dialog's content clears every inset`, clears(box.content, insets, viewport))
      await page.screenshot({ path: `${SHOTS}/ios-safe-area-${name}-${dialog}.png` })
      await page.keyboard.press('Escape')
      await page.locator('[role="dialog"]').first().waitFor({ state: 'hidden', timeout: 5_000 })
    }
    await context.close()
  }
} finally {
  await browser.close()
}
finish()
