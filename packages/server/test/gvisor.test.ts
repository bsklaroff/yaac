import { describe, it, expect, vi } from 'vitest'
import {
  applyGvisorRuntimeClasses,
  buildRuntimeClassManifests,
  criRuntimesPluginKey,
  ensureGvisorNodeBinaries,
  ensureGvisorRuntime,
  GVISOR_CONTAINERD_MARKER,
  GVISOR_VERSION,
  gvisorContainerdRuntimesToml,
  gvisorNodeArch,
  gvisorReleaseUrl,
  installGvisorOnNode,
  NODE_RUNSC_CONFIG_PATH,
  NODE_RUNSC_NESTED_CONFIG_PATH,
  NODE_RUNSC_PATH,
  NODE_RUNSC_SHIM_PATH,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  runscShimConfigToml,
  runtimeClassSpec,
  type GvisorSetupDeps,
} from '#lib/k8s/gvisor'

type RunMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>
>>

function makeDeps(run?: RunMock): GvisorSetupDeps & {
  run: RunMock
  runStreaming: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  fileExists: ReturnType<typeof vi.fn>
} {
  const runMock = run ?? (vi.fn(() => Promise.resolve({ stdout: '', stderr: '' })) as RunMock)
  return {
    run: runMock as unknown as GvisorSetupDeps['run'],
    runStreaming: vi.fn(() => Promise.resolve()),
    log: vi.fn(),
    homedir: () => '/home/tester',
    fileExists: vi.fn(() => Promise.resolve(false)),
  } as unknown as GvisorSetupDeps & {
    run: RunMock
    runStreaming: ReturnType<typeof vi.fn>
    log: ReturnType<typeof vi.fn>
    fileExists: ReturnType<typeof vi.fn>
  }
}

describe('gvisorReleaseUrl', () => {
  it('points at the pinned release for the given file and arch', () => {
    expect(gvisorReleaseUrl('runsc', 'aarch64')).toBe(
      `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_VERSION}/aarch64/runsc`,
    )
    expect(gvisorReleaseUrl('containerd-shim-runsc-v1', 'x86_64')).toBe(
      `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_VERSION}/x86_64/containerd-shim-runsc-v1`,
    )
  })
})

describe('gvisorNodeArch', () => {
  it('maps uname -m spellings onto the release arch names', () => {
    expect(gvisorNodeArch('aarch64\n')).toBe('aarch64')
    expect(gvisorNodeArch('arm64')).toBe('aarch64')
    expect(gvisorNodeArch('x86_64')).toBe('x86_64')
    expect(gvisorNodeArch('amd64')).toBe('x86_64')
  })

  it('rejects unsupported architectures', () => {
    expect(() => gvisorNodeArch('riscv64')).toThrow(/unsupported node architecture/)
  })
})

describe('runscShimConfigToml', () => {
  it('pins systrap and host-uds for the default handler', () => {
    const toml = runscShimConfigToml('gvisor')
    expect(toml).toContain('[runsc_config]')
    expect(toml).toContain('platform = "systrap"')
    // Load-bearing: the ssh-agent and tmux sockets live on hostPath
    // mounts, and unix sockets on gofer-backed mounts need host-uds to
    // rendezvous outside the sandbox.
    expect(toml).toContain('host-uds = "all"')
    // Both tiers honor the setuid bit — the image's passwordless sudo is a
    // feature (google/gvisor#5299 is gated behind this flag).
    expect(toml).toContain('allow-suid = "true"')
    expect(toml).not.toContain('net-raw')
  })

  it('adds raw/packet socket allowances only on the nested handler', () => {
    const toml = runscShimConfigToml('gvisor-nested')
    expect(toml).toContain('platform = "systrap"')
    expect(toml).toContain('host-uds = "all"')
    expect(toml).toContain('allow-suid = "true"')
    expect(toml).toContain('net-raw = "true"')
    expect(toml).toContain('allow-packet-socket-write = "true"')
  })
})

