/*
 * Verifies Claude and Codex sign-in from the webapp in a plain browser (as on
 * a phone, with no desktop app to catch a redirect), against a fake vendor:
 *
 *  1. Claude: the card links the vendor's authorize page; the code that page
 *     shows, pasted into the card, signs Claude in.
 *  2. Codex: the card shows a device code and its page, and signs Codex in
 *     once the (fake) vendor reports the code entered.
 *
 * The server talks to the fake vendor of
 * packages/test-utils/src/fake-vendor-oauth.ts, loaded through tsx, and the
 * script plays the user on the vendor's page by fetching the authorize URL.
 * It uses its own throwaway data dir and server, so it never touches your
 * install; export YAAC_SERVER_PORT to keep that server off the default port.
 *
 * Run (after `pnpm build`):
 *   node test-playwright-scripts/browser-tool-sign-in.js
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHOTS, check, finish, requirePlaywright } from './lib.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(REPO, 'dist', 'cli.js')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-browser-signin-'))
const CLIENT_DIR = `${DATA_DIR}-client`
const ENV = { ...process.env, YAAC_DATA_DIR: DATA_DIR }
let vendor
let browser

function yaac(...args) {
  return execFileSync('node', [CLI, ...args], { env: ENV, encoding: 'utf8' })
}

async function main() {
  if (!fs.existsSync(CLI)) throw new Error(`no ${CLI} — run \`pnpm build\``)
  const { chromium } = requirePlaywright()
  const { tsImport } = await import(path.join(REPO, 'node_modules', 'tsx', 'dist', 'esm', 'api', 'index.mjs'))
  const fake = await tsImport(path.join(REPO, 'packages', 'test-utils', 'src', 'fake-vendor-oauth.ts'), import.meta.url)
  vendor = await fake.startFakeVendorOAuth()
  ENV.YAAC_E2E_VENDOR_OAUTH_ORIGIN = vendor.origin

  yaac('server', 'start')
  const origin = JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, 'server.json'), 'utf8')).url
  console.log(`server at ${origin}`)

  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(origin)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Credentials' }).click()
  const row = (tool) => page.locator('div.rounded-md', { has: page.locator(`span:text-matches("^${tool}")`) }).first()

  console.log('\n1. Claude, with a pasted code')
  await row('claude').getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: 'Sign in with Claude' }).click()
  const link = page.getByRole('link', { name: 'the Claude sign-in page' })
  await link.waitFor()
  const url = await link.getAttribute('href')
  check('the card links the authorize page', url?.includes('/cai/oauth/authorize?'), url)
  check('it redirects to Claude\'s code page, not a loopback', new URL(url).searchParams.get('redirect_uri')
    === 'https://platform.claude.com/oauth/code/callback')
  const pasted = await (await fetch(url)).text()
  await page.getByPlaceholder('paste the code here').fill(pasted)
  await page.screenshot({ path: path.join(SHOTS, 'browser-sign-in-claude.png') })
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByText('Signed in successfully.').waitFor({ timeout: 15_000 })
  check('Claude is signed in', await row('claude').getByText('oauth').isVisible())

  console.log('\n2. Codex, with a device code')
  await row('codex').getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click()
  await page.getByText('FAKE-0001').waitFor()
  await page.screenshot({ path: path.join(SHOTS, 'browser-sign-in-codex.png') })
  check('the device code shows beside its page', await page.getByRole('link', { name: 'the ChatGPT sign-in page' }).isVisible())
  await row('codex').getByText('oauth').waitFor({ timeout: 15_000 })
  check('Codex is signed in', true)
  console.log(`screenshots in ${SHOTS}`)
}

main()
  .catch((err) => {
    console.error(`\nFAILED: ${err.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await browser?.close()
    try { yaac('server', 'stop') } catch { /* already stopped */ }
    await vendor?.close()
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
    fs.rmSync(CLIENT_DIR, { recursive: true, force: true })
    finish()
  })
