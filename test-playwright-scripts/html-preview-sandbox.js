/*
 * Verifies, in real Chromium, the browser behavior the file pane's static
 * HTML preview (`HtmlDocument`, docs/file-editor.md "Previews") relies on,
 * without a yaac server: a page served under the SPA's own CSP (`spaCsp`)
 * holds an iframe sandboxed as the preview's, whose srcdoc is shaped as
 * `staticDocument` makes it. Checks that:
 *   1. Inline `<style>`, a `style` attribute and a `data:` image render.
 *   2. No script runs: neither a `<script>` left in, nor an inline handler.
 *   3. A remote image is never requested: the preview's CSP meta refuses it.
 *   4. A heading link rewritten to `about:srcdoc#…` scrolls within the
 *      iframe instead of navigating it away.
 *   5. A `target="_blank"` link opens a popup outside the sandbox.
 *
 * Run: node test-playwright-scripts/html-preview-sandbox.js
 */
import http from 'node:http'
import { requirePlaywright, check, finish } from './lib.js'

const { chromium } = requirePlaywright()

const SPA_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'self'; frame-ancestors 'none'"
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
const DOT = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')

const srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
<style>p { color: rgb(255, 0, 0) }</style></head><body>
<a id="jump" href="about:srcdoc#bottom">jump</a> <a id="out" href="https://example.com/" target="_blank">out</a>
<p id="styled">styled</p><div id="attr" style="width: 77px">attr</div>
<img id="dot" src="${DOT}"><img id="remote" src="https://example.com/x.png">
<script>document.body.dataset.ran = 'script'</script>
<img src="x:" onerror="document.body.dataset.ran = 'handler'">
<div style="height: 3000px"></div><h2 id="bottom">bottom</h2></body></html>`

const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', SPA_CSP)
  res.setHeader('Content-Type', 'text/html')
  res.end('<!doctype html><body><iframe id="f" sandbox="allow-popups allow-popups-to-escape-sandbox" '
    + `style="width: 600px; height: 400px" srcdoc="${srcdoc.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch()
const context = await browser.newContext()
const requested = []
await context.route('https://example.com/**', (route) => {
  requested.push(route.request().url())
  return route.fulfill({ body: 'ok' })
})
const page = await context.newPage()
await page.goto(url)
const frame = page.frameLocator('#f')
await frame.locator('#bottom').waitFor({ state: 'attached' })
const inner = page.frames().find((f) => f !== page.mainFrame())

check('inline <style> applies', await frame.locator('#styled').evaluate((el) => getComputedStyle(el).color) === 'rgb(255, 0, 0)')
check('style attribute applies', await frame.locator('#attr').evaluate((el) => getComputedStyle(el).width) === '77px')
check('data: image loads', await frame.locator('#dot').evaluate((el) => el.naturalWidth) === 10)
check('remote image is never requested', !requested.includes('https://example.com/x.png'), requested.join(' '))
check('no script or handler runs', await frame.locator('body').getAttribute('data-ran') === null)

await frame.locator('#jump').click()
await page.waitForTimeout(300)
check('heading link stays in the srcdoc', inner.url().startsWith('about:srcdoc'))
check('heading link scrolls to the heading', await frame.locator('#bottom').evaluate((el) => {
  const r = el.getBoundingClientRect()
  return r.top >= 0 && r.top < innerHeight
}))

const [popup] = await Promise.all([context.waitForEvent('page'), frame.locator('#out').click()])
await popup.waitForLoadState()
check('target=_blank opens a popup', popup.url() === 'https://example.com/')

await browser.close()
server.close()
finish()