describe('criRuntimesPluginKey', () => {
  it('detects the version-2 CRI plugin key (kind default)', () => {
    const key = criRuntimesPluginKey('version = 2\n[plugins."io.containerd.grpc.v1.cri".containerd]\n')
    expect(key).toBe('io.containerd.grpc.v1.cri')
  })

  it('detects the version-3 CRI plugin key', () => {
    const key = criRuntimesPluginKey('version = 3\n[plugins."io.containerd.cri.v1.runtime".containerd]\n')
    expect(key).toBe('io.containerd.cri.v1.runtime')
  })
})

describe('gvisorContainerdRuntimesToml', () => {
  it('registers both handlers with their shim ConfigPaths under the given plugin key', () => {
    const toml = gvisorContainerdRuntimesToml('io.containerd.grpc.v1.cri')
    expect(toml).toContain(GVISOR_CONTAINERD_MARKER)
    expect(toml).toContain('[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]')
    expect(toml).toContain('[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc-nested]')
    expect(toml).toContain(`ConfigPath = "${NODE_RUNSC_CONFIG_PATH}"`)
    expect(toml).toContain(`ConfigPath = "${NODE_RUNSC_NESTED_CONFIG_PATH}"`)
    // Every runtime entry is the runsc shim.
    expect(toml.match(/runtime_type = "io\.containerd\.runsc\.v1"/g)).toHaveLength(2)
    // dev.gvisor.* annotations pass through for later per-mount options.
    expect(toml).toContain('pod_annotations = ["dev.gvisor.*"]')
  })
})

describe('runtimeClassSpec', () => {
  it('stamps gvisor by default and gvisor-nested for nested pods', () => {
    expect(runtimeClassSpec({})).toEqual({ runtimeClassName: RUNTIME_CLASS_GVISOR })
    expect(runtimeClassSpec({ nested: true }))
      .toEqual({ runtimeClassName: RUNTIME_CLASS_GVISOR_NESTED })
  })

  it('stamps nothing for inner-yaac pods (the vcluster syncer sets the host runtime)', () => {
    expect(runtimeClassSpec({ inner: true })).toEqual({})
    expect(runtimeClassSpec({ inner: true, nested: true })).toEqual({})
  })
})

describe('buildRuntimeClassManifests', () => {
  it('emits gvisor and gvisor-nested mapped to their handlers', () => {
    const manifests = buildRuntimeClassManifests()
    expect(manifests.map((m) => (m.metadata as { name: string }).name)).toEqual([
      RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED,
    ])
    expect(manifests.map((m) => m.handler)).toEqual(['runsc', 'runsc-nested'])
    for (const m of manifests) {
      expect(m.apiVersion).toBe('node.k8s.io/v1')
      expect(m.kind).toBe('RuntimeClass')
    }
  })
})

describe('ensureGvisorNodeBinaries', () => {
  it('downloads (checksum-verified) into the pinned cache when absent', async () => {
    const deps = makeDeps()
    const { runsc, shim } = await ensureGvisorNodeBinaries('aarch64', deps)

    expect(runsc).toBe(`/home/tester/.cache/yaac/bin/runsc-${GVISOR_VERSION}-aarch64`)
    expect(shim).toBe(`/home/tester/.cache/yaac/bin/containerd-shim-runsc-v1-${GVISOR_VERSION}-aarch64`)
    const scripts = deps.run.mock.calls
      .filter(([file]) => file === 'sh')
      .map(([, args]) => (args)[1])
    expect(scripts).toHaveLength(2)
    expect(scripts[0]).toContain(gvisorReleaseUrl('runsc', 'aarch64'))
    expect(scripts[0]).toContain('.sha512')
    expect(scripts[0]).toMatch(/sha512sum -c|shasum -a 512 -c/)
  })

  it('skips downloads already in the cache', async () => {
    const deps = makeDeps()
    deps.fileExists.mockResolvedValue(true)
    await ensureGvisorNodeBinaries('x86_64', deps)
    expect(deps.run).not.toHaveBeenCalled()
  })
})

