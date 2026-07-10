import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  CILIUM_CLI_VERSION,
  CILIUM_VERSION,
  ClusterSetupError,
  confirmDefault,
  defaultMachineResources,
  diagnoseKindPodmanSkew,
  effectiveMachineProvider,
  ensureCiliumCli,
  ensurePodmanMachineSetup,
  isLegacyMachineError,
  kindEnv,
  LEGACY_KRUNKIT_WRAPPER,
  runClusterSetup,
  type ClusterSetupDeps,
} from '@yaac/server/lib/k8s/cluster-setup'

afterEach(() => {
  vi.unstubAllEnvs()
})

type RunMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>
>>

type StreamMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; input?: string }) => Promise<void>
>>

/**
 * deps.run responses for a healthy linux host: podman 6 paired with a
 * post-#4203 kind dev build (the skew diagnosis leaves dev builds to the
 * functional probe, which succeeds here).
 */
function happyRun(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (file === 'podman' && args[0] === '--version') {
    return Promise.resolve({ stdout: 'podman version 6.0.0\n', stderr: '' })
  }
  if (file === 'kind' && args[0] === 'version') {
    return Promise.resolve({ stdout: 'kind v0.33.0-alpha.100+f1ec7694f59f57 go1.24.4 linux/arm64\n', stderr: '' })
  }
  if (file === 'kind' && args[0] === 'get' && args[1] === 'clusters') {
    return Promise.resolve({ stdout: '', stderr: '' })
  }
  if (file === 'kind' && args[0] === 'get' && args[1] === 'nodes') {
    return Promise.resolve({ stdout: 'yaac-control-plane\n', stderr: '' })
  }
  if (file === 'sh' && args[1] === 'command -v cilium') {
    return Promise.resolve({ stdout: '/usr/local/bin/cilium\n', stderr: '' })
  }
  return Promise.resolve({ stdout: '', stderr: '' })
}

function makeDeps(
  overrides: Omit<Partial<ClusterSetupDeps>, 'run' | 'runStreaming'> & {
    run?: RunMock
    runStreaming?: StreamMock
  } = {},
): ClusterSetupDeps & { run: RunMock; runStreaming: StreamMock } {
  const run = overrides.run ?? (vi.fn(happyRun) as RunMock)
  const runStreaming = overrides.runStreaming
    ?? (vi.fn(() => Promise.resolve()) as StreamMock)
  return {
    run: run as unknown as ClusterSetupDeps['run'],
    runStreaming,
    log: overrides.log ?? vi.fn(),
    confirm: overrides.confirm ?? vi.fn().mockResolvedValue(false),
    ensureRegistry: overrides.ensureRegistry ?? vi.fn().mockResolvedValue(undefined),
    check: overrides.check ?? vi.fn().mockResolvedValue({ ok: true, results: [] }),
    platform: overrides.platform ?? 'linux',
    homedir: overrides.homedir ?? ((): string => '/home/tester'),
    totalmem: overrides.totalmem ?? ((): number => 64 * 1024 ** 3),
    cpuCount: overrides.cpuCount ?? ((): number => 10),
    readTextFile: overrides.readTextFile
      ?? vi.fn().mockResolvedValue('extraMounts:\n- hostPath: $HOME\n  containerPath: $HOME\n'),
    writeTextFile: overrides.writeTextFile ?? vi.fn().mockResolvedValue(undefined),
    fileExists: overrides.fileExists ?? vi.fn().mockResolvedValue(false),
    listDir: overrides.listDir ?? vi.fn().mockResolvedValue([]),
  } as ClusterSetupDeps & { run: RunMock; runStreaming: StreamMock }
}

