import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The two boundaries a delete crosses: the kind/podman subprocess and the
// TTY prompt. Nothing inside features/cluster is mocked — the confirmation
// gate runs for real behind the readline fake.
vi.mock('#runtime/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
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

import { ClusterDeleteError, runClusterDelete } from '#runtime/k8s/cluster'
import { execFileAsync } from '#runtime/k8s/substrate/kubectl'

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
  // The dev/test env may itself be a nested yaac session — force the
  // non-nested branch for every case except the nested-guard test.
  vi.stubEnv('YAAC_NESTED', '')
  // A TTY, so the confirmation gate actually prompts.
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('runClusterDelete', () => {
  it('refuses to run inside a nested yaac session', async () => {
    vi.stubEnv('YAAC_NESTED', '1')
    await expect(runClusterDelete({ yes: true })).rejects.toBeInstanceOf(ClusterDeleteError)
    await expect(runClusterDelete({ yes: true })).rejects.toThrow(/nested yaac session/)
    // Nothing touched before the guard.
    expect(mockRun).not.toHaveBeenCalled()
  })

  it('deletes the cluster on the --yes happy path', async () => {
    await runClusterDelete({ yes: true })

    expect(deleteCall()?.[1]).toEqual(['delete', 'cluster', '--name', 'yaac'])
    // Runs kind under the podman provider, like setup.
    expect((deleteCall()?.[2] as { env?: NodeJS.ProcessEnv })?.env?.KIND_EXPERIMENTAL_PROVIDER)
      .toBe('podman')
    // --yes skips the prompt entirely.
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
    // The prompt names both resources it will remove.
    const prompt = String(mockQuestion.mock.calls[0]?.[0])
    expect(prompt).toMatch(/kind cluster "yaac"/)
    // The registry now dies with the cluster, so the prompt says so rather
    // than naming a separate container.
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
    // The subprocess stderr is the useful half of the message.
    await expect(runClusterDelete({ yes: true }))
      .rejects.toThrow(/Could not list kind clusters[\s\S]*Cannot connect to podman/)
  })

  it('falls back to the error message when the failure carries no stderr', async () => {
    // A spawn failure (kind not installed) rejects with an Error and no
    // stderr at all — the message is then all there is to report.
    mockRun.mockRejectedValue(new Error('spawn kind ENOENT'))
    await expect(runClusterDelete({ yes: true }))
      .rejects.toThrow(/Could not list kind clusters[\s\S]*spawn kind ENOENT/)
  })
})
