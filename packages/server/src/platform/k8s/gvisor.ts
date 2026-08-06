import { shellQuote } from '#platform/shell'
import type { PodToleration } from './taints'

/**
 * gVisor (runsc) is the runtime for every pod that hosts UNTRUSTED code:
 * session pods (agents run arbitrary commands; in-container root via the
 * image's passwordless sudo is a feature) and vcluster-synced tenant pods.
 * The sentry is the containment layer for in-container root, which drops
 * the idmapped-mount prerequisite that ruled shared filesystems (NFS) out
 * and takes host-kernel 0-days off the table for those workloads.
 *
 * Trusted yaac infrastructure — the proxy, project registries, node-write
 * pods, vcluster control planes, and the installer below — runs on runc,
 * like kube-system. It only runs yaac-shipped code, so the sentry buys no
 * containment there, and its cost is real: each sandbox is a systrap sentry
 * + gofer (hundreds of threads, heavy sys-time), and a fleet of them
 * starved an 8-core node to load ~40 with multi-second kubectl execs and
 * pods stuck terminating for minutes.
 *
 * This module owns the runtime's *vocabulary*: the pinned release, the node
 * paths and containerd wiring the install produces, the shell program that
 * produces them, and the RuntimeClass objects the manifest builders
 * reference. The install itself is a privileged DaemonSet
 * (features/cluster/gvisor-installer.ts) that runs this program on every
 * node it lands on — nothing here execs a node.
 */

/** Pinned gVisor release installed on every node (runsc + shim together). */
export const GVISOR_VERSION = '20260706.0'

/** Release-artifact directory (each file has a `.sha512` sibling). */
export const GVISOR_RELEASE_BASE =
  `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_VERSION}`

/**
 * RuntimeClass names stamped by the manifest builders. Every UNTRUSTED pod
 * yaac creates on a real cluster carries one explicitly (cluster check
 * sweeps for strays); infra pods stamp none (runc via the cluster default):
 *  - `gvisor`: the default sandboxed tier — runsc with systrap; no user
 *    namespace.
 *  - `gvisor-nested`: runsc with raw-socket allowances for the in-sandbox
 *    container engine that nested sessions run.
 */
export const RUNTIME_CLASS_GVISOR = 'gvisor'
export const RUNTIME_CLASS_GVISOR_NESTED = 'gvisor-nested'

/**
 * Node label the installer stamps once the runtime is live on that node,
 * and the ONLY thing the RuntimeClasses schedule on. Two labels, because
 * they answer different questions: the boolean is the scheduling gate (a
 * node either can run sandboxed pods or must not be sent any), and the
 * version is what a coverage probe or a rollout reads to see which nodes
 * are still on the old runsc.
 *
 * Keyed on the runtime, NOT on a node pool: the installer decides where it
 * runs (its own `nodeSelector`), and pods follow wherever it succeeded.
 * Restricting sandboxed workloads to a sessions-only pool is then a change
 * to the installer's selector alone, with nothing here to touch.
 */
export const GVISOR_NODE_LABEL = 'yaac.gvisor'
export const GVISOR_NODE_VERSION_LABEL = 'yaac.gvisor-version'

/** The labels the installer patches onto its node after a successful pass. */
export function gvisorNodeLabels(): Record<string, string> {
  return {
    [GVISOR_NODE_LABEL]: 'true',
    [GVISOR_NODE_VERSION_LABEL]: GVISOR_VERSION,
  }
}

/**
 * THE runtime-class policy for SESSION-TIER pods (pods that run untrusted
 * agent workloads, and the check probes that emulate them), as a spreadable
 * pod-spec fragment — the single encoding of which sandbox tier such a pod
 * runs on, used by the session manifest builder and by the checks that
 * compare against what it would stamp:
 *  - `inner`: the pod is created by an inner (nested) yaac against its
 *    vcluster, which has no RuntimeClass objects — stamp nothing; the
 *    vcluster syncer sets the host-side runtime
 *    (sync.toHost.pods.runtimeClassName in k8s/vcluster/values.yaml).
 *  - `nested`: the pod hosts the in-sandbox container engine — the
 *    gvisor-nested tier (raw/packet sockets).
 *  - otherwise: the default gvisor tier.
 * Either way there is no user namespace: the sentry is the containment.
 * Trusted infra pods (proxy, registries, node-write, vcluster control
 * planes) don't call this — they stamp nothing and run on runc (see the
 * module doc).
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

/** Node directories the installer writes, and where its pod sees them. */
export const INSTALLER_HOST_PREFIX = '/host'
export const NODE_BIN_DIR = '/usr/local/bin'
export const NODE_CONTAINERD_DIR = '/etc/containerd'
/** Node-local cache of the verified release + the installed-version marker.
 *  Node-local (not the server's ~/.cache) because the server has no
 *  filesystem in common with a node it cannot exec into; a node that keeps
 *  its disk across a restart therefore re-runs the install for free. */
