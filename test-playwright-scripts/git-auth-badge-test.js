/*
 * Verifies the git-auth-failure badge end-to-end against the real stack:
 * the proxy's 401 detection (k8s/proxy/proxy.ts noteGitUpstreamStatus,
 * recorded against the session's PROJECT), the daemon snapshot plumbing
 * (DaemonSnapshot.gitAuthFailures, keyed by project slug), and the webapp
 * badge (GitAuthFailureBadge in the sidebar's project header + session
 * header).
 *
 * Flow, all against a running daemon + cluster and a REAL session pod:
 *   1. finds (or requires) an existing running session for --project
 *   2. deploys an in-cluster mock upstream (401 for every git smart-HTTP
 *      path until flipped, then 200) and re-registers the session with the
 *      proxy so github.com's post-MITM upstream is redirected to the mock —
 *      credential injection and detection still run exactly as in production
 *      (same mechanism the e2e suite uses, see sessionUpstreamRedirects)
 *   3. asserts the UI shows no badge, then runs `git fetch` inside the
 *      session pod (fails with 401) and waits for the badge to appear in
 *      the sidebar and header, and for the popover to name the host,
 *      status, and `yaac auth update`
 *   4. flips the mock to 200, re-runs `git fetch`, and waits for the badge
 *      to self-clear
 *   5. cleans up: removes the upstream redirect and the mock pod/service
 *
 * Run: node test-playwright-scripts/git-auth-badge-test.js [--project yaac]
 * Needs a running daemon with a wired cluster and ONE running session for
 * the project (create one first: `yaac session create <project>`). Reads
 * port/secret from $YAAC_DATA_DIR/.daemon.lock (or ~/.yaac). Screenshots go
 * to $TMPDIR. (playwright is resolved from the global npm root; browsers
 * live under /opt/playwright-browsers)
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

function readDaemonLock() {
  const candidates = [
    process.env.YAAC_DATA_DIR && path.join(process.env.YAAC_DATA_DIR, '.daemon.lock'),
    path.join(os.homedir(), '.yaac', '.daemon.lock'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  throw new Error(`no .daemon.lock found (tried ${candidates.join(', ')}) — is the daemon running?`)
}

const PROJECT = process.argv.includes('--project')
  ? process.argv[process.argv.indexOf('--project') + 1]
  : 'yaac'
const NS = process.env.YAAC_K8S_NAMESPACE || 'yaac'
const MOCK_NAME = 'yaac-git-auth-badge-mock'
const MOCK_PORT = 8080
const BADGE = '[aria-label="Git authentication failed"]'

function kubectl(args, opts = {}) {
  return execFileSync('kubectl', ['-n', NS, ...args], { encoding: 'utf8', ...opts })
}

let failures = 0
function check(name, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`)
}

/** The same image the session base uses — it has node for the mock server. */
function resolveMockImage() {
  const pods = JSON.parse(kubectl(['get', 'pods', '-o', 'json']))
  for (const p of pods.items) {
    for (const c of p.spec.containers) {
      if (p.metadata.labels?.['yaac.session-id']) return c.image
    }
  }
  throw new Error('no running session pod to borrow an image from')
}

/**
 * Mock github upstream: 401 on everything until /__mode/ok flips it to 200.
 * The proxy only records failures on git smart-HTTP paths, so the always-401
 * default also exercises "non-git 401s are ignored" implicitly (gh API noise
 * from the live agent hits the real upstream, not this mock).
 */
