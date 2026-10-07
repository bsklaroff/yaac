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
 * with no workspace identity cannot connect, a workspace of a project the
 * key is not assigned to sees no key, and a workspace signs only once bound
 * to a host its own grant names, even though the agent would sign for any
 * host some grant of the key names.
 */

const execFileAsync = promisify(execFile)

const SSH_HOST = 'git.agent-forward.example'
/** A host the same key is granted for only in another project. */
const OTHER_HOST = 'git.other-forward.example'
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
let testKey: Awaited<ReturnType<typeof makeTestKey>>

/** A wire `string`: uint32 length, then the bytes. */
function sshString(value: string | Buffer): Buffer {
  const bytes = Buffer.from(value)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(bytes.length, 0)
  return Buffer.concat([len, bytes])
}

/** One agent-protocol message: `uint32 length`, the type byte, the body. */
function agentMessage(type: number, body: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(1 + body.length, 0)
  head.writeUInt8(type, 4)
  return Buffer.concat([head, body])
}

/**
 * A host key the test holds the private half of, standing in for an sshd's
 * (the images ship no sshd). The agent only checks that a session bind is
 * signed by the host key it names, so the test can bind as that host.
 */
interface TestHostKey {
  /** The SSH wire blob, as known_hosts carries it in base64. */
  blob: Buffer
  knownHostsEntry: string
  /** An SSH signature over `data`, as a server signs its session id. */
  sign: (data: Buffer) => Buffer
}

function makeHostKey(host: string): TestHostKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(raw)])
  return {
    blob,
    knownHostsEntry: `${host} ssh-ed25519 ${blob.toString('base64')}`,
    sign: (data) => Buffer.concat([sshString('ssh-ed25519'), sshString(crypto.sign(null, data, privateKey))]),
  }
}