export const NODE_GVISOR_CACHE_DIR = '/var/lib/yaac/gvisor'

/** Node paths runsc/shim/config land at (containerd finds the shim on PATH). */
export const NODE_RUNSC_PATH = `${NODE_BIN_DIR}/runsc`
export const NODE_RUNSC_SHIM_PATH = `${NODE_BIN_DIR}/containerd-shim-runsc-v1`
export const NODE_RUNSC_CONFIG_PATH = `${NODE_CONTAINERD_DIR}/runsc.toml`
export const NODE_RUNSC_NESTED_CONFIG_PATH = `${NODE_CONTAINERD_DIR}/runsc-nested.toml`
export const NODE_CONTAINERD_CONFIG_PATH = `${NODE_CONTAINERD_DIR}/config.toml`

/** Readiness marker (in a pod-local emptyDir): written after a pass that got
 *  the runtime live on this node, removed when the installer exits. */
export const GVISOR_INSTALLER_STATE_DIR = '/run/yaac-gvisor'
export const GVISOR_INSTALLER_READY_FILE = `${GVISOR_INSTALLER_STATE_DIR}/.ready`

/** Idempotence marker for the containerd config.toml runtime block. */
export const GVISOR_CONTAINERD_MARKER = '# yaac-gvisor-runtimes'

/** How long the installer waits between converge passes. Long: a steady
 *  state is a handful of stats, and the pass exists to heal a node someone
 *  wiped under us, not to poll for work. */
export const GVISOR_INSTALLER_INTERVAL_S = 600

/** How old the node's install lock must be before a waiter breaks it. Above
 *  the worst honest pass (a ~60 MB download plus a containerd restart), so
 *  only a pod that died holding the lock is ever broken. */
export const GVISOR_INSTALL_LOCK_TIMEOUT_S = 900

/**
 * The node filesystem the install script needs, as pod volumes + mounts —
 * kept here with the paths themselves so the script and the pod that runs
 * it can never disagree about where the node is.
 *
 * Three narrow directories rather than the node root: the installer is a
 * privileged pod (it enters PID 1's mount namespace to restart containerd),
 * so this is not a containment boundary — it is an audit one. What yaac
 * writes on a node is exactly the runtime binaries, the two handler flag
 * files plus the containerd config beside them, and its own cache.
 */
export function gvisorInstallerHostMounts(): {
  volumes: Array<Record<string, unknown>>
  volumeMounts: Array<Record<string, unknown>>
} {
  const dirs: Array<[string, string]> = [
    ['node-bin', NODE_BIN_DIR],
    ['node-containerd', NODE_CONTAINERD_DIR],
    ['gvisor-cache', NODE_GVISOR_CACHE_DIR],
  ]
  return {
    volumes: [
      ...dirs.map(([name, dir]) => ({
        name,
        hostPath: { path: dir, type: 'DirectoryOrCreate' },
      })),
      // The readiness marker: pod-local, so it dies with the pod rather than
      // outliving it as a claim about the node. Within one pod it is only as
      // good as the EXIT trap that clears it — a container killed outright
      // (OOM, SIGKILL) runs no trap, so its replacement can be Ready for the
      // length of its first converge pass. Harmless: that pass is what would
      // have re-established the claim anyway.
      { name: 'state', emptyDir: {} },
    ],
    volumeMounts: [
      ...dirs.map(([name, dir]) => ({
        name,
        mountPath: `${INSTALLER_HOST_PREFIX}${dir}`,
      })),
      { name: 'state', mountPath: GVISOR_INSTALLER_STATE_DIR },
    ],
  }
}

