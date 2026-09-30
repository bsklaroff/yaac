/**
 * The recorded cluster against the one the kubeconfig's current context
 * points at. kubectl is the process boundary; `server.json` is written for
 * real into the test's data dir.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  execFileAsync: vi.fn(),
}))

import { foreignClusterRefusal } from '#drivers/k8s/install'
import { execFileAsync } from '#drivers/k8s/substrate/kubectl'
import { serverConfigPath, writeServerConfig } from '@yaac/shared/server-config'

const mockRun = vi.mocked(execFileAsync)

/** The current context's name and its cluster's kube-system uid; an Error is an unreadable one. */
function current(context: string | Error, uid: string | Error): void {
  mockRun.mockImplementation(((_file: string, args: string[]) => {
    const v = args[0] === 'config' ? context : uid
    return v instanceof Error ? Promise.reject(v) : Promise.resolve({ stdout: `${v}\n`, stderr: '' })
  }) as never)
}

const RECORD = {
  url: '', enabled: false, saved: [], driver: 'k8s' as const,
  installId: 'install-1', clusterUid: 'uid-prod', kubeContext: 'prod',
}

afterEach(async () => {
  vi.clearAllMocks()
  await fs.rm(serverConfigPath(), { force: true })
})

describe('foreignClusterRefusal', () => {
  it('refuses a current context on another cluster — by uid, whatever its name — naming the way back', async () => {
    await writeServerConfig(RECORD)
    current('dev', 'uid-dev')
    expect(await foreignClusterRefusal())
      .toMatch(/cluster of kube context "prod", and kubectl's current context "dev" is a different cluster[\s\S]*kubectl config use-context prod/)

    // A KUBECONFIG switch to a same-named context: the name passes, the
    // cluster does not, and switching "back" by name would change nothing.
    current('prod', 'uid-elsewhere')
    const sameName = await foreignClusterRefusal()
    expect(sameName).toMatch(/same name but is a different cluster/)
    expect(sameName).toContain('uid-prod')
    expect(sameName).not.toContain('use-context')

    // The recorded cluster under any context name is this install's.
    current('renamed', 'uid-prod')
    expect(await foreignClusterRefusal()).toBeNull()
  })

  it('leaves a record with no cluster unchecked, and refuses a cluster it cannot identify, saying why', async () => {
    // A server.json written before the cluster was recorded predates the
    // check (docs/legacy-compat-shims.md): nothing to compare against.
    await writeServerConfig({ ...RECORD, clusterUid: undefined, kubeContext: undefined })
    current('anything', 'uid-anything')
    expect(await foreignClusterRefusal()).toBeNull()
    expect(mockRun).not.toHaveBeenCalled()

    // Namespace-scoped RBAC on a shared work cluster: kube-system is
    // Forbidden, which is exactly a cluster that is not the install's.
    await writeServerConfig(RECORD)
    current('dev', Object.assign(new Error('exit 1'), {
      stderr: 'Error from server (Forbidden): namespaces "kube-system" is forbidden: User "me" cannot get resource',
    }))
    expect(await foreignClusterRefusal())
      .toMatch(/current context "dev" points at cannot be identified \(.*Forbidden[\s\S]*kubectl config use-context prod/)

    // Through the install's own context, it is the cluster that is down:
    // said so, with no switch that would change nothing.
    current('prod', Object.assign(new Error('exit 1'), { stderr: 'The connection to the server 127.0.0.1:41234 was refused' }))
    const down = await foreignClusterRefusal()
    expect(down).toMatch(/"prod" is the one this install was made through, but its cluster cannot be reached[\s\S]*yaac cluster install/)
    expect(down).not.toContain('use-context')
  })
})