/** deps.run mock for a node that already has everything installed. */
function installedNodeRun(): RunMock {
  return vi.fn((file: string, args: string[]) => {
    const script = args.join(' ')
    if (script.includes('--version')) {
      return Promise.resolve({ stdout: `runsc version release-${GVISOR_VERSION}\nspec: 1.2.1\n`, stderr: '' })
    }
    if (script.includes('crictl info')) {
      return Promise.resolve({ stdout: 'handlers=live\n', stderr: '' })
    }
    if (script.includes(`cat ${NODE_RUNSC_CONFIG_PATH}`)) {
      return Promise.resolve({ stdout: runscShimConfigToml('gvisor'), stderr: '' })
    }
    if (script.includes(`cat ${NODE_RUNSC_NESTED_CONFIG_PATH}`)) {
      return Promise.resolve({ stdout: runscShimConfigToml('gvisor-nested'), stderr: '' })
    }
    if (args[1] === 'cat' || args[2] === 'cat' || script.includes('config.toml')) {
      return Promise.resolve({
        stdout: `version = 2\n${gvisorContainerdRuntimesToml('io.containerd.grpc.v1.cri')}`,
        stderr: '',
      })
    }
    return Promise.resolve({ stdout: '', stderr: '' })
  }) as RunMock
}

describe('installGvisorOnNode', () => {
  const binaries = { runsc: '/cache/runsc', shim: '/cache/shim' }

  it('installs binaries, shim configs, and the containerd block, then restarts containerd', async () => {
    const deps = makeDeps()
    await installGvisorOnNode('yaac-control-plane', binaries, deps)

    const calls = deps.run.mock.calls.map(([file, args]) => `${file} ${(args).join(' ')}`)
    // Binaries land via cp-to-temp + rename (a live shim holds the old inode).
    expect(calls.some((c) => c.startsWith(`podman cp /cache/runsc yaac-control-plane:${NODE_RUNSC_PATH}.tmp`))).toBe(true)
    expect(calls.some((c) => c.startsWith(`podman cp /cache/shim yaac-control-plane:${NODE_RUNSC_SHIM_PATH}.tmp`))).toBe(true)
    expect(calls.some((c) => c.includes(`mv ${NODE_RUNSC_PATH}.tmp ${NODE_RUNSC_PATH}`))).toBe(true)
    // Both shim configs written.
    expect(calls.some((c) => c.includes(`> ${NODE_RUNSC_CONFIG_PATH}`))).toBe(true)
    expect(calls.some((c) => c.includes(`> ${NODE_RUNSC_NESTED_CONFIG_PATH}`))).toBe(true)
    // Containerd runtimes appended and containerd restarted.
    expect(calls.some((c) => c.includes('>> /etc/containerd/config.toml'))).toBe(true)
    expect(calls.some((c) => c === 'podman exec yaac-control-plane systemctl restart containerd')).toBe(true)
  })

  it('is a no-op (no restart) when everything is in place AND the handlers are live', async () => {
    const deps = makeDeps(installedNodeRun())
    await installGvisorOnNode('yaac-control-plane', binaries, deps)

    const calls = deps.run.mock.calls.map(([file, args]) => `${file} ${(args).join(' ')}`)
    expect(calls.some((c) => c.includes('podman cp'))).toBe(false)
    expect(calls.some((c) => c.includes('restart containerd'))).toBe(false)
  })

  it('restarts containerd when configs are in place but the handlers are not live', async () => {
    // The interrupted-restart state: every file compares equal, but the
    // running containerd never reloaded — a naive changed-only restart
    // would leave `--repair` unable to repair it.
    const run = vi.fn((file: string, args: string[]) => {
      const script = args.join(' ')
      if (script.includes('crictl info')) {
        return Promise.resolve({ stdout: 'handlers=missing\n', stderr: '' })
      }
      return installedNodeRun()(file, args)
    }) as RunMock
    const deps = makeDeps(run)
    await installGvisorOnNode('yaac-control-plane', binaries, deps)

    const calls = deps.run.mock.calls.map(([file, args]) => `${file} ${(args).join(' ')}`)
    expect(calls.some((c) => c.includes('podman cp'))).toBe(false)
    expect(calls.some((c) => c.includes('restart containerd'))).toBe(true)
  })

  it('picks the version-3 plugin key when the node config declares it', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      const script = args.join(' ')
      if (script.includes('config.toml') && !script.includes('>>')) {
        return Promise.resolve({
          stdout: 'version = 3\n[plugins."io.containerd.cri.v1.runtime".containerd]\n',
          stderr: '',
        })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const deps = makeDeps(run)
    await installGvisorOnNode('node-a', binaries, deps)

    const appendCall = deps.run.mock.calls
      .map(([, args]) => (args).join(' '))
      .find((c) => c.includes('>> /etc/containerd/config.toml'))
    expect(appendCall).toContain('io.containerd.cri.v1.runtime')
  })
})