/**
 * Shim config (`ConfigPath` in the containerd runtime entry) for one
 * handler. `[runsc_config]` values are flag-name → string pairs runsc is
 * invoked with:
 *  - platform systrap: no /dev/kvm dependency — the known-working platform
 *    for kind nodes (privileged containers).
 *  - host-uds all: unix sockets created on gofer-backed (hostPath) mounts
 *    become real host sockets, so they rendezvous across sandboxes — the
 *    tmux socket lives on a hostPath dir and is opened by host-side probes.
 *    (ssh-agent forwarding no longer needs this: the agent is reached over
 *    the proxy's ssh-agent port and re-exposed on a pod-local socket.)
 *  - allow-suid: honor the setuid bit inside the sandbox (gVisor drops it by
 *    default, google/gvisor#5299). The image's passwordless `sudo` is a
 *    feature; this is a euid transition INSIDE the sentry only — the
 *    sandbox's host process stays unprivileged.
 *  - overlay2 root:self: back the container ROOTFS's writable layer with a
 *    sentry-internal overlay paged against a filestore in the rootfs dir,
 *    so rootfs writes (/tmp, in-session apt installs, …) never round-trip
 *    the gofer. Rootfs-only on purpose: `all:` would wrap hostPath volumes
 *    too, making session-dir and shared-image-store writes ephemeral.
 *    Rootfs writes were already ephemeral (containerd discards the
 *    snapshot), so this changes performance, not semantics.
 *  - nested additionally allows raw/packet sockets, which the in-sandbox
 *    container engine drives — scoped to this handler.
 */
export function runscShimConfigToml(handler: 'gvisor' | 'gvisor-nested'): string {
  const lines = [
    `# Written by the yaac gVisor installer — runsc flags for the "${handler}"`,
    '# RuntimeClass handler. Managed; do not edit.',
    '[runsc_config]',
    '  platform = "systrap"',
    '  host-uds = "all"',
    '  allow-suid = "true"',
    '  overlay2 = "root:self"',
  ]
  if (handler === 'gvisor-nested') {
    lines.push('  net-raw = "true"')
    lines.push('  allow-packet-socket-write = "true"')
  }
  return `${lines.join('\n')}\n`
}

/**
 * The CRI plugin key hosting `containerd.runtimes.*` in a node's containerd
 * config: config version 3 (containerd 2.x native) renamed the version-2
 * `io.containerd.grpc.v1.cri` plugin to `io.containerd.cri.v1.runtime`.
 * kind nodes still ship version-2 configs (containerd migrates internally)
 * and managed node images vary, so the installer picks by which key the
 * node's own config declares rather than assuming — both blocks are
 * rendered into its script and the node chooses at run time.
 */
export const CRI_PLUGIN_KEY_V2 = 'io.containerd.grpc.v1.cri'
export const CRI_PLUGIN_KEY_V3 = 'io.containerd.cri.v1.runtime'

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
    `${GVISOR_CONTAINERD_MARKER} v${GVISOR_VERSION} (written by the yaac gVisor installer; do not edit)`,
    ...entry(RUNSC_HANDLER, NODE_RUNSC_CONFIG_PATH),
    ...entry(RUNSC_NESTED_HANDLER, NODE_RUNSC_NESTED_CONFIG_PATH),
  ].join('\n') + '\n'
}

/**
 * The RuntimeClasses every yaac manifest builder stamps. Cluster scoped and
 * install-independent (coexisting installs — the real one plus per-run e2e
 * namespaces — share them), so they carry no install labels and no teardown
 * deletes them.
 *
 * `scheduling.nodeSelector` is the reason the installer labels nodes: the
 * RuntimeClass admission controller merges it into every pod that names the
 * class, so a sandboxed pod can only land where the shim actually exists.
 * Without it a session pod scheduled onto an un-installed node fails at
 * container create with a bare "failed to get sandbox runtime" — and on a
 * pool being recycled, intermittently. With it, such a pod sits Pending
 * with an unsatisfied-node-selector event, which says what is wrong.
 *
 * `scheduling.tolerations` rides the same merge, and is how a dedicated
 * sessions pool works at all. The pool is tainted so nothing else drifts
 * onto it; declaring that taint's toleration HERE — once — reaches every
 * pod that names the class: session pods, builder pods, vcluster-synced
 * tenant pods, and cluster check's pinned probes (which bypass the
 * scheduler, but are still admitted by kubelet, and a `NoExecute` pool taint
 * would evict them). Nothing per-pod has to know the pool exists. Empty by
 * default — an untainted cluster (every local one) needs none, and cluster
 * check reads this same field to decide which nodes a session can use.
 */
