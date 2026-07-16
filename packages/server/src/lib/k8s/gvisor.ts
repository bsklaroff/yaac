import path from 'node:path'
import { shellQuote } from '#lib/shell'

/**
 * gVisor (runsc) is the runtime for every yaac-managed pod. The sentry is the
 * containment layer for in-container root, which drops the idmapped-mount
 * prerequisite that ruled shared filesystems (NFS) out and takes host-kernel
 * 0-days off the table for the whole fleet. Cluster infrastructure in
 * kube-system (Cilium, CoreDNS, control plane) stays on runc — Cilium IS the
 * host datapath; "everything on gVisor" means every pod yaac creates.
 *
 * This module owns the cluster-setup side: the pinned runsc +
 * containerd-shim-runsc-v1 install on every kind node (pinned-binary
 * convention: downloaded once into ~/.cache/yaac/bin, then copied into the
 * node), the node containerd config patch registering the two runsc
 * handlers, and the RuntimeClass objects the manifest builders reference.
 */

/** Pinned gVisor release installed on every node (runsc + shim together). */
export const GVISOR_VERSION = '20260706.0'

/**
 * RuntimeClass names stamped by the manifest builders. Every pod yaac creates
 * on a real cluster carries one explicitly (cluster check sweeps for strays):
 *  - `gvisor`: the default tier — runsc with systrap; no user namespace.
 *  - `gvisor-nested`: runsc with raw-socket allowances for the in-sandbox
 *    container engine that nested sessions run.
 */
export const RUNTIME_CLASS_GVISOR = 'gvisor'
export const RUNTIME_CLASS_GVISOR_NESTED = 'gvisor-nested'

/**
 * THE runtime-class policy, as a spreadable pod-spec fragment — the single
 * encoding of which tier a yaac-created pod runs on, used by every manifest
 * builder and by the checks that compare against what a builder would stamp:
 *  - `inner`: the pod is created by an inner (nested) yaac against its
 *    vcluster, which has no RuntimeClass objects — stamp nothing; the
 *    vcluster syncer sets the host-side runtime
 *    (sync.toHost.pods.runtimeClassName in k8s/vcluster/values.yaml).
 *  - `nested`: the pod hosts the in-sandbox container engine — the
 *    gvisor-nested tier (raw/packet sockets).
 *  - otherwise: the default gvisor tier.
 * Either way there is no user namespace: the sentry is the containment.
 */
export function runtimeClassSpec(
  opts: { inner?: boolean; nested?: boolean },
): { runtimeClassName?: string } {
  if (opts.inner) return {}
  return {
    runtimeClassName: opts.nested ? RUNTIME_CLASS_GVISOR_NESTED : RUNTIME_CLASS_GVISOR,
  }
}

/** containerd runtime handler names the RuntimeClasses map to. */
export const RUNSC_HANDLER = 'runsc'
export const RUNSC_NESTED_HANDLER = 'runsc-nested'

/** Node paths runsc/shim/config land at (containerd finds the shim on PATH). */
export const NODE_RUNSC_PATH = '/usr/local/bin/runsc'
export const NODE_RUNSC_SHIM_PATH = '/usr/local/bin/containerd-shim-runsc-v1'
export const NODE_RUNSC_CONFIG_PATH = '/etc/containerd/runsc.toml'
export const NODE_RUNSC_NESTED_CONFIG_PATH = '/etc/containerd/runsc-nested.toml'

/** Idempotence marker for the containerd config.toml runtime block. */
export const GVISOR_CONTAINERD_MARKER = '# yaac-gvisor-runtimes'

/** Release-artifact URL (raw binary, with a `.sha512` sibling). */
export function gvisorReleaseUrl(
  file: 'runsc' | 'containerd-shim-runsc-v1',
  arch: 'x86_64' | 'aarch64',
): string {
  return `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_VERSION}/${arch}/${file}`
}

/** Map a node's `uname -m` to gVisor's release-arch naming. */
export function gvisorNodeArch(unameM: string): 'x86_64' | 'aarch64' {
  const m = unameM.trim()
  if (m === 'x86_64' || m === 'amd64') return 'x86_64'
  if (m === 'aarch64' || m === 'arm64') return 'aarch64'
  throw new Error(`unsupported node architecture for gVisor: "${m}"`)
}