async function deployMock(image) {
  const script = `
    let ok = false;
    require('http').createServer((req, res) => {
      if (req.url.startsWith('/__mode/')) {
        ok = req.url.endsWith('/ok');
        res.writeHead(200); res.end('mode=' + (ok ? 'ok' : '401')); return;
      }
      res.writeHead(ok ? 200 : 401, { 'content-type': 'text/plain' });
      res.end(ok ? 'ok' : 'Bad credentials');
    }).listen(${MOCK_PORT}, '0.0.0.0', () => console.log('mock ready'));
  `
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: MOCK_NAME, namespace: NS, labels: { app: MOCK_NAME, 'yaac.test': 'true' } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [{
        name: 'mock', image, imagePullPolicy: 'IfNotPresent',
        command: ['node', '-e', script],
        ports: [{ containerPort: MOCK_PORT }],
      }],
    },
  }
  const svc = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: MOCK_NAME, namespace: NS, labels: { 'yaac.test': 'true' } },
    spec: {
      type: 'ClusterIP',
      selector: { app: MOCK_NAME },
      ports: [{ name: 'http', port: MOCK_PORT, targetPort: MOCK_PORT }],
    },
  }
  // Pod specs are immutable — clear any leftover from a previous run first.
  kubectl(['delete', 'pod', MOCK_NAME, '--ignore-not-found', '--grace-period=1', '--wait=true'])
  for (const obj of [pod, svc]) {
    kubectl(['apply', '-f', '-'], { input: JSON.stringify(obj) })
  }
  for (let i = 0; i < 120; i++) {
    const phase = kubectl(['get', 'pod', MOCK_NAME, '-o', 'jsonpath={.status.phase}'])
    if (phase === 'Running') {
      // Redirect by ClusterIP, not DNS name: in a nested yaac the proxy's
      // resolver chains to the outer proxy's DNS stub, which sinkholes
      // inner-cluster service names (they resolve to 198.18.0.1 and the
      // upstream dial blackholes). The ClusterIP works in both layouts.
      return kubectl(['get', 'service', MOCK_NAME, '-o', 'jsonpath={.spec.clusterIP}'])
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('mock pod never reached Running')
}

function setMockMode(mode) {
  kubectl(['exec', MOCK_NAME, '--', 'node', '-e',
    `require('http').get('http://127.0.0.1:${MOCK_PORT}/__mode/${mode}', (r) => process.exit(r.statusCode === 200 ? 0 : 1))`])
}

/**
 * Re-register the session with the proxy, preserving its live registration
 * from the proxy's own write-through file and only changing
 * upstreamRedirects. Talks to the proxy API through a short-lived
 * `kubectl port-forward`.
 */
async function setUpstreamRedirect(sessionId, redirects) {
  const stateFile = path.join(
    process.env.YAAC_DATA_DIR || path.join(os.homedir(), '.yaac'),
    'run', 'proxy-data', 'sessions.json',
  )
  const registration = JSON.parse(fs.readFileSync(stateFile, 'utf8'))[sessionId]
  if (!registration) throw new Error(`session ${sessionId} not in proxy sessions.json`)

  const secret = Buffer.from(
    kubectl(['get', 'secret', 'yaac-proxy-auth', '-o', 'jsonpath={.data.secret}']),
    'base64',
  ).toString('utf8')

  const { spawn } = await import('node:child_process')
  const pf = spawn('kubectl', ['-n', NS, 'port-forward', 'svc/yaac-proxy', '0:10255'])
  try {
    const localPort = await new Promise((resolve, reject) => {
      pf.stdout.on('data', (c) => {
        const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(c.toString())
        if (m) resolve(Number(m[1]))
      })
      pf.on('exit', () => reject(new Error('port-forward exited')))
      setTimeout(() => reject(new Error('port-forward timeout')), 15_000)
    })
    const res = await fetch(`http://127.0.0.1:${localPort}/sessions/${sessionId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...registration, upstreamRedirects: redirects }),
    })
    if (!res.ok) throw new Error(`proxy registration PUT failed: HTTP ${res.status}`)
  } finally {
    pf.kill()
  }
}

function gitFetchInPod(podName) {
  try {
    execFileSync('kubectl', [
      '-n', NS, 'exec', podName, '--',
      'env', 'GIT_TERMINAL_PROMPT=0', 'git', '-C', '/workspace', 'fetch', 'origin',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
    return { ok: true, err: '' }
  } catch (e) {
    return { ok: false, err: (e.stderr || String(e)).trim().split('\n').slice(-2).join(' | ') }
  }
}

async function main() {
  const { chromium } = requirePlaywright()
  const lock = readDaemonLock()
  const base = `http://127.0.0.1:${lock.port}`
  const auth = { authorization: `Bearer ${lock.secret}` }
  const shotDir = process.env.TMPDIR || os.tmpdir()

  // The one running session for the project — its pod is where git runs.
  const list = await (await fetch(`${base}/session/list?project=${PROJECT}`, { headers: auth })).json()
  const session = list.sessions[0]
  if (!session) throw new Error(`no running session for project "${PROJECT}" — create one first`)
  const sessionId = session.sessionId
  const podName = kubectl(['get', 'pods', '-l', `yaac.session-id=${sessionId}`,
    '-o', 'jsonpath={.items[0].metadata.name}'])
  console.log(`session ${sessionId.slice(0, 8)} pod ${podName}`)

  // Deterministic sidebar row text (rows show title || prompt || 'New
  // session', and the "+ New session" button would collide with the
  // untitled fallback).
  const TITLE = 'GIT-AUTH-E2E'
  await fetch(`${base}/session/${sessionId}/title`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ title: TITLE }),
  })

  const mockHost = await deployMock(resolveMockImage())
  console.log(`mock upstream at ${mockHost}:${MOCK_PORT}`)
  await setUpstreamRedirect(sessionId, {
    'github.com': { host: mockHost, port: MOCK_PORT, tls: false },
  })
  console.log('github.com upstream redirected to mock (mode=401)')

  const codeRes = await fetch(`${base}/auth/bootstrap-code`, { headers: auth })
  const { code } = await codeRes.json()

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, bypassCSP: true })
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`))

  try {
    await page.goto(`${base}/?bootstrap=${code}`)
    await page.waitForSelector('[title="New session"]', { timeout: 15_000 })
    await page.waitForTimeout(1500)

    check('no badge before the failure', await page.locator(BADGE).count() === 0)

    const fail = gitFetchInPod(podName)
    check('git fetch in the pod fails against the 401 upstream', !fail.ok, fail.err)

    // Project-header badge: pushed via the snapshot WebSocket, no reload
    // needed. Project-wide, so it sits in the sidebar header, not on rows.
    await page.waitForSelector(BADGE, { timeout: 60_000 })
    check('badge appears in the sidebar project header', await page.locator(BADGE).count() >= 1)
    await page.screenshot({ path: path.join(shotDir, 'git-auth-badge-sidebar.png') })

    // Open the session: the header badge renders next to the tool label.
    await page.getByText(TITLE, { exact: true }).first().click()
    await page.waitForSelector('header ' + BADGE, { timeout: 15_000 })
    check('badge appears in the session header',
      await page.locator('header ' + BADGE).count() === 1)

    // Popover: host, status, and the fix.
    await page.locator('header ' + BADGE).first().click()
    await page.waitForSelector('text=github.com — HTTP 401', { timeout: 5_000 })
    check('popover names the host and status',
      await page.locator('text=github.com — HTTP 401').count() >= 1)
    check('popover tells the user to run yaac auth update',
      await page.locator('text=yaac auth update').count() >= 1)
    await page.screenshot({ path: path.join(shotDir, 'git-auth-badge-popover.png') })
    await page.keyboard.press('Escape')

    // Recovery: token "fixed" (mock now accepts), next git op clears the flag.
    setMockMode('ok')
    const okFetch = gitFetchInPod(podName)
    console.log(`recovery git fetch ok=${okFetch.ok} (${okFetch.err || 'proxy saw 2xx'})`)
    await page.waitForSelector(BADGE, { state: 'detached', timeout: 60_000 })
    check('badge self-clears after a successful git request', await page.locator(BADGE).count() === 0)
    await page.screenshot({ path: path.join(shotDir, 'git-auth-badge-cleared.png') })
    console.log(`screenshots in ${shotDir}/git-auth-badge-*.png`)
  } finally {
    await browser.close()
    try {
      await setUpstreamRedirect(sessionId, undefined)
      console.log('cleanup: upstream redirect removed')
    } catch (e) {
      console.log(`cleanup: failed to remove redirect — ${e.message}`)
    }
    try {
      kubectl(['delete', 'pod', MOCK_NAME, '--ignore-not-found', '--grace-period=1'])
      kubectl(['delete', 'service', MOCK_NAME, '--ignore-not-found'])
      console.log('cleanup: mock pod/service deleted')
    } catch (e) {
      console.log(`cleanup: mock deletion failed — ${e.message}`)
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
