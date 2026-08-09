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
  IS_NESTED_YAAC,
} from '@yaac/test-utils/setup'
import { e2eMkdtemp } from '@yaac/test-utils/tmp'
import { resolveTestBaseImageRef } from '@yaac/test-utils/mock-remotes'
import { ProxyClient } from '@yaac/server/features/egress/proxy-client'
import { proxyServiceClusterIp } from '@yaac/server/features/cluster/proxy-apply'
import { runtimeClassSpec } from '@yaac/server/platform/k8s/gvisor'
import { SSH_AGENT_MOUNT, SSH_AGENT_SOCKET_PATH } from '@yaac/server/platform/k8s/pod-spec'
import { worktreeIdLabels } from '@yaac/server/platform/k8s/pods'
import { PROXY_APP_NAME, SSH_AGENT_PORT } from '@yaac/server/platform/k8s/proxy-constants'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@yaac/server/platform/k8s/kubectl'

/**
 * ssh-agent forwarding over the network, end to end: a session pod's
 * `ssh-add -l` must list an identity that exists only in the proxy pod's
 * in-memory agent, with no shared filesystem anywhere in between.
 *
 * This is the multi-node property under test. The old transport was a
 * hostPath UNIX socket, which rendezvous only between pods on the SAME
 * node; the pod here mounts nothing but a pod-local emptyDir and reaches
 * the agent through the proxy Service, so nothing about it assumes
 * co-scheduling. What it proves on this single-node cluster is that the
 * whole chain works: NetworkPolicy admits the port, the proxy resolves the
 * source pod to a session, the SSH-remote entitlement passes, and a real
 * ssh client speaks the agent protocol across the splice.
 *
 * The complement — that the transport is not a hole — is the two refusal
 * cases: a session whose registered remote is HTTPS gets nothing (that is
 * exactly the set of pods the server used to withhold the socket mount
 * from), and a pod with no session identity cannot even connect.
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
async function makeTestKey(dir: string): Promise<{ keyPath: string; fingerprint: string; knownHostsEntry: string }> {
  const keyPath = path.join(dir, 'id')
  const hostKeyPath = path.join(dir, 'hostkey')
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q'])
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', hostKeyPath, '-N', '', '-q'])
  const { stdout } = await execFileAsync('ssh-keygen', ['-lf', `${keyPath}.pub`])
  const hostPub = await fs.readFile(`${hostKeyPath}.pub`, 'utf8')
  const [keyType, keyBlob] = hostPub.trim().split(/\s+/)
  return {
    keyPath,
    fingerprint: stdout.trim().split(/\s+/)[1],
    knownHostsEntry: `${SSH_HOST} ${keyType} ${keyBlob}`,
  }
}

/**
 * A session-shaped pod carrying exactly the ssh-agent wiring
 * `buildPodJobManifest` + session-create give a real session: the
 * pod-local emptyDir at SSH_AGENT_MOUNT, SSH_AUTH_SOCK, and the forwarder's
 * upstream. `worktreeId` is what the proxy's pod-watch attributes it to.
 */
async function startWorktreePod(name: string, worktreeId: string): Promise<void> {
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: { ...worktreeIdLabels(worktreeId), 'yaac.test': 'true' },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...runtimeClassSpec({ inner: IS_NESTED_YAAC }),
      dnsPolicy: 'None',
      dnsConfig: { nameservers: [proxyHost] },
      containers: [{
        name: 'session',
        image: await resolveTestBaseImageRef(),
        imagePullPolicy: 'IfNotPresent',
        env: [
          { name: 'SSH_AUTH_SOCK', value: SSH_AGENT_SOCKET_PATH },
          { name: 'YAAC_SSH_AGENT_UPSTREAM', value: `${proxyHost}:${SSH_AGENT_PORT}` },
        ],
        volumeMounts: [{ name: 'ssh-agent', mountPath: SSH_AGENT_MOUNT }],
      }],
      volumes: [{ name: 'ssh-agent', emptyDir: {} }],
    },
  })
}

