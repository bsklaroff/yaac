import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requireCluster, useTestNamespace, createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { requirePodman, TEST_PROXY_CONFIG } from '#support/cluster'
import { e2eMkdtemp } from '@yaac/test-utils/tmp'
import { startWorkspacePod } from '#support/test-pods'
import { waitFor } from '@yaac/shared/wait-for'
import { ProxyClient } from '@yaac/server/drivers/k8s/egress/proxy-client'
import {
  applyProxyRegistration,
  deregisterWorkspaceEgress,
} from '@yaac/server/drivers/k8s/egress/proxy-registration'
import { workspaceSshEnv } from '@yaac/server/drivers/k8s/egress/ssh-transport'
import { proxyServiceClusterIp, syncProxyCredentials } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import { deleteObject, k8sNamespace } from '@yaac/server/drivers/k8s/substrate/api'
import { kubectl } from '@yaac/test-utils/kubectl'

/**
 * Git over ssh from a workspace pod, which the proxy ends itself
 * (docs/workspace-egress.md "Git over SSH"). A real ssh client in the pod,
 * holding no key and trusting only the proxy's host key from the ConfigMap
 * every pod mounts, reaches the proxy through the tunnel sentinel. This
 * covers the chain a unit test cannot: netd's redirect, the pod's identity
 * by source address, the host key the proxy published, and the grants it
 * reads from the credentials Secret.
 *
 * The git host is a redirect to a port nothing listens on, so a command the
 * proxy lets through is seen by its failed dial, and no test needs an sshd.
 * The login itself is unit-tested (k8s/proxy/test/ssh-session.test.ts).
 */

const execFileAsync = promisify(execFile)

const SSH_HOST = 'git.ssh-session.example'
const PROJECT = 'ssh-session'
const suffix = crypto.randomBytes(4).toString('hex')
const pod = `yaac-sshsession-${suffix}`
const workspaceId = `sshsession-${suffix}`

const client = new ProxyClient(TEST_PROXY_CONFIG)

let restoreNamespace: (() => void) | null = null
let tempDataDir: string | null = null
let keyDir: string | null = null
let key: { privateKey: string; publicKey: string }

const grant = (repo: string, readOnly: boolean) => ({
  projectId: PROJECT, repoId: crypto.randomUUID(), host: SSH_HOST, path: `acme/${repo}`, readOnly, ghToken: false,
  knownHostsEntry: `${SSH_HOST} ssh-ed25519 ${Buffer.from('not a real host key').toString('base64')}`,
})

/** Hand the proxy the key, granted for `acme/app` and, read-only,
 *  `acme/ro`. */
async function pushGrants(appReadOnly: boolean): Promise<void> {
  await syncProxyCredentials({ e2e: {
    claude: null, codex: null, opencode: null, pi: null, omp: null, git: [],
    ssh: [{ ...key, grants: [grant('app', appReadOnly), grant('ro', true)] }],
  } })
}

/** Run a shell command in the pod, never failing the exec itself. */
async function shInPod(script: string, timeout = 60_000): Promise<{ exit: number; out: string }> {
  const { stdout } = await kubectl([
    'exec', '-n', k8sNamespace(), pod, '--',
    'sh', '-c', `${script} 2>&1; printf '\nEXIT:%s\n' "$?"`,
  ], { timeout })
  const m = /EXIT:(\d+)\s*$/.exec(stdout)
  return { exit: m ? Number(m[1]) : -1, out: stdout.replace(/\nEXIT:\d+\s*$/, '') }
}

/** Run one remote command the way git would, through `GIT_SSH_COMMAND`. */
function ssh(remoteCommand: string): Promise<{ exit: number; out: string }> {
  return shInPod(`CMD="${remoteCommand}"; eval "timeout 30 $GIT_SSH_COMMAND git@${SSH_HOST} \\"\\$CMD\\""`)
}

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  restoreNamespace = useTestNamespace()
  tempDataDir = await createTempDataDir()
  keyDir = await e2eMkdtemp('yaac-ssh-session-')

  await client.ensureRunning()
  const proxyHost = await proxyServiceClusterIp()

  const keyPath = path.join(keyDir, 'id')
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q'])
  key = {
    privateKey: await fs.readFile(keyPath, 'utf8'),
    publicKey: (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim(),
  }
  await pushGrants(false)
  await applyProxyRegistration(workspaceId, {
    rules: [], allowedHosts: [SSH_HOST], projectId: PROJECT, owner: 'e2e',
    upstreamRedirects: { [SSH_HOST]: { host: '127.0.0.1', port: 9 } },
  })
  await startWorkspacePod(pod, workspaceId, proxyHost, {
    env: workspaceSshEnv().map((entry) => {
      const at = entry.indexOf('=')
      return { name: entry.slice(0, at), value: entry.slice(at + 1) }
    }),
  })
}, 900_000)

afterAll(async () => {
  await deleteObject({ apiVersion: 'v1', kind: 'Pod', name: pod, namespace: k8sNamespace() }, { gracePeriodSeconds: 1 })
    .catch(() => { /* ok */ })
  await deregisterWorkspaceEgress(workspaceId)
  try { await client.stop() } catch { /* ok */ }
  restoreNamespace?.()
  restoreNamespace = null
  if (tempDataDir) await cleanupTempDir(tempDataDir)
  tempDataDir = null
  if (keyDir) await fs.rm(keyDir, { recursive: true, force: true })
  keyDir = null
}, 300_000)

describe('git over ssh through the proxy', () => {
  it('lets a git command for one of the project\'s repos through to the host, with no key in the pod', async () => {
    // Past the proxy's checks, it dials the host itself; nothing listens
    // there, which it says.
    const fetch = await shInPod(`timeout 60 git ls-remote git@${SSH_HOST}:acme/app.git`)
    expect(fetch.exit).not.toBe(0)
    expect(fetch.out).toContain(`yaac: cannot reach ${SSH_HOST} over ssh`)
    // The pod trusts the proxy's key alone and offers no identity.
    expect(fetch.out).not.toContain('Host key verification failed')
    expect((await shInPod('ls ~/.ssh/id_* 2>/dev/null; echo "agent:${SSH_AUTH_SOCK:-none}"')).out.trim()).toBe('agent:none')
  })

  it('refuses a repo the project does not link, a write to a read-only one, and anything that is not git', async () => {
    const other = await shInPod(`timeout 60 git ls-remote git@${SSH_HOST}:acme/other.git`)
    expect(other.out).toContain(`yaac: acme/other.git on ${SSH_HOST} is not one of this project's ssh repos`)

    const push = await ssh("git-receive-pack 'acme/ro.git'")
    expect(push.exit).toBe(1)
    expect(push.out).toContain('is read-only in this project')
    // The read-only repo still fetches, as far as the dial.
    expect((await ssh("git-upload-pack 'acme/ro.git'")).out).toContain(`cannot reach ${SSH_HOST} over ssh`)

    const shell = await ssh('cat /etc/passwd')
    expect(shell.exit).toBe(1)
    expect(shell.out).toContain('carries only git commands')
  })

  it('applies a changed grant to the running workspace', async () => {
    expect((await ssh("git-receive-pack 'acme/app.git'")).out).toContain(`cannot reach ${SSH_HOST} over ssh`)
    await pushGrants(true)
    let last = ''
    const refused = await waitFor(async () => {
      last = (await ssh("git-receive-pack 'acme/app.git'")).out
      return last.includes('is read-only in this project')
    }, { timeoutMs: 60_000, intervalMs: 2_000 })
    expect(refused, last).toBe(true)
  })
})