export function buildRuntimeClassManifests(
  opts: { tolerations?: PodToleration[] } = {},
): Array<Record<string, unknown>> {
  const tolerations = opts.tolerations ?? []
  return [
    { name: RUNTIME_CLASS_GVISOR, handler: RUNSC_HANDLER },
    { name: RUNTIME_CLASS_GVISOR_NESTED, handler: RUNSC_NESTED_HANDLER },
  ].map(({ name, handler }) => ({
    apiVersion: 'node.k8s.io/v1',
    kind: 'RuntimeClass',
    metadata: { name },
    handler,
    scheduling: {
      nodeSelector: { [GVISOR_NODE_LABEL]: 'true' },
      // Omitted rather than empty: an absent field cannot be mistaken for a
      // pool toleration that was configured and then emptied.
      ...(tolerations.length > 0 ? { tolerations } : {}),
    },
  }))
}

/**
 * The install itself, as a POSIX shell program the installer DaemonSet runs
 * on every node it lands on. It is the ONE install mechanism — a kind node
 * is just a mutable-OS node with the same containerd config — so nothing
 * about it is backend-specific.
 *
 * Idempotent by construction, because it re-runs on every pod start, on
 * every new node, and on a timer:
 *  - the binaries are installed only when the live `runsc --version` is not
 *    the pinned release, and fetched only when the node-local cache does not
 *    already hold a checksum-verified copy (so a pod restart, or a second
 *    install sharing the node, costs nothing);
 *  - both flag files and the containerd block are compared before writing;
 *  - containerd is restarted only when something changed, or when the
 *    per-version marker is absent — which is exactly the interrupted-restart
 *    state a previous pass can leave behind (files on disk, handlers not in
 *    the running containerd). The marker is written only AFTER the restart
 *    returns, so that state can never be mistaken for a converged one. What
 *    the marker does NOT do is ask the live CRI what it registered, which
 *    the retired `podman exec` install could (`crictl info`): a node whose
 *    containerd was reconfigured out from under yaac is caught by cluster
 *    check's sentry probe rather than healed here, since crictl is not a
 *    binary a stock node is required to have.
 *
 * The release is fetched from the node rather than pushed from the server:
 * the whole point of the DaemonSet is to reach nodes the server cannot exec
 * into. Pinning survives the move — same GVISOR_VERSION, same published
 * sha512, verified both on download and on every cache hit, before the
 * binary is ever put on PATH.
 *
 * Each pass runs under a node-local lock, because two installs CAN share a
 * node (the real one plus an e2e run's) and the steps are only individually
 * idempotent: unsynchronized, both could pass the containerd marker check
 * before either appends, leaving duplicate TOML tables that stop containerd
 * from restarting at all. The lock does not make installs pinning DIFFERENT
 * GVISOR_VERSIONs safe — each would see the other's binaries as wrong and
 * restart containerd every pass, forever — so coexisting installs on one
 * node must share the pin.
 */
