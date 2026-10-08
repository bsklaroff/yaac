/*
 * Verifies the desktop-only server UI in Chromium: the sidebar server chit
 * (ServerBadge.tsx) and Settings → Server (ServerSettings.tsx). Both render
 * only when the Electron preload's `window.yaacServer` bridge exists, so a
 * stub injected before load stands in for it (docs/server-selection.md).
 *
 *  1. No bridge (plain browser tab): no chit and no Server settings entry.
 *  2. With the bridge: the chit sits in the sidebar's status-chit row, shows
 *     the origin's host:port, and opens Settings → Server. The section lists
 *     every saved origin with the current one marked Connected and no
 *     "Local server" row. A failing switch shows its error inline, a good
 *     one shows "Reconnecting…", and the add form calls `addRemote`. Remove
 *     asks for confirmation, then drops the row in place; the Connected row
 *     offers no Remove.
 *  3. A long host fits the chit in a wide sidebar and truncates, without
 *     overflowing its row, in a narrow one.
 *  4. A bridge pasted after load (the devtools recipe for looking at the
 *     chit by hand) shows only after a re-render, such as toggling the
 *     sidebar: nothing subscribes to `window.yaacServer`.
 *
 * Run: node test-playwright-scripts/server-settings-desktop-test.js
 * Needs a running server (see lib.js). Screenshots: $SCREENSHOT_DIR/server-*.png.
 */
import path from 'node:path'
import { check, finish, origin, requirePlaywright, SHOTS } from './lib.js'

const CHIT = '[aria-label="Open server settings"]'
// MIN/MAX_SIDEBAR_WIDTH in packages/frontend/src/lib/store.ts.
const SIDEBAR_WIDTHS = [[640, true], [180, false]]

/** The bridge stub; `switchTo` fails for the loopback origin. */
const BRIDGE = () => {
  window.__bridgeCalls = []
  let saved = ['https://alpha.ts.net', 'https://beta.ts.net', 'http://127.0.0.1:8787']
  window.yaacServer = {
    targets: () => Promise.resolve({ current: 'https://alpha.ts.net', saved }),
    switchTo: (sel) => {
      window.__bridgeCalls.push(['switchTo', sel])
      return Promise.resolve(sel.url === 'http://127.0.0.1:8787'
        ? { ok: false, error: 'cannot reach http://127.0.0.1:8787 (scripted failure)' }
        : { ok: true })
    },
    addRemote: (url) => {
      window.__bridgeCalls.push(['addRemote', url])
      return Promise.resolve({ ok: true })
    },
    remove: (sel) => {
      window.__bridgeCalls.push(['remove', sel])
      saved = saved.filter((u) => u !== sel.url)
      return Promise.resolve({ ok: true })
    },
  }
}

const { chromium } = requirePlaywright()
const browser = await chromium.launch()

async function openApp({ bridge = false, sidebarWidth } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  if (bridge) await ctx.addInitScript(BRIDGE)
  if (sidebarWidth) {
    await ctx.addInitScript((px) => localStorage.setItem('yaac.sidebarwidth.v1', String(px)), sidebarWidth)
  }
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  await page.goto(`${origin}/`)
  await page.locator('aside').first().waitFor({ timeout: 15_000 })
  return page
}

const navLabels = (page) => page.evaluate(() =>
  [...document.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent.trim()))