describe('applyGvisorRuntimeClasses', () => {
  it('applies both RuntimeClasses via kubectl in the given context', async () => {
    const deps = makeDeps()
    await applyGvisorRuntimeClasses('kind-yaac', deps)

    expect(deps.runStreaming).toHaveBeenCalledOnce()
    const [file, args, opts] = deps.runStreaming.mock.calls[0] as [string, string[], { input: string }]
    expect(file).toBe('kubectl')
    expect(args).toEqual(['--context', 'kind-yaac', 'apply', '-f', '-'])
    const list = JSON.parse(opts.input) as { kind: string; items: Array<{ metadata: { name: string } }> }
    expect(list.kind).toBe('List')
    expect(list.items.map((i) => i.metadata.name)).toEqual(['gvisor', 'gvisor-nested'])
  })
})

describe('ensureGvisorRuntime', () => {
  it('probes the node arch, installs on every node, and applies the RuntimeClasses', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (args[3] === '-m' || args.includes('uname')) {
        return Promise.resolve({ stdout: 'aarch64\n', stderr: '' })
      }
      return installedNodeRun()(file, args)
    }) as RunMock
    const deps = makeDeps(run)
    deps.fileExists.mockResolvedValue(true)
    await ensureGvisorRuntime(['node-a', 'node-b'], 'kind-yaac', deps)

    const versionProbes = deps.run.mock.calls
      .map(([, args]) => (args).join(' '))
      .filter((c) => c.includes('--version'))
    expect(versionProbes).toHaveLength(2)
    expect(deps.runStreaming).toHaveBeenCalledOnce()
  })

  it('probes arch per node and installs each node with its own arch binaries', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (args.includes('uname')) {
        // node-a is x86_64, node-b is aarch64 — a mixed-arch node set.
        const arch = args[1] === 'node-a' ? 'x86_64' : 'aarch64'
        return Promise.resolve({ stdout: `${arch}\n`, stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const deps = makeDeps(run)
    deps.fileExists.mockResolvedValue(true) // binaries cached: no downloads
    await ensureGvisorRuntime(['node-a', 'node-b'], 'kind-yaac', deps)

    const cps = deps.run.mock.calls
      .filter(([file, args]) => file === 'podman' && args[0] === 'cp')
      .map(([, args]) => (args).join(' '))
    expect(cps.some((c) => c.includes('node-a:') && c.includes(`-${GVISOR_VERSION}-x86_64`))).toBe(true)
    expect(cps.some((c) => c.includes('node-b:') && c.includes(`-${GVISOR_VERSION}-aarch64`))).toBe(true)
    expect(cps.some((c) => c.includes('node-a:') && c.includes('aarch64'))).toBe(false)
  })

  it('does nothing for an empty node list', async () => {
    const deps = makeDeps()
    await ensureGvisorRuntime([], 'kind-yaac', deps)
    expect(deps.run).not.toHaveBeenCalled()
    expect(deps.runStreaming).not.toHaveBeenCalled()
  })
})
