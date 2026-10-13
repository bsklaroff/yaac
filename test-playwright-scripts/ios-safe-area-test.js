/*
 * Verifies the webapp pads its chrome by non-zero `env(safe-area-inset-*)`,
 * as the iPhone app's web view reports them (ios/README.md "Layout"): an
 * iPhone 14 portrait (390x844, top 47 / bottom 34) and landscape (844x390,
 * left/right 47, bottom 21). Insets are injected with CDP's
 * Emulation.setSafeAreaInsetsOverride, so `env()` itself resolves non-zero;
 * nothing in the page is patched. Checks that the visible content stays
 * inside the safe area, the shell's own children included (the phone shell's
 * absolutely positioned screens), and that the env() values reached the page.
 * Screenshots go to $SCREENSHOT_DIR (default /tmp/yaac-shots).
 *
 * Needs a running server (see lib.js):
 *   node test-playwright-scripts/ios-safe-area-test.js
 */
import { SHOTS, check, finish, origin, requirePlaywright } from './lib.js'

const { chromium } = requirePlaywright()

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
      /* The shell's children and every visible, non-empty leaf box. */
      const boxes = [...document.querySelectorAll('.safe-area-inset > *, #root button, #root a, #root input, #root textarea, #root h1, #root h2, #root span, #root svg')]
        .filter((e) => {
          const st = getComputedStyle(e)
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && !e.closest('[inert]')
        })
        .map((e) => e.getBoundingClientRect())
      return {
        env,
        shellInset: ss && { top: ss.borderTopWidth, right: ss.borderRightWidth, bottom: ss.borderBottomWidth, left: ss.borderLeftWidth },
        extent: {
          top: Math.min(...boxes.map((r) => r.top)),
          left: Math.min(...boxes.map((r) => r.left)),
          bottom: Math.max(...boxes.map((r) => r.bottom)),
          right: Math.max(...boxes.map((r) => r.right)),
        },
      }
    })
    console.log(name, JSON.stringify(probe))
    check(`${name}: env() reports the injected insets`,
      probe.env.top === `${insets.top}px` && probe.env.left === `${insets.left}px` && probe.env.bottom === `${insets.bottom}px`)
    check(`${name}: content clears the top inset`, probe.extent.top >= insets.top)
    check(`${name}: content clears the left inset`, probe.extent.left >= insets.left)
    check(`${name}: content clears the right inset`, probe.extent.right <= viewport.width - insets.right)
    check(`${name}: content clears the bottom inset`, probe.extent.bottom <= viewport.height - insets.bottom)
    await page.screenshot({ path: `${SHOTS}/ios-safe-area-${name}.png` })
    await context.close()
  }
} finally {
  await browser.close()
}
finish()