/** A client keypair, plus the host keys of SSH_HOST and OTHER_HOST. */
async function makeTestKey(dir: string): Promise<{
  privateKey: string; publicKey: string; fingerprint: string; host: TestHostKey; otherHost: TestHostKey
}> {
  const keyPath = path.join(dir, 'id')
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q'])
  const { stdout } = await execFileAsync('ssh-keygen', ['-lf', `${keyPath}.pub`])
  return {
    privateKey: await fs.readFile(keyPath, 'utf8'),
    publicKey: (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim(),
    fingerprint: stdout.trim().split(/\s+/)[1],
    host: makeHostKey(SSH_HOST),
    otherHost: makeHostKey(OTHER_HOST),
  }
}

/**
 * The client side of an ssh login, as ssh speaks it to its agent: a
 * `session-bind@openssh.com` naming the server's host key and session id,
 * then a sign request whose data is the hostbound userauth request ssh-agent
 * parses to check the binding.
 */
function bindMessage(host: TestHostKey, sessionId: Buffer): Buffer {
  return agentMessage(27, Buffer.concat([
    sshString('session-bind@openssh.com'), sshString(host.blob), sshString(sessionId),
    sshString(host.sign(sessionId)), Buffer.from([0]),
  ]))
}

function userauthSignMessage(clientBlob: Buffer, host: TestHostKey, sessionId: Buffer): Buffer {
  const data = Buffer.concat([
    sshString(sessionId), Buffer.from([50]), sshString('git'), sshString('ssh-connection'),
    sshString('publickey-hostbound-v00@openssh.com'), Buffer.from([1]), sshString('ssh-ed25519'),
    sshString(clientBlob), sshString(host.blob),
  ])
  return agentMessage(13, Buffer.concat([sshString(clientBlob), sshString(data), Buffer.alloc(4)]))
}

/**
 * Speak raw agent protocol over the pod's SSH_AUTH_SOCK: each conversation
 * is one connection sending its messages in turn. Answers one line per
 * conversation with the reply type of each message (5 failure, 6 success,
 * 14 signature).
 */
const AGENT_CLIENT = `
import os, socket, struct, sys
def reply(s):
    def take(n):
        b = b''
        while len(b) < n:
            c = s.recv(n - len(b))
            if not c: raise SystemExit('agent closed the connection')
            b += c
        return b
    return take(struct.unpack('>I', take(4))[0])[0]
for conversation in sys.argv[1:]:
    s = socket.socket(socket.AF_UNIX)
    s.connect(os.environ['SSH_AUTH_SOCK'])
    types = []
    for m in conversation.split(','):
        s.sendall(bytes.fromhex(m))
        types.append(str(reply(s)))
    print(' '.join(types))
    s.close()
`

async function agentConversations(pod: string, conversations: Buffer[][]): Promise<string[]> {
  const script = Buffer.from(AGENT_CLIENT).toString('base64')
  const args = conversations.map((c) => c.map((m) => m.toString('hex')).join(',')).join(' ')
  const r = await shInPod(pod, `echo ${script} | base64 -d > /tmp/agent-client.py && timeout 30 python3 /tmp/agent-client.py ${args}`)
  expect(r.exit, `agent client failed: ${r.out}`).toBe(0)
  return r.out.trim().split('\n')
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

  const key = testKey = await makeTestKey(keyDir)
  fingerprint = key.fingerprint
  // The key reaches the proxy's agent through the credentials Secret. Its
  // grant on a second project puts OTHER_HOST in the agent's own `-h` set,
  // so only the relay keeps this workspace from signing for it.
  await syncProxyCredentials({ e2e: {
    claude: null, codex: null, opencode: null, pi: null, git: [],
    ssh: [{
      privateKey: key.privateKey,
      publicKey: key.publicKey,
      projects: [
        { projectId: 'agentfwd', host: SSH_HOST, knownHostsEntry: key.host.knownHostsEntry },
        { projectId: 'agentfwd-b', host: OTHER_HOST, knownHostsEntry: key.otherHost.knownHostsEntry },
      ],
    }],
  } })

  // The proxy only serves the agent to workspaces with an SSH remote.
  await applyProxyRegistration(sshSession, {
    rules: [], allowedHosts: [SSH_HOST], tool: 'claude', projectId: 'agentfwd', owner: 'e2e',
    repoUrl: `git@${SSH_HOST}:acme/app.git`,
  })
  await applyProxyRegistration(httpsSession, {
    rules: [], allowedHosts: [SSH_HOST], tool: 'claude', projectId: 'agentfwd', owner: 'e2e',
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

  it('signs a login bound to a host its grant names, and none bound elsewhere or unbound', async () => {
    await startForwarder(sshPod)
    const clientBlob = Buffer.from(testKey.publicKey.split(/\s+/)[1], 'base64')
    const sid = (): Buffer => crypto.randomBytes(32)
    const [granted, other] = [sid(), sid()]
    const replies = await agentConversations(sshPod, [
      // Unbound: the relay refuses before the agent sees it.
      [userauthSignMessage(clientBlob, testKey.host, granted)],
      // Bound to SSH_HOST, which this project's grant names: the agent binds
      // and signs.
      [bindMessage(testKey.host, granted), userauthSignMessage(clientBlob, testKey.host, granted)],
      // Bound to OTHER_HOST: the agent accepts the bind and would sign (the
      // key's other grant names that host), but the relay refuses.
      [bindMessage(testKey.otherHost, other), userauthSignMessage(clientBlob, testKey.otherHost, other)],
    ])
    expect(replies, await diagnose(sshPod)).toEqual(['5', '6 14', '6 5'])
    expect(await proxyAgentLog()).toContain('not granted')
  }, 300_000)

  // Last: it moves the SSH workspace to another project.
  it('shows a session only the keys assigned to its own project', async () => {
    // Re-registered under a project the key is not assigned to.
    await applyProxyRegistration(sshSession, {
      rules: [], allowedHosts: [SSH_HOST], tool: 'claude', projectId: 'agentfwd-other', owner: 'e2e',
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
