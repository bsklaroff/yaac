/*
 * Helpers shared by the scripts in this folder: loading Playwright, finding
 * the server, calling its API, and reporting checks.
 *
 * The server is the origin `server.json` selects (`<data dir>-client/`, data
 * dir from YAAC_DATA_DIR, default ~/.yaac), or APP_URL when set. No
 * credential is needed: the server trusts loopback callers. It serves the SPA
 * from the `dist/` it started with, so run `pnpm build` and `yaac server
 * restart` after changing the frontend.
 *
 * Playwright resolves from the global npm root, with a bare require fallback;
 * Chromium lives under /opt/playwright-browsers.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/playwright-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright-browsers'
}

export function requirePlaywright() {
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

export const DATA_DIR = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')

/*
 * Undefined when no server is registered, so scripts that drive no server
 * can still use the other helpers; `api` throws in that case.
 */
function selectedOrigin() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '')
  try {
    return JSON.parse(fs.readFileSync(`${DATA_DIR}-client/server.json`, 'utf8')).url?.replace(/\/$/, '')
  } catch {
    return undefined
  }
}

export const origin = selectedOrigin()

export const SHOTS = process.env.SCREENSHOT_DIR ?? '/tmp/yaac-shots'
fs.mkdirSync(SHOTS, { recursive: true })

/** Fetch `/api<route>` as JSON; throws on a non-2xx answer. */
export async function api(route, init = {}) {
  if (!origin) throw new Error(`no server in ${DATA_DIR}-client/server.json — try: yaac server start`)
  const res = await fetch(`${origin}/api${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.body !== undefined && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} /api${route}: HTTP ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

/**
 * Create a workspace and wait for its provisioning stream to finish; returns
 * the new workspace's id. `body` is the `/api/workspace/create` request.
 */
export async function createWorkspace(body) {
  const res = await fetch(`${origin}/api/workspace/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const last = (await res.text()).trim().split('\n').map((l) => JSON.parse(l)).at(-1)
  if (last?.type !== 'result') throw new Error(`create failed: ${JSON.stringify(last)}`)
  return last.result.workspaceId
}

/**
 * Create several workspaces at once, returning their ids in order. If any
 * create fails, stops the ones that succeeded before throwing, so a failed
 * setup leaves nothing running.
 */
export async function createWorkspaces(bodies) {
  const settled = await Promise.allSettled(bodies.map(createWorkspace))
  const failed = settled.find((r) => r.status === 'rejected')
  if (!failed) return settled.map((r) => r.value)
  await Promise.allSettled(settled.filter((r) => r.status === 'fulfilled')
    .map((r) => api('/workspace/stop', { method: 'POST', body: { workspaceId: r.value } })))
  throw failed.reason
}

/**
 * Poll an in-page predicate until it holds. Not `page.waitForFunction`,
 * which needs `unsafe-eval` and the app's CSP forbids it.
 */
export async function until(page, fn, arg, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await page.evaluate(fn, arg)) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${fn.name || 'condition'}`)
    await page.waitForTimeout(250)
  }
}

let failures = 0

export function check(name, cond, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

/** Print the tally and exit non-zero if any check failed or exitCode is set. */
export function finish() {
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 && !process.exitCode ? 0 : 1)
}
