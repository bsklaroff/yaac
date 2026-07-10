import { describe, it, expect, vi } from 'vitest'
import { ensurePinnedBinary, type PinnedBinaryDeps } from '@yaac/server/lib/k8s/pinned-binary'

type RunMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: { timeout?: number }) => Promise<unknown>
>>

const HELM_PARAMS = {
  bin: 'helm',
  version: 'v3.16.4',
  url: 'https://get.helm.sh/helm-v3.16.4-linux-arm64.tar.gz',
  tarMember: 'linux-arm64/helm',
  stripComponents: 1,
}

function makeDeps(
  overrides: Omit<Partial<PinnedBinaryDeps>, 'run'> & { run?: RunMock } = {},
): PinnedBinaryDeps & { run: RunMock } {
  return {
    run: overrides.run ?? vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    homedir: overrides.homedir ?? ((): string => '/home/tester'),
    fileExists: overrides.fileExists ?? vi.fn().mockResolvedValue(false),
    log: overrides.log,
  }
}

/** run that fails the PATH probe (`command -v <bin>`) and succeeds otherwise. */
function notOnPath(): RunMock {
  return vi.fn((file: string, args: string[]) =>
    file === 'sh' && args[1].startsWith('command -v')
      ? Promise.reject(new Error('not found'))
      : Promise.resolve({ stdout: '', stderr: '' }))
}

describe('ensurePinnedBinary', () => {
  it('prefers a binary on PATH and returns its bare name', async () => {
    const deps = makeDeps()
    await expect(ensurePinnedBinary(HELM_PARAMS, deps)).resolves.toBe('helm')
    expect(deps.run).toHaveBeenCalledWith('sh', ['-c', 'command -v helm'])
    expect(deps.run).toHaveBeenCalledTimes(1)
  })

  it('returns the cached pinned binary without re-downloading', async () => {
    const deps = makeDeps({ run: notOnPath(), fileExists: vi.fn().mockResolvedValue(true) })
    await expect(ensurePinnedBinary(HELM_PARAMS, deps))
      .resolves.toBe('/home/tester/.cache/yaac/bin/helm-v3.16.4')
    // Only the PATH probe ran — no curl.
    expect(deps.run).toHaveBeenCalledTimes(1)
  })

  it('downloads the pinned release into ~/.cache/yaac/bin when absent', async () => {
    const log = vi.fn()
    const deps = makeDeps({ run: notOnPath(), log })
    await expect(ensurePinnedBinary(HELM_PARAMS, deps))
      .resolves.toBe('/home/tester/.cache/yaac/bin/helm-v3.16.4')

    const download = deps.run.mock.calls.find(([f, a]) => f === 'sh' && a[1].includes('curl'))
    expect(download).toBeDefined()
    const script = download![1][1]
    expect(script).toContain("mkdir -p '/home/tester/.cache/yaac/bin'")
    expect(script).toContain(`curl -fsSL '${HELM_PARAMS.url}'`)
    // The two parameterized differences: subdir member + strip-components.
    expect(script).toContain("--strip-components=1 'linux-arm64/helm'")
    expect(script).toContain(
      "mv '/home/tester/.cache/yaac/bin/helm' '/home/tester/.cache/yaac/bin/helm-v3.16.4'")
    expect(script).toContain("chmod +x '/home/tester/.cache/yaac/bin/helm-v3.16.4'")
    expect(download![2]).toEqual({ timeout: 120_000 })
    expect(log).toHaveBeenCalledWith('Downloading pinned helm v3.16.4...')
  })

  it('extracts flat tarballs with no strip flag (the cilium shape)', async () => {
    const log = vi.fn()
    const deps = makeDeps({ run: notOnPath(), log })
    await ensurePinnedBinary({
      bin: 'cilium',
      displayName: 'cilium CLI',
      version: 'v0.19.4',
      url: 'https://example.test/cilium-linux-arm64.tar.gz',
      tarMember: 'cilium',
    }, deps)

    const script = deps.run.mock.calls.find(([f, a]) => f === 'sh' && a[1].includes('curl'))![1][1]
    expect(script).not.toContain('--strip-components')
    expect(script).toContain("-C '/home/tester/.cache/yaac/bin' 'cilium'")
    expect(log).toHaveBeenCalledWith('Downloading pinned cilium CLI v0.19.4...')
  })

  it('stays silent when no log sink is provided', async () => {
    const deps = makeDeps({ run: notOnPath() })
    await expect(ensurePinnedBinary(HELM_PARAMS, deps)).resolves.toContain('helm-v3.16.4')
  })
})
