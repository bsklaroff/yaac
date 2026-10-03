import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  requirePodman,
  requireCluster,
  useTestNamespace,
  createTempDataDir,
  cleanupTempDir,
  TEST_PROXY_CONFIG,
} from '@yaac/test-utils/setup'
import { e2eMkdtemp } from '@yaac/test-utils/tmp'
import { resolveTestBaseImageRef } from '@yaac/test-utils/test-pods'
import { startWorkspacePod, waitForPod } from '@yaac/test-utils/test-pods'
import { ProxyClient } from '@yaac/server/drivers/k8s/egress/proxy-client'
import {
  applyProxyRegistration,
  deregisterWorkspaceEgress,
} from '@yaac/server/drivers/k8s/egress/proxy-registration'
import { syncProxyCredentials } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import { proxyServiceClusterIp } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import { SSH_AGENT_MOUNT, SSH_AGENT_SOCKET_PATH } from '@yaac/server/drivers/k8s/substrate/pod-spec'
import { PROXY_APP_NAME, SSH_AGENT_PORT } from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import { applyObject, deleteObject, k8sNamespace } from '@yaac/server/drivers/k8s/substrate/api'
import { kubectl } from '@yaac/test-utils/kubectl'

/**
 * ssh-agent forwarding over the network: a workspace pod's `ssh-add -l`
 * must list an identity held only in the proxy pod's in-memory agent. The
 * pod shares no filesystem with the proxy and reaches the agent through
 * the proxy Service, so nothing assumes the pods share a node. This covers
 * the whole chain: NetworkPolicy admits the port, the proxy maps the source
 * pod to a workspace, the SSH-remote check passes, and a real ssh client
 * talks to the agent. The proxy-side check alone is unit-tested in
 * k8s/proxy/test/proxy-ssh-agent-relay.test.ts.
 *
 * The refusal cases: a workspace with an HTTPS remote gets nothing, a pod
 * with no workspace identity cannot connect, and a workspace of a project
 * the key is not assigned to sees no key.
 */

const execFileAsync = promisify(execFile)

const SSH_HOST = 'git.agent-forward.example'
const suffix = crypto.randomBytes(4).toString('hex')
const sshPod = `yaac-agentfwd-ssh-${suffix}`
const httpsPod = `yaac-agentfwd-https-${suffix}`
const strayPod = `yaac-agentfwd-stray-${suffix}`
const sshSession = `agentfwd-ssh-${suffix}`
const httpsSession = `agentfwd-https-${suffix}`

const client = new ProxyClient(TEST_PROXY_CONFIG)

let restoreNamespace: (() => void) | null = null
let tempDataDir: string | null = null
let keyDir: string | null = null
let proxyHost = ''
let fingerprint = ''

/** A client keypair plus the host key that becomes SSH_HOST's known_hosts. */
async function makeTestKey(dir: string): Promise<{
  privateKey: string; publicKey: string; fingerprint: string; knownHostsEntry: string
}> {
  const keyPath = path.join(dir, 'id')
  const hostKeyPath = path.join(dir, 'hostkey')
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q'])
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', hostKeyPath, '-N', '', '-q'])
  const { stdout } = await execFileAsync('ssh-keygen', ['-lf', `${keyPath}.pub`])
  const hostPub = await fs.readFile(`${hostKeyPath}.pub`, 'utf8')
  const [keyType, keyBlob] = hostPub.trim().split(/\s+/)
  return {
    privateKey: await fs.readFile(keyPath, 'utf8'),
    publicKey: (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim(),
    fingerprint: stdout.trim().split(/\s+/)[1],
    knownHostsEntry: `${SSH_HOST} ${keyType} ${keyBlob}`,
  }
}

/** A pod with no workspace identity, which should reach nothing. */
async function startStrayPod(name: string): Promise<void> {
  await applyObject({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: k8sNamespace(), labels: { 'yaac.test': 'true' } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [{
        name: 'stray',
        image: await resolveTestBaseImageRef(),
        imagePullPolicy: 'IfNotPresent',
      }],
    },
  })
}

/** Run a shell command in a pod, never failing the exec itself. */
async function shInPod(
  pod: string, script: string, timeout = 60_000,
): Promise<{ exit: number; out: string }> {
  const { stdout } = await kubectl([
    'exec', '-n', k8sNamespace(), pod, '--',
    'sh', '-c', `${script} 2>&1; printf '\nEXIT:%s\n' "$?"`,
  ], { timeout })
  const m = /EXIT:(\d+)\s*$/.exec(stdout)
  return { exit: m ? Number(m[1]) : -1, out: stdout.replace(/\nEXIT:\d+\s*$/, '') }
}