export function gvisorInstallScript(): string {
  const host = (p: string): string => `${INSTALLER_HOST_PREFIX}${p}`
  const cache = host(NODE_GVISOR_CACHE_DIR)
  const q = shellQuote
  return [
    '#!/bin/sh',
    'set -eu',
    '',
    `version=${q(GVISOR_VERSION)}`,
    `base=${q(GVISOR_RELEASE_BASE)}`,
    `bin=${q(host(NODE_BIN_DIR))}`,
    `cache=${q(cache)}`,
    `state=${q(`${cache}/state`)}`,
    `cfg=${q(host(NODE_CONTAINERD_CONFIG_PATH))}`,
    `lock=${q(`${cache}/.install-lock`)}`,
    `ready=${q(GVISOR_INSTALLER_READY_FILE)}`,
    'sa=/var/run/secrets/kubernetes.io/serviceaccount',
    'held=0',
    '',
    // Readiness means "this node's runtime is live", so it must not outlive
    // the process that asserted it: a failed pass exits (kubelet restarts
    // the container with backoff) and takes the marker — and the lock, if
    // this pass is the one holding it — with it. Releasing unconditionally
    // would let a pod that dies WAITING for the lock free the holder's. A
    // SIGKILLed shell runs no trap at all, which is what the stale-lock
    // break below and the re-verified cache exist to survive.
    `trap 'rm -f "$ready"; if [ "$held" = 1 ]; then rm -rf "$lock"; fi' EXIT`,
    '',
    'case "$(uname -m)" in',
    '  x86_64|amd64) arch=x86_64 ;;',
    '  aarch64|arm64) arch=aarch64 ;;',
    '  *) echo "unsupported node architecture for gVisor: $(uname -m)" >&2; exit 1 ;;',
    'esac',
    '',
    '# Serialize passes across every installer sharing this node: the steps',
    '# below are each idempotent, but two passes interleaved are not (both can',
    '# read the containerd config before either appends).',
    'take_lock() {',
    '  while ! mkdir "$lock" 2>/dev/null; do',
    '    # A pod killed mid-pass leaves the lock behind and no one else can',
    '    # ever converge, so a long-stale lock is broken. Staleness is the',
    '    # LOCK\'s age, never this waiter\'s: two waiters that had each waited',
    '    # out the timeout would otherwise both break, the second one removing',
    '    # the lock the first had just legitimately taken. An unstamped lock',
    '    # (an older installer\'s, or a holder killed between the mkdir and its',
    '    # stamp) starts ageing from first sight, so it is breakable too.',
    '    if [ ! -f "$lock/taken-at" ]; then date +%s > "$lock/taken-at" 2>/dev/null || true; fi',
    '    taken=$(cat "$lock/taken-at" 2>/dev/null || echo 0)',
    '    case "$taken" in \'\'|*[!0-9]*) taken=0 ;; esac',
    `    if [ "$taken" -gt 0 ] && [ "$(( $(date +%s) - taken ))" -ge ${GVISOR_INSTALL_LOCK_TIMEOUT_S} ]; then`,
    '      echo "yaac-gvisor: breaking a stale install lock" >&2',
    '      rm -rf "$lock"',
    '    fi',
    '    sleep 5',
    '  done',
    '  date +%s > "$lock/taken-at"',
    '  held=1',
    '}',
    '',
    'drop_lock() {',
    '  held=0',
    '  rm -rf "$lock"',
    '}',
    '',
    '# One release artifact in the node-local cache, checksum-verified.',
    'fetch() {',
    '  dest="$cache/$version/$arch/$1"',
    '  # Re-verify on a cache HIT, not just after a download. The cache is',
    '  # node state that outlives this pod, and treating "the file is there"',
    '  # as proof would let one bad copy be installed forever.',
    '  if [ -f "$dest" ] && [ -f "$dest.sha512" ] \\',
    '     && (cd "$(dirname "$dest")" && sha512sum -c "$1.sha512" >/dev/null 2>&1); then',
    '    return 0',
    '  fi',
    '  rm -f "$dest" "$dest.sha512"',
    '  echo "yaac-gvisor: downloading pinned $1 $version ($arch)"',
    '  mkdir -p "$(dirname "$dest")"',
    '  # Stage INSIDE the cache directory so the move below is a',
    '  # same-filesystem rename, and therefore atomic. Staging in the',
    '  # container filesystem would make it a cross-device copy, which busybox',
    '  # creates at its final 0755 mode from the first byte — an interrupted',
    '  # one would leave an executable partial file behind.',
    '  tmp="$(dirname "$dest")/.tmp-$$"',
    '  rm -rf "$tmp"',
    '  mkdir -p "$tmp"',
    '  cd "$tmp"',
    '  curl -fsSL "$base/$arch/$1" -o "$1"',
    '  # The published checksum file names the artifact\'s original basename,',
    '  # so verification has to happen here, under that name.',
    '  curl -fsSL "$base/$arch/$1.sha512" -o "$1.sha512"',
    '  sha512sum -c "$1.sha512" >/dev/null',
    '  chmod 0755 "$1"',
    '  # Checksum first: the binary\'s presence is what a later pass keys on,',
    '  # so it must never be the file that lands without its proof.',
    '  mv "$1.sha512" "$dest.sha512"',
    '  mv "$1" "$dest"',
    '  cd /',
    '  rm -rf "$tmp"',
    '}',
    '',
    '# Write $2 to $1 only when it differs, via a temp file + rename.',
    'write_if_changed() {',
    `  printf '%s' "$2" > "$1.yaac-new"`,
    '  if cmp -s "$1.yaac-new" "$1" 2>/dev/null; then',
    '    rm -f "$1.yaac-new"',
    '  else',
    '    mv "$1.yaac-new" "$1"',
    '    changed=1',
    '  fi',
    '}',
    '',
    '# Mark this node as carrying the runtime. The apiserver is reached by',
    '# the injected service IP, so this works before cluster DNS does.',
    'label_node() {',
    '  curl -sS --fail-with-body -o /dev/null -X PATCH \\',
    '    --cacert "$sa/ca.crt" \\',
    '    -H "Authorization: Bearer $(cat "$sa/token")" \\',
    `    -H 'Content-Type: application/merge-patch+json' \\`,
    `    --data ${q(JSON.stringify({ metadata: { labels: gvisorNodeLabels() } }))} \\`,
    '    "https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT/api/v1/nodes/$NODE_NAME"',
    '}',
    '',
    'install_pass() {',
    '  changed=0',
    '',
    '  if ! "$bin/runsc" --version 2>/dev/null | grep -qF "release-$version"; then',
    '    # Both fetched before either is installed, and runsc — the binary the',
    '    # check above reads — installed LAST. A pass that dies in between must',
    '    # not leave a node whose runsc answers "converged" over an old shim,',
    '    # which no later pass would look at again.',
    '    for f in containerd-shim-runsc-v1 runsc; do fetch "$f"; done',
    '    for f in containerd-shim-runsc-v1 runsc; do',
    '      # Copy to a temp name then rename: a live shim holds the old inode,',
    '      # so an in-place copy would fail "text file busy"; rename is atomic.',
    '      cp "$cache/$version/$arch/$f" "$bin/$f.yaac-new"',
    '      chmod 0755 "$bin/$f.yaac-new"',
    '      mv "$bin/$f.yaac-new" "$bin/$f"',
    '    done',
    '    changed=1',
    '  fi',
    '',
    `  write_if_changed ${q(host(NODE_RUNSC_CONFIG_PATH))} ${q(runscShimConfigToml('gvisor'))}`,
    `  write_if_changed ${q(host(NODE_RUNSC_NESTED_CONFIG_PATH))} ${q(runscShimConfigToml('gvisor-nested'))}`,
    '',
    '  if [ ! -f "$cfg" ]; then',
    '    echo "yaac-gvisor: no $cfg on this node — cannot register the runsc handlers" >&2',
    '    exit 1',
    '  fi',
    `  if ! grep -qF ${q(GVISOR_CONTAINERD_MARKER)} "$cfg"; then`,
    // Config version 3 renamed the CRI plugin key, so the block is written
    // under whichever key this node's own config speaks. Both blocks ship;
    // the node picks. Guessing is not an option in either direction — a
    // block under the wrong key is silently ignored, which would leave the
    // node labelled, restarted and converged with no runsc handler at all.
    `    if grep -qF ${q(CRI_PLUGIN_KEY_V3)} "$cfg"; then`,
    '      key=v3',
    `    elif grep -qF ${q(CRI_PLUGIN_KEY_V2)} "$cfg"; then`,
    '      key=v2',
    // A config that names neither plugin (a minimal one that only declares
    // its version) still says which dialect it is in.
    // Anchored past the digit so a future two-digit config version cannot
    // read as one of these.
    `    elif grep -qE '^[[:space:]]*version[[:space:]]*=[[:space:]]*3([^0-9].*)?$' "$cfg"; then`,
    '      key=v3',
    `    elif grep -qE '^[[:space:]]*version[[:space:]]*=[[:space:]]*2([^0-9].*)?$' "$cfg"; then`,
    '      key=v2',
    '    else',
    '      echo "yaac-gvisor: cannot tell which CRI plugin key $cfg uses (no'
    + ' plugin section, no version = 2|3) — refusing to write a block that'
    + ' containerd would ignore" >&2',
    '      exit 1',
    '    fi',
    '    if [ "$key" = v3 ]; then',
    `      printf '\\n%s' ${q(gvisorContainerdRuntimesToml(CRI_PLUGIN_KEY_V3))} >> "$cfg"`,
    '    else',
    `      printf '\\n%s' ${q(gvisorContainerdRuntimesToml(CRI_PLUGIN_KEY_V2))} >> "$cfg"`,
    '    fi',
    '    changed=1',
    '  fi',
    '',
    '  if [ "$changed" = 1 ] || [ ! -f "$state/installed-$version" ]; then',
    '    echo "yaac-gvisor: restarting containerd to pick up the runsc handlers"',
    // nsenter into PID 1's mount namespace runs the NODE's systemctl against
    // the node's systemd, which is the only way a pod can restart the
    // service that runs it. Restarting containerd does not stop running
    // containers — their shims outlive it and re-attach.
    '    nsenter -t 1 -m -- systemctl restart containerd',
    '    mkdir -p "$state"',
    '    : > "$state/installed-$version"',
    '  fi',
    '',
    '  label_node',
    '}',
    '',
    'while :; do',
    '  take_lock',
    '  install_pass',
    '  drop_lock',
    '  : > "$ready"',
    `  sleep ${GVISOR_INSTALLER_INTERVAL_S}`,
    'done',
    '',
  ].join('\n')
}