try {
  // 1. Plain browser.
  {
    const page = await openApp()
    check('plain browser shows no server chit', await page.locator(CHIT).count() === 0)
    await page.getByTitle('Settings').first().click()
    await page.locator('button', { hasText: 'General' }).first().waitFor()
    check('plain browser settings nav has no Server entry', !(await navLabels(page)).includes('Server'))
    await page.close()
  }

  // 2. The chit and the Server section.
  {
    const page = await openApp({ bridge: true })
    const chit = page.locator(CHIT).first()
    check('desktop shell shows the server chit', await chit.isVisible())
    const host = new URL(origin).host
    check('chit names the origin host', (await chit.textContent()).trim() === host, await chit.textContent())
    check('chit tooltip carries the full origin', (await chit.getAttribute('title')).includes(origin))
    check('chit sits in the sidebar status-chit row',
      await chit.evaluate((el) => el.parentElement.className.includes('empty:hidden')))
    await page.locator('aside').first().screenshot({ path: path.join(SHOTS, 'server-badge-sidebar.png') })

    await chit.click()
    await page.getByText('Add a server').waitFor({ timeout: 10_000 })
    check('clicking the chit opens Settings → Server', true)
    const row = (url) => page.locator('div.rounded-md', { hasText: url }).last()
    check('current server marked Connected', (await row('https://alpha.ts.net').textContent()).includes('Connected'))
    check('no "Local server" row', await page.getByText('Local server').count() === 0)
    check('other saved server listed', await page.getByText('https://beta.ts.net', { exact: true }).isVisible())
    check('loopback server listed as an origin', await page.getByText('http://127.0.0.1:8787', { exact: true }).isVisible())
    await page.screenshot({ path: path.join(SHOTS, 'server-settings-desktop.png') })

    await row('http://127.0.0.1:8787').getByRole('button', { name: 'Connect' }).click()
    check('failed switch shows its error inline', await page
      .getByText('cannot reach http://127.0.0.1:8787 (scripted failure)')
      .waitFor({ timeout: 5_000 }).then(() => true, () => false))
    await row('https://beta.ts.net').getByRole('button', { name: 'Connect' }).click()
    check('successful switch shows Reconnecting…',
      await page.getByText('Reconnecting…').waitFor({ timeout: 5_000 }).then(() => true, () => false))
    const calls = await page.evaluate(() => window.__bridgeCalls)
    check('switchTo received the clicked selections', JSON.stringify(calls) === JSON.stringify([
      ['switchTo', { url: 'http://127.0.0.1:8787' }], ['switchTo', { url: 'https://beta.ts.net' }],
    ]), JSON.stringify(calls))
    await page.close()
  }
  {
    // A fresh page: the last switch left the previous one "Reconnecting…".
    const page = await openApp({ bridge: true })
    await page.locator(CHIT).first().click()
    const input = page.getByPlaceholder('https://host.ts.net')
    await input.fill('https://gamma.ts.net')
    await input.press('Enter')
    await page.getByText('Reconnecting…').waitFor({ timeout: 5_000 })
    const calls = await page.evaluate(() => window.__bridgeCalls)
    check('addRemote received the form value',
      JSON.stringify(calls) === JSON.stringify([['addRemote', 'https://gamma.ts.net']]), JSON.stringify(calls))
    await page.close()
  }

  {
    const page = await openApp({ bridge: true })
    await page.locator(CHIT).first().click()
    await page.getByText('Add a server').waitFor({ timeout: 10_000 })
    check('Connected row offers no Remove',
      await page.getByRole('button', { name: 'Remove https://alpha.ts.net' }).count() === 0)
    await page.getByRole('button', { name: 'Remove https://beta.ts.net' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click()
    check('removed row disappears', await page.getByText('https://beta.ts.net', { exact: true })
      .waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false))
    check('other rows stay', await page.getByText('http://127.0.0.1:8787', { exact: true }).isVisible())
    const calls = await page.evaluate(() => window.__bridgeCalls)
    check('remove received the clicked selection',
      JSON.stringify(calls) === JSON.stringify([['remove', { url: 'https://beta.ts.net' }]]), JSON.stringify(calls))
    await page.screenshot({ path: path.join(SHOTS, 'server-settings-remove.png') })
    await page.close()
  }

  // 3. Chit width: a long tailnet host swapped into the label is measured.
  for (const [width, shouldFit] of SIDEBAR_WIDTHS) {
    const page = await openApp({ bridge: true, sidebarWidth: width })
    const m = await page.locator(CHIT).first().evaluate((el) => {
      const span = el.querySelector('span')
      span.textContent = 'yaac-dev.tail9edf1.ts.net:8787'
      const row = el.parentElement.getBoundingClientRect()
      return {
        truncated: span.scrollWidth > span.clientWidth + 1,
        overflowsRow: el.getBoundingClientRect().right > row.right + 1,
      }
    })
    check(`long host ${shouldFit ? 'fits' : 'truncates'} at sidebar ${width}px`, m.truncated === !shouldFit)
    check(`chit stays inside its row at sidebar ${width}px`, !m.overflowsRow)
    await page.close()
  }

  // 4. The devtools recipe.
  {
    const page = await openApp()
    await page.evaluate(BRIDGE)
    check('a pasted bridge alone does not repaint the chit', await page.locator(CHIT).count() === 0)
    await page.getByLabel('Hide sidebar').first().click()
    await page.getByLabel('Show sidebar').first().click()
    check('the chit appears after toggling the sidebar',
      await page.locator(CHIT).first().waitFor({ timeout: 10_000 }).then(() => true, () => false))
    await page.close()
  }
} finally {
  await browser.close()
}
finish()
