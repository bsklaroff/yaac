import { describe, it, expect, vi } from 'vitest'
import { RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED, ensureGvisorRuntime, runtimeClassSpec } from '#platform/k8s'
// Internals, for pins only: the release the installer downloads, the paths it
// writes on the node, and the deps seam cluster setup passes it.
import {
  GVISOR_CONTAINERD_MARKER,
  GVISOR_VERSION,
  NODE_RUNSC_CONFIG_PATH,
  NODE_RUNSC_NESTED_CONFIG_PATH,
  NODE_RUNSC_PATH,
  NODE_RUNSC_SHIM_PATH,
  runscShimConfigToml,
  type GvisorSetupDeps,
} from '#platform/k8s/gvisor'

type RunMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>
>>

type Deps = GvisorSetupDeps & {
  run: RunMock
  runStreaming: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  fileExists: ReturnType<typeof vi.fn>
}

/**
 * The boundary is deps: `run`/`runStreaming` are the podman + kubectl child
 * processes cluster setup injects. Everything between — the release URLs and
 * their checksum script, the arch mapping, the shim TOML, the CRI plugin-key
 * probe and the RuntimeClass manifests — runs for real.
 */
function makeDeps(run?: RunMock): Deps {
  const runMock = run ?? (vi.fn(() => Promise.resolve({ stdout: '', stderr: '' })) as RunMock)
  return {
    run: runMock as unknown as GvisorSetupDeps['run'],
    runStreaming: vi.fn(() => Promise.resolve()),
    log: vi.fn(),
    homedir: () => '/home/tester',
    fileExists: vi.fn(() => Promise.resolve(false)),
  } as unknown as Deps
}

/** deps.run for a node that already has this release installed and live. */
function installedNodeRun(arch = 'aarch64'): RunMock {
  return vi.fn((file: string, args: string[]) => {
    const script = args.join(' ')
    if (args.includes('uname')) {
      return Promise.resolve({ stdout: `${arch}\n`, stderr: '' })
    }
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
    if (script.includes('config.toml')) {
      return Promise.resolve({
        stdout: `version = 2\n${GVISOR_CONTAINERD_MARKER}\n`,
        stderr: '',
      })
    }
    return Promise.resolve({ stdout: '', stderr: '' })
  }) as RunMock
}

const argvOf = (deps: Deps): string[] =>
  deps.run.mock.calls.map(([file, args]) => `${file} ${args.join(' ')}`)

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

