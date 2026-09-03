import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
import { ProxyClient } from '@yaac/server/drivers/k8s/egress/proxy-client'

const execFileAsync = promisify(execFile)

/**
 * End-to-end coverage of the proxy's ssh-agent key management: upload
 * destination-constrained keys (PUT /agent/keys → `ssh-add -H <file> -h
 * <host>` inside the proxy pod), list them back, and clear the agent.
 *
 * The upload leg is the regression test for the known_hosts resolution
 * bug: ssh-add expands `~` via getpwuid(), not $HOME, so under the pod's
 * runAsUser uid it never found the file the proxy wrote to
 * $HOME/.ssh/known_hosts and failed with "No host keys found for
 * destination" — the proxy must pass the path explicitly with -H.
 */

const HOST_A = 'git.ssh-agent-a.example'
const HOST_B = 'git.ssh-agent-b.example'

let restoreNamespace: (() => void) | null = null
let tempDataDir: string | null = null
let keyDir: string | null = null

const client = new ProxyClient(TEST_PROXY_CONFIG)

interface TestKey {
  /** The key itself: what the server holds sealed, and what it uploads. */
  privateKey: string
  fingerprint: string
  knownHostsEntry: string
}

/**
 * Generate a passphrase-less client keypair plus a separate host keypair
 * whose public half becomes the known_hosts entry for `host` — what a
 * real `ssh-keyscan <host>` would return.
 */
async function makeTestKey(dir: string, host: string, name: string): Promise<TestKey> {
  const privateKeyPath = path.join(dir, name)
  const hostKeyPath = path.join(dir, `${name}-hostkey`)
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', privateKeyPath, '-N', '', '-q'])
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', hostKeyPath, '-N', '', '-q'])

  // "256 SHA256:<hash> <comment> (ED25519)" → the agent lists column 2.
  const { stdout: lint } = await execFileAsync('ssh-keygen', ['-lf', `${privateKeyPath}.pub`])
  const fingerprint = lint.trim().split(/\s+/)[1]

  const hostPub = await fs.readFile(`${hostKeyPath}.pub`, 'utf8')
  const [keyType, keyBlob] = hostPub.trim().split(/\s+/)
  return {
    privateKey: await fs.readFile(privateKeyPath, 'utf8'),
    fingerprint,
    knownHostsEntry: `${host} ${keyType} ${keyBlob}`,
  }
}

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  restoreNamespace = useTestNamespace()
  tempDataDir = await createTempDataDir()
  keyDir = await e2eMkdtemp('yaac-ssh-agent-')
  await client.ensureRunning()
}, 300_000)

afterAll(async () => {
  try { await client.stop() } catch { /* ok */ }
  restoreNamespace?.()
  restoreNamespace = null
  if (tempDataDir) await cleanupTempDir(tempDataDir)
  tempDataDir = null
  if (keyDir) await fs.rm(keyDir, { recursive: true, force: true })
  keyDir = null
})

describe('proxy ssh-agent key management', () => {
  let keyA: TestKey
  let keyB: TestKey

  it('uploads destination-constrained keys and lists them back', async () => {
    keyA = await makeTestKey(keyDir!, HOST_A, 'key-a')
    keyB = await makeTestKey(keyDir!, HOST_B, 'key-b')

    await client.uploadSshKey(HOST_A, keyA.privateKey, keyA.knownHostsEntry)
    // A second host exercises the known_hosts rewrite accumulating entries.
    await client.uploadSshKey(HOST_B, keyB.privateKey, keyB.knownHostsEntry)

    const listed = await client.listAgentKeys()
    const fingerprints = listed.map((k) => k.fingerprint)
    expect(fingerprints).toContain(keyA.fingerprint)
    expect(fingerprints).toContain(keyB.fingerprint)
  }, 60_000)

  it('clears every identity from the agent', async () => {
    await client.clearSshKeys()
    expect(await client.listAgentKeys()).toEqual([])
  }, 60_000)

  it('re-uploads after a clear (the syncSshKeysFromCredentials cycle)', async () => {
    // syncSshKeysFromCredentials always runs clear-then-upload; make sure a
    // cleared agent (and rewritten empty known_hosts) accepts keys again.
    await client.uploadSshKey(HOST_A, keyA.privateKey, keyA.knownHostsEntry)
    const listed = await client.listAgentKeys()
    expect(listed.map((k) => k.fingerprint)).toContain(keyA.fingerprint)
  }, 60_000)
})