/**
 * Shim config (`ConfigPath` in the containerd runtime entry) for one
 * handler. `[runsc_config]` values are flag-name → string pairs runsc is
 * invoked with:
 *  - platform systrap: no /dev/kvm dependency — the known-working platform
 *    for kind nodes (privileged containers).
 *  - host-uds all: unix sockets created on gofer-backed (hostPath) mounts
 *    become real host sockets, so they rendezvous across sandboxes — the
 *    ssh-agent socket (proxy-bound, session-dialed) and the tmux socket both
 *    live on hostPath dirs.
 *  - allow-suid: honor the setuid bit inside the sandbox (gVisor drops it by
 *    default, google/gvisor#5299). The image's passwordless `sudo` is a
 *    feature; this is a euid transition INSIDE the sentry only — the
 *    sandbox's host process stays unprivileged.
 *  - nested additionally allows raw/packet sockets, which the in-sandbox
 *    container engine drives — scoped to this handler.
 */
export function runscShimConfigToml(handler: 'gvisor' | 'gvisor-nested'): string {
  const lines = [
    `# Written by \`yaac cluster setup\` — runsc flags for the "${handler}"`,
    '# RuntimeClass handler. Managed; do not edit.',
    '[runsc_config]',
    '  platform = "systrap"',
    '  host-uds = "all"',
    '  allow-suid = "true"',
  ]
  if (handler === 'gvisor-nested') {
    lines.push('  net-raw = "true"')
    lines.push('  allow-packet-socket-write = "true"')
  }
  return `${lines.join('\n')}\n`
}

/**
 * The CRI plugin key hosting `containerd.runtimes.*` in this node's
 * containerd config: config version 3 (containerd 2.x native) renamed the
 * version-2 `io.containerd.grpc.v1.cri` plugin to
 * `io.containerd.cri.v1.runtime`. kind nodes still ship version-2 configs
 * (containerd migrates internally), so detect by which key the config
 * declares rather than assuming.
 */
export function criRuntimesPluginKey(configToml: string): string {
  return configToml.includes('io.containerd.cri.v1.runtime')
    ? 'io.containerd.cri.v1.runtime'
    : 'io.containerd.grpc.v1.cri'
}

/**
 * The containerd config.toml block registering both runsc handlers,
 * appended once (marker-guarded) to the node config. TOML tables are
 * order-independent, so appending at the end is a legal merge. The
 * `dev.gvisor.*` pod-annotation passthrough lets manifests set per-mount
 * runsc options (e.g. the nested graphroot tmpfs) without another
 * containerd edit.
 */
export function gvisorContainerdRuntimesToml(pluginKey: string): string {
  const rt = (handler: string): string =>
    `plugins."${pluginKey}".containerd.runtimes.${handler}`
  const entry = (handler: string, configPath: string): string[] => [
    `[${rt(handler)}]`,
    '  runtime_type = "io.containerd.runsc.v1"',
    '  pod_annotations = ["dev.gvisor.*"]',
    `  [${rt(handler)}.options]`,
    '    TypeUrl = "io.containerd.runsc.v1.options"',
    `    ConfigPath = "${configPath}"`,
  ]
  return [
    `${GVISOR_CONTAINERD_MARKER} v${GVISOR_VERSION} (written by \`yaac cluster setup\`; do not edit)`,
    ...entry(RUNSC_HANDLER, NODE_RUNSC_CONFIG_PATH),
    ...entry(RUNSC_NESTED_HANDLER, NODE_RUNSC_NESTED_CONFIG_PATH),
  ].join('\n') + '\n'
}

/**
 * The RuntimeClasses every yaac manifest builder stamps. Cluster scoped and
 * install-independent (coexisting installs — the real one plus per-run e2e
 * namespaces — share them), so they carry no install labels and no teardown
 * deletes them.
 */
export function buildRuntimeClassManifests(): Array<Record<string, unknown>> {
  return [
    { name: RUNTIME_CLASS_GVISOR, handler: RUNSC_HANDLER },
    { name: RUNTIME_CLASS_GVISOR_NESTED, handler: RUNSC_NESTED_HANDLER },
  ].map(({ name, handler }) => ({
    apiVersion: 'node.k8s.io/v1',
    kind: 'RuntimeClass',
    metadata: { name },
    handler,
  }))
}