describe('ensureGvisorRuntime', () => {
  it('downloads the pinned release, installs it on the node, and applies the RuntimeClasses', async () => {
    const deps = makeDeps(vi.fn((file: string, args: string[]) => {
      if (args.includes('uname')) return Promise.resolve({ stdout: 'aarch64\n', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock)
    await ensureGvisorRuntime(['yaac-control-plane'], 'kind-yaac', deps)

    const argv = argvOf(deps)
    // Binaries: fetched from the pinned release for the probed arch, checksum
    // -verified before the rename into the version+arch cache path.
    const scripts = deps.run.mock.calls.filter(([file]) => file === 'sh').map(([, args]) => args[1])
    expect(scripts).toHaveLength(2)
    for (const [file, script] of [['runsc', scripts[0]], ['containerd-shim-runsc-v1', scripts[1]]]) {
      expect(script).toContain(
        `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_VERSION}/aarch64/${file}`)
      expect(script).toContain(`${file}.sha512`)
      expect(script).toMatch(/sha512sum -c|shasum -a 512 -c/)
      expect(script).toContain(`/home/tester/.cache/yaac/bin/${file}-${GVISOR_VERSION}-aarch64`)
    }
    // Node install: cp to a temp name then rename (a live shim holds the old
    // inode, so an in-place copy would be "text file busy").
    expect(argv.some((c) =>
      c.startsWith(`podman cp /home/tester/.cache/yaac/bin/runsc-${GVISOR_VERSION}-aarch64 `
        + `yaac-control-plane:${NODE_RUNSC_PATH}.tmp`))).toBe(true)
    expect(argv.some((c) => c.includes(`mv ${NODE_RUNSC_SHIM_PATH}.tmp ${NODE_RUNSC_SHIM_PATH}`))).toBe(true)

    // Shim configs: systrap, host-uds for the hostPath unix sockets, suid,
    // and root:self overlay (all: would discard session-dir writes). Only the
    // nested handler gets raw/packet sockets.
    const writes = deps.run.mock.calls.map(([, args]) => args.join(' '))
    const defaultCfg = writes.find((c) => c.includes(`> ${NODE_RUNSC_CONFIG_PATH}`))!
    const nestedCfg = writes.find((c) => c.includes(`> ${NODE_RUNSC_NESTED_CONFIG_PATH}`))!
    for (const cfg of [defaultCfg, nestedCfg]) {
      expect(cfg).toContain('[runsc_config]')
      expect(cfg).toContain('platform = "systrap"')
      expect(cfg).toContain('host-uds = "all"')
      expect(cfg).toContain('allow-suid = "true"')
      expect(cfg).toContain('overlay2 = "root:self"')
    }
    expect(defaultCfg).not.toContain('net-raw')
    expect(nestedCfg).toContain('net-raw = "true"')
    expect(nestedCfg).toContain('allow-packet-socket-write = "true"')
    // containerd: both handlers registered under the version-2 CRI plugin key
    // (kind's default), pointed at the shim ConfigPaths, then a restart.
    const append = writes.find((c) => c.includes('>> /etc/containerd/config.toml'))!
    expect(append).toContain(GVISOR_CONTAINERD_MARKER)
    expect(append).toContain('[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]')
    expect(append).toContain('[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc-nested]')
    expect(append).toContain(`ConfigPath = "${NODE_RUNSC_CONFIG_PATH}"`)
    expect(append).toContain(`ConfigPath = "${NODE_RUNSC_NESTED_CONFIG_PATH}"`)
    expect(append.match(/runtime_type = "io\.containerd\.runsc\.v1"/g)).toHaveLength(2)
    // dev.gvisor.* annotations pass through for the graphroot mount options.
    expect(append).toContain('pod_annotations = ["dev.gvisor.*"]')
    expect(argv).toContain('podman exec yaac-control-plane systemctl restart containerd')

    // RuntimeClasses: both, cluster-scoped, applied in the given context.
    expect(deps.runStreaming).toHaveBeenCalledOnce()
    const [file, args, opts] = deps.runStreaming.mock.calls[0] as [string, string[], { input: string }]
    expect(file).toBe('kubectl')
    expect(args).toEqual(['--context', 'kind-yaac', 'apply', '-f', '-'])
    const list = JSON.parse(opts.input) as {
      kind: string
      items: Array<{ apiVersion: string; kind: string; metadata: { name: string }; handler: string }>
    }
    expect(list.kind).toBe('List')
    expect(list.items.map((i) => i.metadata.name))
      .toEqual([RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED])
    expect(list.items.map((i) => i.handler)).toEqual(['runsc', 'runsc-nested'])
    expect(list.items.every((i) => i.apiVersion === 'node.k8s.io/v1' && i.kind === 'RuntimeClass')).toBe(true)
  })

  it('is a no-op (no download, no restart) when the release is installed and its handlers are live', async () => {
    const deps = makeDeps(installedNodeRun())
    deps.fileExists.mockResolvedValue(true)
    await ensureGvisorRuntime(['yaac-control-plane'], 'kind-yaac', deps)

    const argv = argvOf(deps)
    expect(argv.some((c) => c.startsWith('sh -c'))).toBe(false)
    expect(argv.some((c) => c.includes('podman cp'))).toBe(false)
    expect(argv.some((c) => c.includes('restart containerd'))).toBe(false)
    // The RuntimeClasses are still (idempotently) applied.
    expect(deps.runStreaming).toHaveBeenCalledOnce()
  })

  it('restarts containerd when every file is in place but the handlers are not live', async () => {
    // The interrupted-restart state: a changed-only restart would leave
    // `yaac cluster setup --repair` unable to ever repair it.
    const run = vi.fn((file: string, args: string[]) => {
      if (args.join(' ').includes('crictl info')) {
        return Promise.resolve({ stdout: 'handlers=missing\n', stderr: '' })
      }
      return installedNodeRun()(file, args)
    }) as RunMock
    const deps = makeDeps(run)
    deps.fileExists.mockResolvedValue(true)
    await ensureGvisorRuntime(['yaac-control-plane'], 'kind-yaac', deps)

    const argv = argvOf(deps)
    expect(argv.some((c) => c.includes('podman cp'))).toBe(false)
    expect(argv.some((c) => c.includes('restart containerd'))).toBe(true)
  })

  it('registers under the version-3 CRI plugin key when the node config declares it', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      const script = args.join(' ')
      if (args.includes('uname')) return Promise.resolve({ stdout: 'x86_64\n', stderr: '' })
      if (script.includes('config.toml') && !script.includes('>>')) {
        return Promise.resolve({
          stdout: 'version = 3\n[plugins."io.containerd.cri.v1.runtime".containerd]\n',
          stderr: '',
        })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const deps = makeDeps(run)
    deps.fileExists.mockResolvedValue(true)
    await ensureGvisorRuntime(['node-a'], 'kind-yaac', deps)

    const append = deps.run.mock.calls
      .map(([, args]) => args.join(' '))
      .find((c) => c.includes('>> /etc/containerd/config.toml'))
    expect(append).toContain('io.containerd.cri.v1.runtime')
  })

  it('probes arch per node and installs each with its own arch binaries', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (args.includes('uname')) {
        // A mixed-arch node set, in the uname spellings the release names differ from.
        return Promise.resolve({ stdout: args[1] === 'node-a' ? 'amd64\n' : 'arm64\n', stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const deps = makeDeps(run)
    deps.fileExists.mockResolvedValue(true) // binaries cached: no downloads
    await ensureGvisorRuntime(['node-a', 'node-b'], 'kind-yaac', deps)

    const cps = deps.run.mock.calls
      .filter(([file, args]) => file === 'podman' && args[0] === 'cp')
      .map(([, args]) => args.join(' '))
    expect(cps.some((c) => c.includes('node-a:') && c.includes(`-${GVISOR_VERSION}-x86_64`))).toBe(true)
    expect(cps.some((c) => c.includes('node-b:') && c.includes(`-${GVISOR_VERSION}-aarch64`))).toBe(true)
    expect(cps.some((c) => c.includes('node-a:') && c.includes('aarch64'))).toBe(false)
  })

  it('rejects a node architecture the release has no binaries for', async () => {
    const deps = makeDeps(vi.fn(() => Promise.resolve({ stdout: 'riscv64\n', stderr: '' })) as RunMock)
    await expect(ensureGvisorRuntime(['node-a'], 'kind-yaac', deps))
      .rejects.toThrow(/unsupported node architecture/)
  })

  it('does nothing for an empty node list', async () => {
    const deps = makeDeps()
    await ensureGvisorRuntime([], 'kind-yaac', deps)
    expect(deps.run).not.toHaveBeenCalled()
    expect(deps.runStreaming).not.toHaveBeenCalled()
  })
})
