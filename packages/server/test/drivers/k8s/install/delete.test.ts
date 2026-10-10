import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as apiModule from '#drivers/k8s/substrate/api'

// Only the kind/podman subprocess and the TTY prompt are faked; the
// confirmation logic runs for real.
vi.mock('#drivers/k8s/substrate/api', async (importOriginal) => ({
  ...await importOriginal<typeof apiModule>(),
  execFileAsync: vi.fn(),
}))

const mockQuestion = vi.fn<(q: string) => Promise<string>>()
vi.mock('node:readline/promises', () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: mockQuestion,
      close: vi.fn(),
    })),
  },
}))

import { ClusterDeleteError, runClusterDelete } from '#drivers/k8s/install'
import { execFileAsync } from '#drivers/k8s/substrate/api'
import { installRecordPath, recordInstall } from '@yaac/shared/install-record'
import { serverConfigPath } from '@yaac/shared/server-config'
import fs from 'node:fs/promises'

const mockRun = vi.mocked(execFileAsync)
const logs: string[] = []

/** A host whose only kind cluster is the default "yaac". */
function stageClusters(stdout: string): void {
  mockRun.mockImplementation(((file: string, args: string[]) => {
    if (file === 'kind' && args[0] === 'get' && args[1] === 'clusters') {
      return Promise.resolve({ stdout, stderr: '' })
    }
    return Promise.resolve({ stdout: '', stderr: '' })
  }) as never)
}

/** The `kind delete cluster` invocation, if any. */
function deleteCall(): [string, string[], unknown?] | undefined {
  return mockRun.mock.calls.find(([f, a]) =>
    f === 'kind' && (a as string[])[0] === 'delete') as [string, string[], unknown?] | undefined
}

const logged = (): string => logs.join('\n')

beforeEach(() => {
  vi.clearAllMocks()
  stageClusters('yaac\n')
  logs.length = 0
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
  // A TTY, so the confirmation prompts.
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('runClusterDelete', () => {
  it('refuses on a byo install, printing the uninstall instead of deleting anything', async () => {
    // The cluster is not yaac's to delete, even if a same-named kind
    // cluster exists on this host.
    await recordInstall({ driver: 'k8s', installId: 'install-1', byo: true })
    try {
      const err = await runClusterDelete({ yes: true }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterDeleteError)
      const message = (err as Error).message
      expect(message).toContain('the cluster is not yaac\'s to delete')
      // Every namespace the install made, including the signing key's.
      expect(message).toMatch(/kubectl delete namespace yaac yaac-registry-keys\n/)
      expect(message).toMatch(/kubectl delete clusterrole,clusterrolebinding -l yaac\.install-namespace=yaac/)
      // Cluster-wide objects (including gVisor node labels) are flagged as
      // shared with other installs.
      expect(message).toMatch(/only if no other yaac install uses this cluster[\s\S]*kubectl delete runtimeclass/)
      expect(message).toContain('kubectl label nodes --all yaac.gvisor- yaac.gvisor-version-')
      // The Retain volumes survive; the message says how to delete them by
      // install id.
      expect(message).toContain('kubectl delete pv -l yaac.install-id=install-1')
      expect(deleteCall()).toBeUndefined()
    } finally {
      await fs.rm(installRecordPath(), { force: true })
      await fs.rm(serverConfigPath(), { force: true })
    }
  })

  it('deletes the cluster on the --yes happy path', async () => {
    await runClusterDelete({ yes: true })

    expect(deleteCall()?.[1]).toEqual(['delete', 'cluster', '--name', 'yaac'])
    expect((deleteCall()?.[2] as { env?: NodeJS.ProcessEnv })?.env?.KIND_EXPERIMENTAL_PROVIDER)
      .toBe('podman')
    expect(mockQuestion).not.toHaveBeenCalled()
  })

  it('honors the YAAC_KIND_CLUSTER override', async () => {
    vi.stubEnv('YAAC_KIND_CLUSTER', 'yaac-alt')
    stageClusters('yaac-alt\n')
    await runClusterDelete({ yes: true })
    expect(deleteCall()?.[1]).toEqual(['delete', 'cluster', '--name', 'yaac-alt'])
  })

  it('reports that there is nothing to delete when the cluster is absent', async () => {
    stageClusters('some-other-cluster\n')
    await runClusterDelete({ yes: true })

    expect(deleteCall()).toBeUndefined()
    expect(logged()).toMatch(/No kind cluster "yaac" to delete/)
  })

  it('treats an empty kind cluster list (no clusters) as nothing to delete', async () => {
    // `kind get clusters` prints this (with spaces) when there are none.
    stageClusters('No kind clusters found.\n')
    await runClusterDelete({ yes: true })
    expect(deleteCall()).toBeUndefined()
  })

  it('prompts and aborts without deleting anything when not confirmed', async () => {
    mockQuestion.mockResolvedValue('n')
    await runClusterDelete({})

    expect(mockQuestion).toHaveBeenCalledOnce()
    expect(deleteCall()).toBeUndefined()
    expect(logged()).toMatch(/Aborted/)
  })

  it('prompts and proceeds when confirmed without --yes', async () => {
    mockQuestion.mockResolvedValue('y')
    await runClusterDelete({})

    expect(mockQuestion).toHaveBeenCalledOnce()
    const prompt = String(mockQuestion.mock.calls[0]?.[0])
    expect(prompt).toMatch(/kind cluster "yaac"/)
    // The registry lives in the cluster and is deleted with it.
    expect(prompt).toMatch(/in-cluster image registry/)
    expect(deleteCall()?.[1]).toEqual(['delete', 'cluster', '--name', 'yaac'])
  })

  it('aborts when there is no TTY to prompt on', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    await runClusterDelete({})
    expect(mockQuestion).not.toHaveBeenCalled()
    expect(deleteCall()).toBeUndefined()
  })

  it('throws a pointed ClusterDeleteError when kind cannot be queried', async () => {
    mockRun.mockRejectedValue(
      Object.assign(new Error('exit 125'), { stderr: 'Cannot connect to podman' }),
    )
    // The subprocess stderr is included in the message.
    await expect(runClusterDelete({ yes: true }))
      .rejects.toThrow(/Could not list kind clusters[\s\S]*Cannot connect to podman/)
  })

  it('falls back to the error message when the failure carries no stderr', async () => {
    // A spawn failure (kind not installed) has no stderr; the error
    // message is reported.
    mockRun.mockRejectedValue(new Error('spawn kind ENOENT'))
    await expect(runClusterDelete({ yes: true }))
      .rejects.toThrow(/Could not list kind clusters[\s\S]*spawn kind ENOENT/)
  })
})