/** Run a shell command in the proxy pod (diagnostics only). */
async function shInProxy(script: string): Promise<string> {
  const { stdout } = await kubectl([
    'exec', '-n', k8sNamespace(), `deployment/${PROXY_APP_NAME}`, '--',
    'sh', '-c', `${script} 2>&1; printf '\nEXIT:%s\n' "$?"`,
  ], { timeout: 60_000 }).catch((err: Error) => ({ stdout: `exec failed: ${err.message}` }))
  return stdout
}

/**
 * Which hop failed, checked in connection order: the proxy's listener, the
 * pod-to-proxy TCP hop (NetworkPolicy), then the proxy's log.
 */
async function proxyAgentLog(): Promise<string> {
  const log = await kubectl([
    'logs', '-n', k8sNamespace(), `deployment/${PROXY_APP_NAME}`, '--tail=200',
  ], { timeout: 60_000 }).catch((err: Error) => ({ stdout: `logs failed: ${err.message}` }))
  return log.stdout.split('\n').filter((l) => l.includes('ssh-agent')).join('\n')
}

async function diagnose(pod: string): Promise<string> {
  const listener = await shInProxy(`socat -T5 /dev/null TCP:127.0.0.1:${SSH_AGENT_PORT}`)
  const hop = await shInPod(pod, 'timeout 10 socat -T5 /dev/null TCP:$YAAC_SSH_AGENT_UPSTREAM')
  const relevant = await proxyAgentLog()
  const fwd = await shInPod(pod, 'cat /tmp/ssh-agent-forward.log || true')
  return `\n  proxy-local listener: ${listener.trim()}`
    + `\n  pod→proxy hop (exit ${hop.exit}): ${hop.out.trim()}`
    + `\n  proxy log: ${relevant || '(no ssh-agent lines)'}`
    + `\n  forwarder log: ${fwd.out.trim()}`
}

/**
 * Start the in-pod forwarder: the same socat line `yaac-workspace-init`
 * runs from the pod's postStart hook.
 */
async function startForwarder(pod: string): Promise<void> {
  const { exit, out } = await shInPod(pod,
    'setsid socat "UNIX-LISTEN:$SSH_AUTH_SOCK,fork,mode=0600" '
    + '"TCP:$YAAC_SSH_AGENT_UPSTREAM" >/tmp/ssh-agent-forward.log 2>&1 </dev/null & '
    + 'for i in $(seq 1 40); do [ -S "$SSH_AUTH_SOCK" ] && break; sleep 0.25; done; '
    + 'test -S "$SSH_AUTH_SOCK"')
  expect(exit, `forwarder never created the socket in ${pod}: ${out}`).toBe(0)
}

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  restoreNamespace = useTestNamespace()
  tempDataDir = await createTempDataDir()
  keyDir = await e2eMkdtemp('yaac-agent-forward-')

  await client.ensureRunning()
  proxyHost = await proxyServiceClusterIp()

  const key = await makeTestKey(keyDir)
  fingerprint = key.fingerprint
  // The key reaches the proxy's agent through the credentials Secret.
  await syncProxyCredentials({
    claude: null, codex: null, opencode: null, pi: null, git: [],
    ssh: [{
      privateKey: key.privateKey,
      publicKey: key.publicKey,
      projects: [{ slug: 'agentfwd', host: SSH_HOST, knownHostsEntry: key.knownHostsEntry }],
    }],
  })

  // The proxy only serves the agent to workspaces with an SSH remote.
  await applyProxyRegistration(sshSession, {
    rules: [], allowedHosts: [SSH_HOST], tool: 'claude', projectSlug: 'agentfwd',
    repoUrl: `git@${SSH_HOST}:acme/app.git`,
  })
  await applyProxyRegistration(httpsSession, {
    rules: [], allowedHosts: [SSH_HOST], tool: 'claude', projectSlug: 'agentfwd',
    repoUrl: 'https://github.com/acme/app.git',
  })

  // The ssh-agent wiring a real workspace gets: a pod-local emptyDir at
  // SSH_AGENT_MOUNT, SSH_AUTH_SOCK, and the forwarder's upstream.
  const agentWiring = {
    env: [
      { name: 'SSH_AUTH_SOCK', value: SSH_AGENT_SOCKET_PATH },
      { name: 'YAAC_SSH_AGENT_UPSTREAM', value: `${proxyHost}:${SSH_AGENT_PORT}` },
    ],
    emptyDirs: { 'ssh-agent': SSH_AGENT_MOUNT },
  }
  await Promise.all([
    startWorkspacePod(sshPod, sshSession, proxyHost, agentWiring),
    startWorkspacePod(httpsPod, httpsSession, proxyHost, agentWiring),
  ])
}, 900_000)