describe('runClusterSetup', () => {
  it('runs the full setup in order on a healthy linux host', async () => {
    const deps = makeDeps()
    const ok = await runClusterSetup({}, deps)

    expect(ok).toBe(true)
    expect(deps.ensureRegistry).toHaveBeenCalledOnce()

    // Cluster recreated: delete (best-effort) then create from the bundled
    // config with $HOME substituted, under the podman provider.
    const runCalls = deps.run.mock.calls
    const deleteCall = runCalls.find(([f, a]) => f === 'kind' && a[0] === 'delete')
    expect(deleteCall?.[1]).toEqual(['delete', 'cluster', '--name', 'yaac'])
    const createCall = deps.runStreaming.mock.calls.find(([f, a]) => f === 'kind' && a[0] === 'create')
    expect(createCall).toBeDefined()
    expect(createCall?.[2]?.input).toContain('/home/tester')
    expect(createCall?.[2]?.input).not.toContain('$HOME')
    expect(createCall?.[2]?.env?.KIND_EXPERIMENTAL_PROVIDER).toBe('podman')

    // Cilium installed pinned with the envoy config knob, then waited on.
    const ciliumInstall = deps.runStreaming.mock.calls.find(([, a]) => a[0] === 'install')
    expect(ciliumInstall?.[0]).toBe('cilium')
    expect(ciliumInstall?.[1]).toContain(CILIUM_VERSION)
    expect(ciliumInstall?.[1]).toContain('envoyConfig.enabled=true')
    expect(deps.runStreaming.mock.calls.some(([, a]) => a[0] === 'status' && a.includes('--wait'))).toBe(true)
    expect(runCalls.some(([f, a]) => f === 'kubectl' && a.includes('--for=condition=Ready'))).toBe(true)

    // Node fixups: hosts.toml + sysfs + TasksMax/sysctls via podman exec,
    // then the node container's pids ceiling, then the network connect.
    const execCmds = runCalls
      .filter(([f, a]) => f === 'podman' && a[0] === 'exec')
      .map(([, a]) => a[a.length - 1])
    expect(execCmds.some((c) => c.includes('hosts.toml'))).toBe(true)
    expect(execCmds.some((c) => c.includes('mount -t sysfs'))).toBe(true)
    expect(execCmds.some((c) => c.includes('DefaultTasksMax=infinity'))).toBe(true)
    expect(execCmds.some((c) => c.includes('min_free_kbytes'))).toBe(true)
    expect(execCmds.some((c) => c.includes('src_valid_mark'))).toBe(true)
    expect(runCalls.some(([f, a]) => f === 'podman' && a[0] === 'update' && a.includes('32768'))).toBe(true)
    expect(runCalls.some(([f, a]) => f === 'podman' && a[0] === 'network' && a[1] === 'connect')).toBe(true)

    expect(deps.check).toHaveBeenCalledOnce()
  })

  it('returns false when the finishing cluster check fails', async () => {
    const deps = makeDeps({
      check: vi.fn().mockResolvedValue({
        ok: false,
        results: [{ name: 'probe', status: 'fail', detail: 'x' }],
      }),
    })
    await expect(runClusterSetup({}, deps)).resolves.toBe(false)
  })

  it('honors YAAC_KIND_CLUSTER for every kind invocation', async () => {
    vi.stubEnv('YAAC_KIND_CLUSTER', 'yaac-alt')
    const deps = makeDeps()
    await runClusterSetup({}, deps)
    const kindCalls = deps.run.mock.calls.filter(([f]) => f === 'kind')
    expect(kindCalls.some(([, a]) => a.join(' ') === 'delete cluster --name yaac-alt')).toBe(true)
    expect(kindCalls.some(([, a]) => a.join(' ') === 'get nodes --name yaac-alt')).toBe(true)
  })

  it('reports every missing binary at once', async () => {
    const run = vi.fn((file: string) => {
      if (file === 'podman' || file === 'kind' || file === 'kubectl') {
        return Promise.reject(new Error('ENOENT'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const deps = makeDeps({ run })
    const err = await runClusterSetup({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    const msg = (err as Error).message
    expect(msg).toContain('Missing required tools')
    expect(msg).toContain('podman')
    expect(msg).toContain('kind')
    expect(msg).toContain('kubectl')
    // Nothing was mutated.
    expect(deps.ensureRegistry).not.toHaveBeenCalled()
    expect(deps.runStreaming).not.toHaveBeenCalled()
  })

  it('diagnoses the podman-6/kind-0.32 skew before touching anything', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'podman version 6.0.0\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'kind v0.32.0 go1.24.4 darwin/arm64\n', stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const deps = makeDeps({ run })
    const err = await runClusterSetup({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('yaac-kind')
    expect(deps.ensureRegistry).not.toHaveBeenCalled()
  })

  it('surfaces a functional preflight failure with the kind stderr', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'podman version 5.8.1\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'kind v0.32.0 go1.24.4 linux/arm64\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'get' && args[1] === 'clusters') {
        return Promise.reject(Object.assign(new Error('exit 125'), { stderr: 'cannot connect to podman' }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const err = await runClusterSetup({}, makeDeps({ run })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('kind get clusters')
    expect((err as Error).message).toContain('cannot connect to podman')
    expect((err as Error).message).not.toContain('kind#4203')
  })

  it('fails with the rootful-podman fix when the rootful socket is unreachable', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'podman version 6.0.0\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'kind v0.33.0-alpha go1.24.4 linux/arm64\n', stderr: '' })
      }
      if (file === 'podman' && args[0] === 'info') {
        return Promise.reject(Object.assign(new Error('exit 125'), { stderr: 'cannot connect' }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const err = await runClusterSetup({}, makeDeps({ run, platform: 'linux' })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('systemctl enable --now podman.socket')
  })

  it('adds the skew hint to a probe failure when the kind alpha may predate the fix', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'podman version 6.0.0\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'kind v0.33.0-alpha go1.26.4 darwin/arm64\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'get' && args[1] === 'clusters') {
        return Promise.reject(Object.assign(new Error('exit 125'), { stderr: 'failed to list clusters' }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const err = await runClusterSetup({}, makeDeps({ run })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('kind#4203')
    expect((err as Error).message).toContain('bsklaroff/yaac/yaac-kind')
  })

  it('--repair re-applies fixups without recreating the cluster', async () => {
    const deps = makeDeps()
    const ok = await runClusterSetup({ repair: true }, deps)

    expect(ok).toBe(true)
    expect(deps.ensureRegistry).toHaveBeenCalledOnce()
    // No delete/create/cilium — only the fixups and the finishing check.
    expect(deps.run.mock.calls.some(([f, a]) => f === 'kind' && a[0] === 'delete')).toBe(false)
    expect(deps.runStreaming).not.toHaveBeenCalled()
    expect(deps.run.mock.calls.some(([f, a]) => f === 'podman' && a[0] === 'exec')).toBe(true)
    expect(deps.check).toHaveBeenCalledOnce()
  })

  it('--repair fails fast (before any mutation) when the cluster does not exist', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'kind' && args[0] === 'get' && args[1] === 'nodes') {
        return Promise.resolve({ stdout: '', stderr: 'No kind nodes found for cluster "yaac".' })
      }
      return happyRun(file, args)
    }) as RunMock
    const deps = makeDeps({ run })
    const err = await runClusterSetup({ repair: true }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('not found')
    expect(deps.ensureRegistry).not.toHaveBeenCalled()
  })

  it('refuses to run inside a nested yaac session', async () => {
    vi.stubEnv('YAAC_NESTED', '1')
    const deps = makeDeps()
    const err = await runClusterSetup({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('nested')
    expect(deps.run).not.toHaveBeenCalled()
  })
})

describe('diagnoseKindPodmanSkew', () => {
  it('flags podman >= 6 with a kind release <= v0.32.0', () => {
    const msg = diagnoseKindPodmanSkew('podman version 6.0.0', 'kind v0.32.0 go1.24.4 darwin/arm64')
    expect(msg).toContain('kind#4201')
    expect(msg).toContain('bsklaroff/yaac/yaac-kind')
  })

  it('leaves the bare v0.33.0-alpha to the functional probe (may carry the fix)', () => {
    expect(diagnoseKindPodmanSkew('podman version 6.1.0', 'kind v0.33.0-alpha go1.24 linux/amd64'))
      .toBeNull()
  })

  it('is silent for podman 5.x with any kind', () => {
    expect(diagnoseKindPodmanSkew('podman version 5.8.1', 'kind v0.32.0 go1.24 linux/amd64')).toBeNull()
  })

  it('leaves dev builds with a commit suffix to the functional probe', () => {
    expect(diagnoseKindPodmanSkew(
      'podman version 6.0.0',
      'kind v0.33.0-alpha.100+f1ec7694f59f57 go1.24 linux/arm64',
    )).toBeNull()
  })

  it('is silent for kind releases past the fix', () => {
    expect(diagnoseKindPodmanSkew('podman version 6.0.0', 'kind v0.33.0 go1.24 linux/amd64')).toBeNull()
  })

  it('is silent on unparseable version output', () => {
    expect(diagnoseKindPodmanSkew('garbage', 'garbage')).toBeNull()
  })
})

describe('ensureCiliumCli', () => {
  it('prefers a cilium on PATH', async () => {
    const deps = makeDeps()
    await expect(ensureCiliumCli(deps)).resolves.toBe('cilium')
  })

  it('returns the cached pinned binary without re-downloading', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'sh' && args[1] === 'command -v cilium') {
        return Promise.reject(new Error('not found'))
      }
      return happyRun(file, args)
    }) as RunMock
    const deps = makeDeps({ run, fileExists: vi.fn().mockResolvedValue(true) })
    const bin = await ensureCiliumCli(deps)
    expect(bin).toBe(`/home/tester/.cache/yaac/bin/cilium-${CILIUM_CLI_VERSION}`)
    expect(run.mock.calls.filter(([f]) => f === 'sh')).toHaveLength(1)
  })

  it('downloads the pinned release when absent', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'sh' && args[1] === 'command -v cilium') {
        return Promise.reject(new Error('not found'))
      }
      return happyRun(file, args)
    }) as RunMock
    const deps = makeDeps({ run })
    const bin = await ensureCiliumCli(deps)
    expect(bin).toContain(`cilium-${CILIUM_CLI_VERSION}`)
    const download = run.mock.calls.find(([f, a]) => f === 'sh' && a[1].includes('curl'))
    expect(download?.[1][1]).toContain(`cilium-cli/releases/download/${CILIUM_CLI_VERSION}`)
  })
})

describe('effectiveMachineProvider', () => {
  it('returns undefined with no sources', () => {
    expect(effectiveMachineProvider([])).toBeUndefined()
  })

  it('reads the provider from a base containers.conf', () => {
    expect(effectiveMachineProvider(['[machine]\nprovider = "libkrun"\n'])).toBe('libkrun')
  })

  it('lets later drop-ins override earlier sources', () => {
    expect(effectiveMachineProvider([
      '[machine]\nprovider = "applehv"\n',
      '[machine]\nprovider = "libkrun"\n',
    ])).toBe('libkrun')
  })

  it('skips unparseable sources without losing earlier values', () => {
    expect(effectiveMachineProvider([
      '[machine]\nprovider = "libkrun"\n',
      'not [ valid toml',
    ])).toBe('libkrun')
  })

  it('ignores sources without a machine provider', () => {
    expect(effectiveMachineProvider(['[engine]\nfoo = "bar"\n'])).toBeUndefined()
  })
})

describe('isLegacyMachineError', () => {
  it.each([
    'Error: machine was created with an older version of podman',
    'machine config is incompatible with this podman',
    'please run podman machine reset',
    'the machine needs to be recreated',
  ])('matches %j', (stderr) => {
    expect(isLegacyMachineError(stderr)).toBe(true)
  })

  it('does not match unrelated start failures', () => {
    expect(isLegacyMachineError('Error: unable to start krunkit: exec format error')).toBe(false)
  })
})

describe('defaultMachineResources', () => {
  it('matches the README canon (8 cpus / 32 GiB) on a big host', () => {
    expect(defaultMachineResources(128 * 1024 ** 3, 12)).toEqual({ cpus: 8, memoryMib: 32768 })
  })

  it('halves the host memory on smaller machines', () => {
    expect(defaultMachineResources(16 * 1024 ** 3, 4)).toEqual({ cpus: 4, memoryMib: 8192 })
  })

  it('floors at 2 cpus / 4 GiB', () => {
    expect(defaultMachineResources(4 * 1024 ** 3, 1)).toEqual({ cpus: 2, memoryMib: 4096 })
  })
})

describe('ensurePodmanMachineSetup', () => {
  function darwinDeps(
    overrides: Omit<Partial<ClusterSetupDeps>, 'run' | 'runStreaming'> & {
      run?: RunMock
      runStreaming?: StreamMock
    } = {},
  ): ClusterSetupDeps & { run: RunMock; runStreaming: StreamMock } {
    return makeDeps({ platform: 'darwin', ...overrides })
  }

  /** machine list responses: first call, then all later calls. */
  function machineRun(
    first: object[],
    later: object[],
    extra?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }> | null,
  ): RunMock {
    let listCalls = 0
    return vi.fn(async (file: string, args: string[]) => {
      if (file === 'podman' && args[0] === 'machine' && args[1] === 'list') {
        listCalls += 1
        return { stdout: JSON.stringify(listCalls === 1 ? first : later), stderr: '' }
      }
      const handled = extra?.(file, args)
      if (handled) return handled
      return happyRun(file, args)
    }) as RunMock
  }

  it('throws when the legacy krunkit --timesync wrapper is present', async () => {
    const deps = darwinDeps({
      fileExists: vi.fn((p: string) => Promise.resolve(p === LEGACY_KRUNKIT_WRAPPER)),
    })
    const err = await ensurePodmanMachineSetup(deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('krunkit-real')
    expect((err as Error).message).toContain('mv ')
  })

  it('writes the libkrun drop-in and inits a rootful machine when none exists', async () => {
    const run = machineRun([], [{ Name: 'podman-machine-default', Running: false, Default: true }])
    const deps = darwinDeps({ run })
    await ensurePodmanMachineSetup(deps)

    // Provider drop-in written (no containers.conf on disk in this test).
    const write = vi.mocked(deps.writeTextFile).mock.calls[0]
    expect(write[0]).toContain('containers.conf.d/99-yaac-machine-provider.conf')
    expect(write[1]).toContain('provider = "libkrun"')

    // init --rootful with scaled resources, then start.
    const init = deps.runStreaming.mock.calls.find(([, a]) => a[1] === 'init')
    expect(init?.[1]).toContain('--rootful')
    expect(run.mock.calls.some(([f, a]) => f === 'podman' && a[1] === 'start')).toBe(true)
  })

  it('does not write a drop-in when the provider is already libkrun', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'libkrun' }],
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'libkrun' }],
      (file, args) => {
        if (file === 'podman' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: JSON.stringify([{ Rootful: true }]), stderr: '' })
        }
        return null
      },
    )
    const deps = darwinDeps({
      run,
      readTextFile: vi.fn((p: string) => Promise.resolve(
        p.endsWith('containers.conf') ? '[machine]\nprovider = "libkrun"\n' : null,
      )),
    })
    await ensurePodmanMachineSetup(deps)
    expect(deps.writeTextFile).not.toHaveBeenCalled()
    // Already rootful and running: nothing to stop/set/start.
    expect(run.mock.calls.some(([f, a]) => f === 'podman' && a[1] === 'start')).toBe(false)
  })

  it('stops, sets --rootful, and restarts a rootless machine', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'libkrun' }],
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      (file, args) => {
        if (file === 'podman' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: JSON.stringify([{ Rootful: false }]), stderr: '' })
        }
        return null
      },
    )
    const deps = darwinDeps({ run })
    await ensurePodmanMachineSetup(deps)
    const podmanMachineCalls = run.mock.calls
      .filter(([f, a]) => f === 'podman' && a[0] === 'machine')
      .map(([, a]) => a.slice(1).join(' '))
    expect(podmanMachineCalls).toContain('stop podman-machine-default')
    expect(podmanMachineCalls).toContain('set --rootful podman-machine-default')
    expect(podmanMachineCalls).toContain('start')
  })

  it('prompts before replacing a machine on another provider, and throws when declined', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'applehv' }],
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'applehv' }],
    )
    const deps = darwinDeps({ run, confirm: vi.fn().mockResolvedValue(false) })
    const err = await ensurePodmanMachineSetup(deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('applehv')
    expect(run.mock.calls.some(([f, a]) => f === 'podman' && a[1] === 'rm')).toBe(false)
  })

  it('replaces a machine on another provider when confirmed', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'applehv' }],
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
    )
    const deps = darwinDeps({ run, confirm: vi.fn().mockResolvedValue(true) })
    await ensurePodmanMachineSetup(deps)
    expect(run.mock.calls.some(([f, a]) =>
      f === 'podman' && a.join(' ') === 'machine rm -f podman-machine-default')).toBe(true)
    expect(deps.runStreaming.mock.calls.some(([, a]) => a[1] === 'init')).toBe(true)
  })

  it('recreates a machine provisioned by an older podman when start trips the version gate', async () => {
    let startCalls = 0
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      (file, args) => {
        if (file === 'podman' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: JSON.stringify([{ Rootful: true }]), stderr: '' })
        }
        if (file === 'podman' && args[1] === 'start') {
          startCalls += 1
          if (startCalls === 1) {
            return Promise.reject(Object.assign(new Error('exit 125'), {
              stderr: 'Error: machine was created with an older version of podman, please run podman machine reset',
            }))
          }
          return Promise.resolve({ stdout: '', stderr: '' })
        }
        return null
      },
    )
    const deps = darwinDeps({ run, confirm: vi.fn().mockResolvedValue(true) })
    await ensurePodmanMachineSetup(deps)
    expect(run.mock.calls.some(([f, a]) =>
      f === 'podman' && a.join(' ') === 'machine rm -f podman-machine-default')).toBe(true)
    expect(deps.runStreaming.mock.calls.some(([, a]) => a[1] === 'init')).toBe(true)
    expect(startCalls).toBe(2)
  })

  it('surfaces non-legacy start failures as-is', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      (file, args) => {
        if (file === 'podman' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: JSON.stringify([{ Rootful: true }]), stderr: '' })
        }
        if (file === 'podman' && args[1] === 'start') {
          return Promise.reject(Object.assign(new Error('exit 1'), { stderr: 'krunkit crashed' }))
        }
        return null
      },
    )
    const deps = darwinDeps({ run })
    const err = await ensurePodmanMachineSetup(deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterSetupError)
    expect((err as Error).message).toContain('krunkit crashed')
    expect(deps.confirm).not.toHaveBeenCalled()
  })
})

describe('kindEnv', () => {
  it('forwards the host env and forces the podman provider', () => {
    vi.stubEnv('YAAC_KINDENV_PROBE', 'present')
    const e = kindEnv()
    expect(e.KIND_EXPERIMENTAL_PROVIDER).toBe('podman')
    expect(e.YAAC_KINDENV_PROBE).toBe('present')
    vi.unstubAllEnvs()
  })
})

describe('confirmDefault', () => {
  it('returns false without prompting when stdin is not a TTY', async () => {
    const original = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
      await expect(confirmDefault('proceed?')).resolves.toBe(false)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true })
    }
  })
})
