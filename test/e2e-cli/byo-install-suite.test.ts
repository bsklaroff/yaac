import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import tls from 'node:tls'
import path from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { TEST_CLI_ENTRY, runYaac } from '@yaac/test-utils/cli'
import { startKubectlForward, type KubectlForward } from '@yaac/test-utils/kubectl-forward'
import { kindByoLayout } from '@yaac/test-utils/kind-byo-layout'
import { e2eMkdtemp, removeScratchTree } from '@yaac/test-utils/tmp'
import { SERVER_POD_PORT } from '@yaac/server/drivers/k8s/substrate'

const execFileAsync = promisify(execFile)

/**
 * `yaac cluster install --byo`, end to end, against the install `pnpm
 * kind-byo up` made (docs/cluster-setup.md "Running byo locally:
 * kind-byo"). It tests that installed server, not a per-file one: its
 * claims, its uid, its tailnet Ingress, the operator commands, and what
 * survives a namespace delete.
 *
 * There are two clients. The operator uses the install's own data dir and
 * kubeconfig, which the host-side commands (`server stop|start|restart|logs`,
 * `cluster check|delete|install`) read. The user goes through the API. The
 * https origin identifies callers by tailnet user and this machine is a
 * tagged device, so the origin refuses `/whoami` here. User actions
 * therefore go through a loopback port-forward to the server's Service,
 * where loopback counts as the owner.
 *
 * One install serves the file. The last case deletes the namespace and
 * re-installs, so it runs last.
 *
 * The namespace delete removes the Ingress, so its proxy requests a new
 * certificate. kind-byo uses Let's Encrypt staging (production allows five
 * a week per name), so the suite trusts the staging roots, both in this
 * process and via `NODE_EXTRA_CA_CERTS` in every CLI it spawns.
 */
const INSTALL_TIMEOUT = 30 * 60_000
/** `pnpm kind-byo up`'s install flags: its NFS class, and its NAMED block class. */
const BYO_INSTALL = ['--byo', '--rwx-storage-class', 'kind-byo-nfs', '--rwo-storage-class', 'kind-byo-rwo']
/**
 * A small public repository. It is added with the fake GitHub credential,
 * which a public fetch never presents: nothing challenges it.
 */
const REPO_URL = 'https://github.com/octocat/Hello-World.git'
const SLUG = 'hello-world'

const layout = kindByoLayout()
let origin: string
let operatorEnv: NodeJS.ProcessEnv
let userEnv: NodeJS.ProcessEnv
let forward: KubectlForward
let scratch: string
let workspaceId = ''
const children: ChildProcess[] = []

/** The install namespace, `yaac`. */
function installEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, KUBECONFIG: layout.kubeconfig }
  delete env.YAAC_K8S_NAMESPACE
  delete env.YAAC_IMAGE_PREFIX
  return env
}

async function kubectl(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('kubectl', args, { env: operatorEnv, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

interface InstallJson { url: string; installId?: string; clusterUid?: string; kubeContext?: string; byo?: boolean }

async function readServerJson(): Promise<InstallJson> {
  return JSON.parse(await fs.readFile(path.join(layout.clientDir, 'server.json'), 'utf8')) as InstallJson
}

/** The installed server, reached as its owner through a loopback forward. */
async function api(route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${forward.origin}/api${route}`, init)
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cond().catch(() => false)) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

async function claimVolumes(): Promise<Record<string, string>> {
  const out = await kubectl('get', 'pvc', '-n', 'yaac', '-o',
    'jsonpath={range .items[*]}{.metadata.name}={.spec.volumeName}{"\\n"}{end}')
  return Object.fromEntries(out.trim().split('\n').filter(Boolean)
    .map((l) => l.split('=') as [string, string])) as Record<string, string>
}

beforeAll(async () => {
  // This worker started before the env named the staging roots, so add
  // them to its own trust store.
  const staging = (await fs.readFile(layout.stagingCa, 'utf8'))
    .split(/(?<=-----END CERTIFICATE-----)\s*/).filter((pem) => pem.includes('BEGIN'))
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...staging])
  const record = await readServerJson().catch(() => null)
  if (!record?.byo) {
    throw new Error(`${layout.dataDir} holds no --byo install. Run \`pnpm kind-byo up\` first.`)
  }
  origin = record.url
  scratch = await e2eMkdtemp('byo-install-suite-')
  operatorEnv = installEnv({ YAAC_DATA_DIR: layout.dataDir })
  // No TTY here, so `workspace create` must not attach after provisioning.
  userEnv = installEnv({ YAAC_DATA_DIR: path.join(scratch, 'user'), YAAC_E2E_NO_ATTACH: '1' })
  forward = await startKubectlForward({ namespace: 'yaac', target: 'svc/yaac-server', remotePort: SERVER_POD_PORT })
  await waitFor('the loopback forward', async () => (await api('/health')).ok)
}, 120_000)