export interface GvisorSetupDeps {
  /** execFile-style runner, injectable for tests. */
  run: (
    file: string,
    args: string[],
    opts?: { timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>
  /** Streaming runner with stdin support (kubectl apply -f -). */
  runStreaming: (
    file: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; input?: string },
  ) => Promise<void>
  log: (message: string) => void
  homedir: () => string
  fileExists: (p: string) => Promise<boolean>
}

/**
 * Download-and-verify script for one release artifact: fetch the binary and
 * its published sha512 into a scratch dir (the checksum file names the
 * artifact's original basename, so verification must happen pre-rename),
 * verify with whichever checksum tool the host has (sha512sum on Linux,
 * shasum on macOS), then move into the pinned cache path.
 */
function downloadScript(url: string, file: string, dest: string): string {
  return [
    'set -e',
    'tmp=$(mktemp -d)',
    'cd "$tmp"',
    `curl -fsSL ${shellQuote(url)} -o ${file}`,
    `curl -fsSL ${shellQuote(`${url}.sha512`)} -o ${file}.sha512`,
    'if command -v sha512sum >/dev/null 2>&1; then'
    + ` sha512sum -c ${file}.sha512 >/dev/null;`
    + ` else shasum -a 512 -c ${file}.sha512 >/dev/null; fi`,
    `chmod 0755 ${file}`,
    `mkdir -p ${shellQuote(path.dirname(dest))}`,
    `mv ${file} ${shellQuote(dest)}`,
    'cd /',
    'rm -rf "$tmp"',
  ].join(' && ')
}

/**
 * Resolve the pinned runsc + shim binaries for the node architecture,
 * downloading (checksum-verified) into ~/.cache/yaac/bin on first use —
 * the pinned-binary convention (cilium CLI, helm), except never taken from
 * PATH: the node needs a specific linux/arch binary regardless of what the
 * host happens to have installed.
 */
export async function ensureGvisorNodeBinaries(
  arch: 'x86_64' | 'aarch64',
  deps: GvisorSetupDeps,
): Promise<{ runsc: string; shim: string }> {
  const binDir = path.join(deps.homedir(), '.cache', 'yaac', 'bin')
  const resolved: Record<string, string> = {}
  for (const file of ['runsc', 'containerd-shim-runsc-v1'] as const) {
    const dest = path.join(binDir, `${file}-${GVISOR_VERSION}-${arch}`)
    if (!(await deps.fileExists(dest))) {
      deps.log(`Downloading pinned ${file} ${GVISOR_VERSION} (${arch})...`)
      await deps.run(
        'sh', ['-c', downloadScript(gvisorReleaseUrl(file, arch), file, dest)],
        { timeout: 300_000 },
      )
    }
    resolved[file] = dest
  }
  return { runsc: resolved['runsc'], shim: resolved['containerd-shim-runsc-v1'] }
}

/**
 * Install runsc + shim + handler configs on one kind node (podman cp/exec —
 * node name == podman container name, the same convention as
 * applyNodeFixups) and register the runtime entries in its containerd
 * config. Idempotent: every piece is compared before writing, and
 * containerd is restarted only when something changed. Unlike the other
 * node fixups this state lives in the node container's filesystem and
 * survives restarts — the install runs in both full setup and `--repair`
 * so existing clusters pick it up on upgrade.
 */
export async function installGvisorOnNode(
  node: string,
  binaries: { runsc: string; shim: string },
  deps: GvisorSetupDeps,
): Promise<void> {
  let changed = false

  const { stdout: versionOut } = await deps.run('podman', [
    'exec', node, 'sh', '-c', `${NODE_RUNSC_PATH} --version 2>/dev/null || true`,
  ])
  if (!versionOut.includes(`release-${GVISOR_VERSION}`)) {
    deps.log(`Installing runsc ${GVISOR_VERSION} on ${node}...`)
    // cp to a temp name, then rename: a live shim holds the old inode, so
    // an in-place copy would fail with "text file busy"; rename is atomic.
    await deps.run('podman', ['cp', binaries.runsc, `${node}:${NODE_RUNSC_PATH}.tmp`])
    await deps.run('podman', ['cp', binaries.shim, `${node}:${NODE_RUNSC_SHIM_PATH}.tmp`])
    await deps.run('podman', ['exec', node, 'sh', '-c',
      `chmod 0755 ${NODE_RUNSC_PATH}.tmp ${NODE_RUNSC_SHIM_PATH}.tmp`
      + ` && mv ${NODE_RUNSC_PATH}.tmp ${NODE_RUNSC_PATH}`
      + ` && mv ${NODE_RUNSC_SHIM_PATH}.tmp ${NODE_RUNSC_SHIM_PATH}`,
    ])
    changed = true
  }

  const shimConfigs: Array<[string, string]> = [
    [NODE_RUNSC_CONFIG_PATH, runscShimConfigToml('gvisor')],
    [NODE_RUNSC_NESTED_CONFIG_PATH, runscShimConfigToml('gvisor-nested')],
  ]
  for (const [configPath, content] of shimConfigs) {
    const { stdout: current } = await deps.run('podman', [
      'exec', node, 'sh', '-c', `cat ${configPath} 2>/dev/null || true`,
    ])
    if (current !== content) {
      await deps.run('podman', [
        'exec', node, 'sh', '-c', `printf '%s' ${shellQuote(content)} > ${configPath}`,
      ])
      changed = true
    }
  }

  const { stdout: containerdConfig } = await deps.run('podman', [
    'exec', node, 'cat', '/etc/containerd/config.toml',
  ])
  if (!containerdConfig.includes(GVISOR_CONTAINERD_MARKER)) {
    const block = gvisorContainerdRuntimesToml(criRuntimesPluginKey(containerdConfig))
    await deps.run('podman', [
      'exec', node, 'sh', '-c',
      `printf '\\n%s' ${shellQuote(block)} >> /etc/containerd/config.toml`,
    ])
    changed = true
  }

  if (!changed) {
    // Files in place does not prove the RUNNING containerd has the
    // handlers: a failed/interrupted restart on a previous run leaves
    // exactly this on-disk state, and skipping the restart on it would
    // make `--repair` (the documented fix) unable to ever repair it. Ask
    // the live CRI which runtimes it registered.
    const { stdout: live } = await deps.run('podman', ['exec', node, 'sh', '-c',
      'out=$(crictl info 2>/dev/null || true); '
      + `{ echo "$out" | grep -q '"${RUNSC_HANDLER}"'; } && `
      + `{ echo "$out" | grep -q '"${RUNSC_NESTED_HANDLER}"'; } && `
      + 'echo handlers=live || echo handlers=missing',
    ])
    if (live.includes('handlers=live')) {
      deps.log(`gVisor ${GVISOR_VERSION} already installed on ${node}.`)
      return
    }
    deps.log(`runsc handlers not registered in the running containerd on ${node} — restarting...`)
  } else {
    deps.log(`Restarting containerd on ${node} to pick up the runsc handlers...`)
  }
  await deps.run('podman', ['exec', node, 'systemctl', 'restart', 'containerd'])
}

/** Apply both RuntimeClasses (idempotent) via kubectl. */
export async function applyGvisorRuntimeClasses(
  kubectlContext: string,
  deps: Pick<GvisorSetupDeps, 'runStreaming'>,
): Promise<void> {
  const list = { apiVersion: 'v1', kind: 'List', items: buildRuntimeClassManifests() }
  await deps.runStreaming(
    'kubectl', ['--context', kubectlContext, 'apply', '-f', '-'],
    { input: JSON.stringify(list) },
  )
}

/**
 * The whole gVisor runtime setup for a cluster: pinned binaries on every
 * node, handler configs + containerd registration, RuntimeClass objects.
 * Called from `yaac cluster setup` (full and --repair).
 */
export async function ensureGvisorRuntime(
  nodes: string[],
  kubectlContext: string,
  deps: GvisorSetupDeps,
): Promise<void> {
  if (nodes.length === 0) return
  // Arch is probed per node (a multi-node set can mix arches); binaries
  // are downloaded once per distinct arch and shared across its nodes.
  const archByNode = new Map<string, 'x86_64' | 'aarch64'>()
  for (const node of nodes) {
    const { stdout } = await deps.run('podman', ['exec', node, 'uname', '-m'])
    archByNode.set(node, gvisorNodeArch(stdout))
  }
  const binariesByArch = new Map<string, { runsc: string; shim: string }>()
  for (const arch of new Set(archByNode.values())) {
    binariesByArch.set(arch, await ensureGvisorNodeBinaries(arch, deps))
  }
  for (const node of nodes) {
    await installGvisorOnNode(node, binariesByArch.get(archByNode.get(node)!)!, deps)
  }
  await applyGvisorRuntimeClasses(kubectlContext, deps)
}
