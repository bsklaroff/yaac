import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ClusterDeleteError,
  runClusterDelete,
  type ClusterDeleteDeps,
} from '#features/cluster/delete'

afterEach(() => {
  vi.unstubAllEnvs()
})

type RunMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>
>>

/** deps.run for a host whose only kind cluster is the default "yaac". */
function happyRun(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (file === 'kind' && args[0] === 'get' && args[1] === 'clusters') {
    return Promise.resolve({ stdout: 'yaac\n', stderr: '' })
  }
  return Promise.resolve({ stdout: '', stderr: '' })
}

function makeDeps(
  overrides: Omit<Partial<ClusterDeleteDeps>, 'run'> & { run?: RunMock } = {},
): ClusterDeleteDeps & { run: RunMock } {
  const run = overrides.run ?? (vi.fn(happyRun) as RunMock)
  return {
    run: run as unknown as ClusterDeleteDeps['run'],
    log: overrides.log ?? vi.fn(),
    confirm: overrides.confirm ?? vi.fn().mockResolvedValue(true),
    removeRegistry: overrides.removeRegistry ?? vi.fn().mockResolvedValue(undefined),
  } as ClusterDeleteDeps & { run: RunMock }
}

/** Find the `kind delete cluster` invocation, if any. */
function deleteCall(run: RunMock): [string, string[], unknown?] | undefined {
  return run.mock.calls.find(([f, a]) => f === 'kind' && a[0] === 'delete') as
    | [string, string[], unknown?]
    | undefined
}

describe('runClusterDelete', () => {
  beforeEach(() => {
    // The dev/test env may itself be a nested yaac session — force the
    // non-nested branch for every case except the nested-guard test.
    vi.stubEnv('YAAC_NESTED', '')
  })

  it('refuses to run inside a nested yaac session', async () => {
    vi.stubEnv('YAAC_NESTED', '1')
    const deps = makeDeps()
    await expect(runClusterDelete({ yes: true }, deps)).rejects.toBeInstanceOf(ClusterDeleteError)
    await expect(runClusterDelete({ yes: true }, deps)).rejects.toThrow(/nested yaac session/)
    // Nothing touched before the guard.
    expect(deps.run).not.toHaveBeenCalled()
    expect(deps.removeRegistry).not.toHaveBeenCalled()
  })

  it('deletes the cluster and removes the registry on the --yes happy path', async () => {
    const deps = makeDeps()
    await runClusterDelete({ yes: true }, deps)

    const del = deleteCall(deps.run)
    expect(del?.[1]).toEqual(['delete', 'cluster', '--name', 'yaac'])
    // Runs kind under the podman provider, like setup.
    expect((del?.[2] as { env?: NodeJS.ProcessEnv })?.env?.KIND_EXPERIMENTAL_PROVIDER).toBe('podman')
    expect(deps.removeRegistry).toHaveBeenCalledOnce()
  })

  it('honors the YAAC_KIND_CLUSTER override', async () => {
    vi.stubEnv('YAAC_KIND_CLUSTER', 'yaac-alt')
    const deps = makeDeps({
      run: vi.fn((file: string, args: string[]) => {
        if (file === 'kind' && args[0] === 'get') {
          return Promise.resolve({ stdout: 'yaac-alt\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      }) as RunMock,
    })
    await runClusterDelete({ yes: true }, deps)
    expect(deleteCall(deps.run)?.[1]).toEqual(['delete', 'cluster', '--name', 'yaac-alt'])
  })

  it('skips the cluster delete but still removes the registry when the cluster is absent', async () => {
    const deps = makeDeps({
      run: vi.fn((file: string, args: string[]) => {
        if (file === 'kind' && args[0] === 'get') {
          return Promise.resolve({ stdout: 'some-other-cluster\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      }) as RunMock,
    })
    await runClusterDelete({ yes: true }, deps)

    expect(deleteCall(deps.run)).toBeUndefined()
    expect(deps.removeRegistry).toHaveBeenCalledOnce()
    expect(vi.mocked(deps.log).mock.calls.flat().join('\n')).toMatch(/No kind cluster "yaac" to delete/)
  })

  it('treats an empty kind cluster list (no clusters) as nothing to delete', async () => {
    const deps = makeDeps({
      run: vi.fn((file: string, args: string[]) => {
        if (file === 'kind' && args[0] === 'get') {
          // `kind get clusters` prints this (with spaces) when there are none.
          return Promise.resolve({ stdout: 'No kind clusters found.\n', stderr: '' })
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      }) as RunMock,
    })
    await runClusterDelete({ yes: true }, deps)
    expect(deleteCall(deps.run)).toBeUndefined()
    expect(deps.removeRegistry).toHaveBeenCalledOnce()
  })

  it('prompts and aborts without deleting anything when not confirmed', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const deps = makeDeps({ confirm })
    await runClusterDelete({}, deps)

    expect(confirm).toHaveBeenCalledOnce()
    expect(deleteCall(deps.run)).toBeUndefined()
    expect(deps.removeRegistry).not.toHaveBeenCalled()
    expect(vi.mocked(deps.log).mock.calls.flat().join('\n')).toMatch(/Aborted/)
  })

  it('prompts and proceeds when confirmed without --yes', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const deps = makeDeps({ confirm })
    await runClusterDelete({}, deps)

    expect(confirm).toHaveBeenCalledOnce()
    // The prompt names both resources it will remove.
    expect(String(confirm.mock.calls[0]?.[0])).toMatch(/kind cluster "yaac"/)
    expect(String(confirm.mock.calls[0]?.[0])).toMatch(/yaac-registry/)
    expect(deleteCall(deps.run)?.[1]).toEqual(['delete', 'cluster', '--name', 'yaac'])
    expect(deps.removeRegistry).toHaveBeenCalledOnce()
  })

  it('throws a pointed ClusterDeleteError when kind cannot be queried', async () => {
    const deps = makeDeps({
      run: vi.fn(() => Promise.reject(
        Object.assign(new Error('exit 125'), { stderr: 'Cannot connect to podman' }),
      )) as RunMock,
    })
    await expect(runClusterDelete({ yes: true }, deps)).rejects.toThrow(/Could not list kind clusters/)
    expect(deps.removeRegistry).not.toHaveBeenCalled()
  })
})