afterAll(async () => {
  for (const pod of [sshPod, httpsPod, strayPod]) {
    await deleteObject({ apiVersion: 'v1', kind: 'Pod', name: pod, namespace: k8sNamespace() }, { gracePeriodSeconds: 1 })
      .catch(() => { /* ok */ })
  }
  await deregisterWorkspaceEgress(sshSession)
  await deregisterWorkspaceEgress(httpsSession)
  try { await client.stop() } catch { /* ok */ }
  restoreNamespace?.()
  restoreNamespace = null
  if (tempDataDir) await cleanupTempDir(tempDataDir)
  tempDataDir = null
  if (keyDir) await fs.rm(keyDir, { recursive: true, force: true })
  keyDir = null
}, 300_000)

describe('ssh-agent forwarding over the proxy', () => {
  it('lists the proxy-held identity from inside a session pod, over a pod-local socket', async () => {
    await startForwarder(sshPod)

    // Bounded, so a dropped hop fails fast and `diagnose` can say which.
    const listed = await shInPod(sshPod, 'timeout 30 ssh-add -l')
    expect(listed.exit, `ssh-add -l failed: ${listed.out}${await diagnose(sshPod)}`).toBe(0)
    expect(listed.out).toContain(fingerprint)

    // Only the forwarder's socket is in the mount; nothing is shared with
    // the proxy.
    const dir = await shInPod(sshPod, `ls -A ${SSH_AGENT_MOUNT}`)
    expect(dir.out.trim().split(/\s+/).filter(Boolean)).toEqual(['socket'])

    // The private key never reaches the pod.
    const keyGrep = await shInPod(sshPod,
      `grep -rl 'PRIVATE KEY' ${SSH_AGENT_MOUNT} /tmp 2>/dev/null | head -5`)
    expect(keyGrep.out).not.toContain('PRIVATE KEY')
  }, 300_000)

  it('refuses a session whose registered remote is not SSH', async () => {
    // Same pod shape and network path, but an HTTPS remote.
    await startForwarder(httpsPod)

    const listed = await shInPod(httpsPod, 'timeout 30 ssh-add -l')
    expect(listed.exit).not.toBe(0)
    expect(listed.out).not.toContain(fingerprint)
    // Check the proxy refused it, not that a hop was dropped.
    expect(await proxyAgentLog()).toMatch(/BLOCKED ssh-agent from .*no SSH remote/)
  }, 300_000)

  it('gives a pod with no session identity no route to the agent port', async () => {
    await startStrayPod(strayPod)
    await waitForPod(strayPod)

    // A policy DROP is silent, so bound the connect with `timeout`.
    const dial = await shInPod(strayPod,
      `timeout 15 socat -T5 /dev/null TCP:${proxyHost}:${SSH_AGENT_PORT}`)
    expect(dial.exit, `a non-session pod reached the agent port: ${dial.out}`).not.toBe(0)
  }, 300_000)

  // Last: it moves the SSH workspace to another project.
  it('shows a session only the keys assigned to its own project', async () => {
    // Re-registered under a project the key is not assigned to.
    await applyProxyRegistration(sshSession, {
      rules: [], allowedHosts: [SSH_HOST], tool: 'claude', projectSlug: 'agentfwd-other',
      repoUrl: `git@${SSH_HOST}:acme/app.git`,
    })
    let listed = { exit: 0, out: '' }
    const deadline = Date.now() + 60_000
    do {
      listed = await shInPod(sshPod, 'timeout 30 ssh-add -l')
      if (!listed.out.includes(fingerprint)) break
      await new Promise((r) => setTimeout(r, 1000))
    } while (Date.now() < deadline)
    expect(listed.out, `another project's key is still listed${await diagnose(sshPod)}`).not.toContain(fingerprint)
    expect(listed.out).toContain('no identities')
  }, 300_000)
})