afterAll(async () => {
  for (const child of children) child.kill('SIGTERM')
  await forward?.stop()
  if (scratch) await removeScratchTree(scratch)
})

describe('yaac cluster install --byo, on kind-byo', () => {
  it('publishes the server at an https tailnet origin whose Ingress identifies every caller', async () => {
    expect(origin).toMatch(/^https:\/\/[^/]+\.ts\.net$/)
    const health = await fetch(`${origin}/api/health`)
    expect(health.ok).toBe(true)
    expect(await health.json()).toMatchObject({ ready: true, driver: 'k8s' })
    // ...on a staging certificate.
    const issuer = await new Promise<string>((resolve, reject) => {
      const host = new URL(origin).hostname
      const socket = tls.connect({ host, port: 443, servername: host }, () => {
        // Staging intermediates keep production's organization and mark
        // their common name: `(STAGING) Artificial Amaranth YE1`.
        resolve(String(socket.getPeerCertificate().issuer.CN ?? ''))
        socket.end()
      })
      socket.once('error', reject)
    })
    expect(issuer).toMatch(/^\(STAGING\)/)

    // This machine is a tagged tailnet device, so the Ingress sends no user
    // and the server refuses to identify the caller.
    const whoami = await fetch(`${origin}/api/whoami`)
    expect(whoami.status).toBe(401)
    expect(await whoami.text()).toMatch(/tagged device/)

    // ...which `yaac remote set` reports in the server's own words.
    const set = await runYaac(installEnv({ YAAC_DATA_DIR: path.join(scratch, 'tagged') }), 'remote', 'set', origin)
    expect(set.exitCode).toBe(1)
    expect(set.stderr).toMatch(/refused to identify this device[\s\S]*tagged device/)

    // Recorded as a byo install, keyed by the cluster's uid; the context
    // is only a hint.
    const record = await readServerJson()
    expect(record).toMatchObject({ byo: true, kubeContext: 'kind-yaac-byo' })
    expect(record.clusterUid).toBe((await kubectl('get', 'namespace', 'kube-system', '-o', 'jsonpath={.metadata.uid}')).trim())
    expect(record.installId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('runs the server at the byo uid, on claims provisioned from the named classes', async () => {
    const { installId } = await readServerJson()
    const dep = JSON.parse(await kubectl('get', 'deployment', 'yaac-server', '-n', 'yaac', '-o', 'json')) as {
      metadata: { labels: Record<string, string> }
      spec: { template: { spec: { securityContext: { runAsUser: number; runAsGroup: number } } } }
    }
    expect(dep.spec.template.spec.securityContext).toMatchObject({ runAsUser: 1000, runAsGroup: 1000 })
    expect(dep.metadata.labels['yaac.install-id']).toBe(installId)

    const volumes = await claimVolumes()
    const pv = JSON.parse(await kubectl('get', 'pv', volumes['yaac-global'], '-o', 'json')) as {
      metadata: { labels: Record<string, string> }
      spec: { storageClassName: string; persistentVolumeReclaimPolicy: string; mountOptions: string[] }
    }
    // The operator's class said Delete and set no actimeo; install pinned both.
    expect(pv.spec).toMatchObject({ storageClassName: 'kind-byo-nfs', persistentVolumeReclaimPolicy: 'Retain' })
    // The block claim went through the class named, not the default one.
    expect((await kubectl('get', 'pvc', 'yaac-server-local', '-n', 'yaac', '-o', 'jsonpath={.spec.storageClassName}')).trim())
      .toBe('kind-byo-rwo')
    expect(pv.spec.mountOptions).toEqual(expect.arrayContaining(['actimeo=1']))
    expect(pv.metadata.labels).toMatchObject({ 'yaac.claim': 'yaac-global', 'yaac.install-id': installId })

    // One directory per claim where kind-byo's classes put them, marked
    // for this install and owned by the install uid.
    for (const claim of ['yaac-global', 'yaac-server-local']) {
      const root = path.join(layout.dataDir, 'volumes', 'yaac', claim)
      expect((await fs.stat(root)).uid).toBe(1000)
      expect(await fs.readFile(path.join(root, '.yaac-install'), 'utf8')).toBe(installId)
    }
  })

  it('creates a workspace through the installed server, with a terminal and a forward that work', async () => {
    expect((await runYaac(userEnv, 'remote', 'set', forward.origin)).exitCode).toBe(0)
    // The install's volumes are Retain, so a project from an earlier run
    // may still exist.
    const gone = await api(`/project/${SLUG}`, { method: 'DELETE' })
    expect([204, 404]).toContain(gone.status)
    for (const args of [
      ['config', 'git-identity', '--name', 'Yaac Test', '--email', 'test@example.com'],
      ['auth', 'fake', 'claude-oauth', 'github'],
      ['project', 'add', REPO_URL, 'fake-github'],
    ]) {
      const res = await runYaac(userEnv, ...args)
      expect(res.exitCode, `${args.join(' ')}: ${res.stderr}`).toBe(0)
    }
    // With a loopback origin, `workspace create` checks for the project on
    // this machine's disk, as it would for a kind install. A byo user comes
    // in over https and never hits that check, so fake the directory.
    await fs.mkdir(path.join(scratch, 'user', 'global', 'projects', SLUG), { recursive: true })
    const created = await runYaac(userEnv, 'workspace', 'create', SLUG, '--tool', 'claude')
    expect(created.exitCode, created.stderr).toBe(0)
    workspaceId = (await kubectl('get', 'pods', '-n', 'yaac', '-l', `yaac.project=${SLUG}`,
      '-o', 'jsonpath={.items[0].metadata.labels.yaac\\.workspace-id}')).trim()
    expect(workspaceId).not.toBe('')
    const pod = (await kubectl('get', 'pods', '-n', 'yaac', '-l', `yaac.workspace-id=${workspaceId}`,
      '-o', 'jsonpath={.items[0].metadata.name}')).trim()

    const term = await (await api(`/workspace/${workspaceId}/terminals`, { method: 'POST' })).json() as { target: string }
    const ws = new WebSocket(`${forward.origin.replace('http', 'ws')}/api/pty/attach`
      + `?id=${workspaceId}&target=${encodeURIComponent(term.target)}&cols=100&rows=30`)
    let screen = ''
    ws.on('message', (data) => { screen += Buffer.from(data as Buffer).toString('utf8') })
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    await new Promise((r) => setTimeout(r, 3_000))
    ws.send(Buffer.from('echo BYO_$((40 + 2))\r'))
    await waitFor('the terminal echo', () => Promise.resolve(screen.includes('BYO_42')), 30_000)
    ws.close()

    const port = 18_761
    await execFileAsync('kubectl', ['exec', '-n', 'yaac', pod, '-c', 'workspace', '--', 'sh', '-c',
      `nohup node -e "require('http').createServer((q, r) => r.end('byo-forward')).listen(${String(port)}, '127.0.0.1')" >/dev/null 2>&1 &`],
    { env: operatorEnv })
    const fwd = spawn(process.execPath, [TEST_CLI_ENTRY, 'forward', workspaceId], { env: userEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(fwd)
    // The forwarder's output is the only record of why the server closed
    // a tunnel.
    let fwdOutput = ''
    fwd.stdout.on('data', (b: Buffer) => { fwdOutput += b.toString() })
    fwd.stderr.on('data', (b: Buffer) => { fwdOutput += b.toString() })
    let mapping: { hostPort: number } | undefined
    await waitFor('the detected port to be offered', async () => {
      const res = await api(`/workspace/${workspaceId}/forward-port`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: port }),
      })
      if (res.ok) mapping = await res.json() as { hostPort: number }
      return res.ok
    }, 90_000)
    // Wait for this forwarder's listener, not just any listener: an
    // orphaned forwarder from an earlier run could hold the port.
    const bound = `forwarding 127.0.0.1:${String(mapping!.hostPort)} `
    await waitFor('this suite\'s forwarder to bind the port', () =>
      Promise.resolve(fwdOutput.includes(bound) || /cannot bind port/.test(fwdOutput)))
    expect(fwdOutput, 'yaac forward output').toContain(bound)
    const body = await fetch(`http://127.0.0.1:${String(mapping!.hostPort)}/`).then((r) => r.text()).catch(async (err: unknown) => {
      const serverLog = (await runYaac(operatorEnv, 'server', 'logs', '-n', '400')).stdout
      throw new Error(`the forwarded fetch failed (${String(err)})\n--- yaac forward:\n${fwdOutput}`
        + `\n--- server log (forward lines):\n${serverLog.split('\n').filter((l) => /forward|tunnel|relay|attach/i.test(l)).join('\n')}`)
    })
    expect(body).toBe('byo-forward')
  }, INSTALL_TIMEOUT)

  it('server stop|start|restart|logs act on the installed Deployment and answer at the origin', async () => {
    const stop = await runYaac(operatorEnv, 'server', 'stop')
    expect(stop.exitCode, stop.stderr).toBe(0)
    expect((await kubectl('get', 'deployment', 'yaac-server', '-n', 'yaac', '-o', 'jsonpath={.spec.replicas}')).trim()).toBe('0')
    // With the server stopped, the log is read through a temporary reader
    // pod, since a cloud install's claim is not visible from this machine.
    const stopped = await runYaac(operatorEnv, 'server', 'logs', '-n', '5')
    expect(stopped.exitCode, stopped.stderr).toBe(0)
    expect(stopped.stdout.split('\n').filter(Boolean).length).toBe(5)
    await waitFor('the log reader to go', async () =>
      !(await kubectl('get', 'pod', 'yaac-server-log-reader', '-n', 'yaac', '--ignore-not-found', '-o', 'name')).trim())
    const start = await runYaac(operatorEnv, 'server', 'start')
    expect(start.exitCode, start.stderr).toBe(0)
    expect(start.stderr).toContain(`started at ${origin}`)
    const restart = await runYaac(operatorEnv, 'server', 'restart')
    expect(restart.exitCode, restart.stderr).toBe(0)
    expect(restart.stderr).toContain(`restarted at ${origin}`)
    // ...and through the server pod itself while it runs.
    const logs = await runYaac(operatorEnv, 'server', 'logs', '-n', '5')
    expect(logs.exitCode, logs.stderr).toBe(0)
    expect(logs.stdout.split('\n').filter(Boolean).length).toBe(5)
  }, INSTALL_TIMEOUT)

  it('cluster check is green, fail-level storage gates included', async () => {
    const check = await runYaac(operatorEnv, 'cluster', 'check')
    expect(check.exitCode, check.stdout + check.stderr).toBe(0)
    expect(check.stdout).toMatch(/✓ storage: yaac-global → \S+ \(kind-byo-nfs\)/)
    expect(check.stdout).toMatch(/✓ storage-semantics:/)
    expect(check.stdout).toMatch(/✓ probe: .*cross-node round trip/)
    expect(check.stdout).toMatch(/- node-fixups: a byo install/)
  }, INSTALL_TIMEOUT)

  it('cluster delete refuses, printing the uninstall instead', async () => {
    const del = await runYaac(operatorEnv, 'cluster', 'delete', '--yes')
    expect(del.exitCode).toBe(1)
    expect(del.stderr).toMatch(/the cluster is not yaac's to delete/)
    const { installId } = await readServerJson()
    expect(del.stderr).toContain(`kubectl delete pv -l yaac.install-id=${installId}`)
    expect(del.stderr).toMatch(/kubectl delete namespace yaac yaac-registry-keys/)
    expect(del.stderr).toMatch(/kubectl label nodes --all yaac\.gvisor- yaac\.gvisor-version-/)
    expect((await kubectl('get', 'deployment', 'yaac-server', '-n', 'yaac', '-o', 'name')).trim())
      .toBe('deployment.apps/yaac-server')
  })

  it('a re-install converges in place, on the same volumes, and only as --byo', async () => {
    // Without --byo, a byo data dir is refused before anything is touched.
    const plain = await runYaac(operatorEnv, 'cluster', 'install')
    expect(plain.exitCode).toBe(1)
    expect(plain.stderr).toMatch(/This data dir is a --byo install/)

    const before = await claimVolumes()
    const install = await runYaac(operatorEnv, 'cluster', 'install', ...BYO_INSTALL)
    expect(install.exitCode, `${install.stdout.slice(-1500)}\n${install.stderr}`).toBe(0)
    expect(await claimVolumes()).toEqual(before)
    expect((await readServerJson()).url).toBe(origin)
  }, INSTALL_TIMEOUT)

  // Last: it destroys its subject.
  it('after a namespace delete, a re-install re-adopts the Released volumes and finds its projects', async () => {
    const before = await claimVolumes()
    await kubectl('delete', 'namespace', 'yaac', '--wait=true', '--timeout=600s')
    for (const volume of [before['yaac-global'], before['yaac-server-local']]) {
      expect((await kubectl('get', 'pv', volume, '-o', 'jsonpath={.status.phase}')).trim()).toBe('Released')
    }
    const install = await runYaac(operatorEnv, 'cluster', 'install', ...BYO_INSTALL)
    expect(install.exitCode, `${install.stdout.slice(-1500)}\n${install.stderr}`).toBe(0)
    expect(install.stdout).toMatch(/Re-adopting yaac-global's volume/)
    expect(install.stdout).toMatch(/Re-adopting yaac-server-local's volume/)
    const after = await claimVolumes()
    expect(after['yaac-global']).toBe(before['yaac-global'])
    expect(after['yaac-server-local']).toBe(before['yaac-server-local'])

    // The database came back with the volume: the project is still there.
    await waitFor('the re-installed server', async () => (await api('/health')).ok, 120_000)
    const projects = await (await api('/project/list')).json() as Array<{ slug: string }>
    expect(projects.map((p) => p.slug)).toContain(SLUG)
  }, INSTALL_TIMEOUT)
})