/** A pod with no session identity at all — the "should reach nothing" case. */
async function startStrayPod(name: string): Promise<void> {
  await kubectlApply({
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

async function waitForPodRunning(name: string, timeoutMs = 180_000): Promise<void> {
  interface RawPod { status?: { phase?: string } }
  const deadline = Date.now() + timeoutMs
  let phase = 'Pending'
  while (Date.now() < deadline) {
    const pod = await kubectlGetJson<RawPod>(['get', 'pod', name, '-n', k8sNamespace()])
    phase = pod?.status?.phase ?? 'Unknown'
    if (phase === 'Running') return
    if (phase === 'Failed' || phase === 'Succeeded') {
      throw new Error(`pod ${name} reached terminal phase ${phase}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`pod ${name} not Running within ${timeoutMs}ms (phase ${phase})`)
}

/** Run a shell command in a pod, never failing the exec itself. */
async function shInPod(
  pod: string, script: string, timeout = 60_000,
): Promise<{ exit: number; out: string }> {
  const { stdout } = await kubectlWithRetry([
    'exec', '-n', k8sNamespace(), pod, '--',
    'sh', '-c', `${script} 2>&1; printf '\nEXIT:%s\n' "$?"`,
  ], { timeout })
  const m = /EXIT:(\d+)\s*$/.exec(stdout)
  return { exit: m ? Number(m[1]) : -1, out: stdout.replace(/\nEXIT:\d+\s*$/, '') }
}

/** Run a shell command in the proxy pod (diagnostics only). */
async function shInProxy(script: string): Promise<string> {
  const { stdout } = await kubectlWithRetry([
    'exec', '-n', k8sNamespace(), `deployment/${PROXY_APP_NAME}`, '--',
    'sh', '-c', `${script} 2>&1; printf '\nEXIT:%s\n' "$?"`,
  ], { timeout: 60_000 }).catch((err: Error) => ({ stdout: `exec failed: ${err.message}` }))
  return stdout
}

/**
 * Why a hop failed, in the order the connection crosses them: the proxy's
 * own listener, then the pod→proxy TCP hop (NetworkPolicy), then what the
 * proxy logged about the connection.
 */
async function proxyAgentLog(): Promise<string> {
  const log = await kubectlWithRetry([
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
 * Start the in-pod forwarder — the same socat line `yaac-worktree-init`
 * runs from the pod's postStart hook, off the same two env vars.
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
  // The hooks are file-level, so a skipped describe would still pay for
  // them — deploying a proxy and two pods for a suite that never runs.
  if (IS_NESTED_YAAC) return
  await requirePodman()
  await requireCluster()
  restoreNamespace = useTestNamespace()
  tempDataDir = await createTempDataDir()
  keyDir = await e2eMkdtemp('yaac-agent-forward-')

  await client.ensureRunning()
  proxyHost = await proxyServiceClusterIp()

  const key = await makeTestKey(keyDir)
  fingerprint = key.fingerprint
  await client.clearSshKeys()
  await client.uploadSshKey(SSH_HOST, key.keyPath, key.knownHostsEntry)

  // The entitlement the proxy gates on is the session's registered remote:
  // an SSH one is exactly when session-create provisions SSH_AUTH_SOCK.
  await client.registerWorktree(sshSession, {
    rules: [], allowedHosts: [SSH_HOST], tool: 'claude', projectSlug: 'agentfwd',
    repoUrl: `git@${SSH_HOST}:acme/app.git`,
  })
  await client.registerWorktree(httpsSession, {
    rules: [], allowedHosts: [SSH_HOST], tool: 'claude', projectSlug: 'agentfwd',
    repoUrl: 'https://github.com/acme/app.git',
  })

  await Promise.all([
    startWorktreePod(sshPod, sshSession),
    startWorktreePod(httpsPod, httpsSession),
  ])
  await Promise.all([waitForPodRunning(sshPod), waitForPodRunning(httpsPod)])
}, 900_000)

afterAll(async () => {
  if (IS_NESTED_YAAC) return
  for (const pod of [sshPod, httpsPod, strayPod]) {
    await kubectlWithRetry([
      'delete', 'pod', pod, '-n', k8sNamespace(),
      '--ignore-not-found', '--wait=false', '--grace-period=1',
    ]).catch(() => { /* ok */ })
  }
  try { await client.removeWorktree(sshSession) } catch { /* ok */ }
  try { await client.removeWorktree(httpsSession) } catch { /* ok */ }
  try { await client.clearSshKeys() } catch { /* ok */ }
  try { await client.stop() } catch { /* ok */ }
  restoreNamespace?.()
  restoreNamespace = null
  if (tempDataDir) await cleanupTempDir(tempDataDir)
  tempDataDir = null
  if (keyDir) await fs.rm(keyDir, { recursive: true, force: true })
  keyDir = null
}, 300_000)

// Host-only. Inside a nested yaac these pods are vcluster-synced, so the
// policy governing the agent port is the OUTER install's inner-proxy ingress
// lock — programmed by the host's yaac, not by this checkout (a vcluster's
// own NetworkPolicies are deliberately never synced to the host, see
// k8s/vcluster/values.yaml). The assertions would then be about the host
// yaac's version rather than this code. The proxy-side gate is covered
// runtime-free in k8s/proxy/test/proxy-ssh-agent-relay.test.ts.
describe.skipIf(IS_NESTED_YAAC)('ssh-agent forwarding over the proxy', () => {
  it('lists the proxy-held identity from inside a session pod, over a pod-local socket', async () => {
    await startForwarder(sshPod)

    // Bounded: a dropped TCP hop leaves ssh-add waiting on a connect that
    // never completes, and a bare exec timeout says nothing about which hop
    // failed — `diagnose` walks them in order.
    const listed = await shInPod(sshPod, 'timeout 30 ssh-add -l')
    expect(listed.exit, `ssh-add -l failed: ${listed.out}${await diagnose(sshPod)}`).toBe(0)
    expect(listed.out).toContain(fingerprint)

    // Nothing but the forwarder's own socket lives in the mount: no host
    // directory is shared with the proxy, which is the whole point.
    const dir = await shInPod(sshPod, `ls -A ${SSH_AGENT_MOUNT}`)
    expect(dir.out.trim().split(/\s+/).filter(Boolean)).toEqual(['socket'])

    // The private key never reaches the pod — the agent only ever signs.
    const keyGrep = await shInPod(sshPod,
      `grep -rl 'PRIVATE KEY' ${SSH_AGENT_MOUNT} /tmp 2>/dev/null | head -5`)
    expect(keyGrep.out).not.toContain('PRIVATE KEY')
  }, 300_000)

  it('refuses a session whose registered remote is not SSH', async () => {
    // Same pod shape, same network path, different registration: the proxy
    // hands the agent only to the sessions the server would have mounted
    // the socket into.
    await startForwarder(httpsPod)

    const listed = await shInPod(httpsPod, 'timeout 30 ssh-add -l')
    expect(listed.exit).not.toBe(0)
    expect(listed.out).not.toContain(fingerprint)
    // Refused BY THE GATE, not by a broken hop: a bare non-zero exit is also
    // what a dropped connection looks like, so assert the proxy said why.
    expect(await proxyAgentLog()).toMatch(/BLOCKED ssh-agent from .*no SSH remote/)
  }, 300_000)

  it('gives a pod with no session identity no route to the agent port', async () => {
    await startStrayPod(strayPod)
    await waitForPodRunning(strayPod)

    // `timeout` bounds the wait: a policy DROP is silent, so the connect
    // would otherwise sit through the kernel's full SYN retry schedule.
    const dial = await shInPod(strayPod,
      `timeout 15 socat -T5 /dev/null TCP:${proxyHost}:${SSH_AGENT_PORT}`)
    expect(dial.exit, `a non-session pod reached the agent port: ${dial.out}`).not.toBe(0)
  }, 300_000)
})
