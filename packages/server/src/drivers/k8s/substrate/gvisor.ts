import { shellQuote } from '#lib/shell'
import { NODE_SYSTEMD_CONF_DIR, nodeTuningScript } from './node-tuning'
import type { PodToleration } from './taints'

/**
 * gVisor (runsc) is the runtime for pods that run untrusted code, i.e.
 * workspace pods, where agents run arbitrary commands and have root via
 * passwordless sudo. The gVisor sentry contains that root and shields the
 * host kernel.
 *
 * Trusted infrastructure (the proxy, project registries, node-write pods,
 * the installer) runs on runc. It only runs yaac's own code, and gVisor is
 * costly: each sandbox adds hundreds of threads, and many of them can
 * overload a node.
 *
 * This module defines the pinned release, the node paths and containerd
 * config the install produces, the install shell script, and the
 * RuntimeClass objects. A privileged DaemonSet
 * (drivers/k8s/install/gvisor-installer.ts) runs the script on every node.
 */

/** Pinned gVisor release installed on every node (runsc + shim together). */
export const GVISOR_VERSION = '20260706.0'

/** Release-artifact directory (each file has a `.sha512` sibling). */
export const GVISOR_RELEASE_BASE =
  `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_VERSION}`

/**
 * RuntimeClass names. Every untrusted pod sets one; infra pods set none and
 * get runc.
 *  - `gvisor`: the default sandbox (runsc with systrap).
 *  - `gvisor-nested`: also allows raw sockets, for the container engine
 *    that nested workspaces run.
 */
export const RUNTIME_CLASS_GVISOR = 'gvisor'
export const RUNTIME_CLASS_GVISOR_NESTED = 'gvisor-nested'

/**
 * Node labels the installer sets once the runtime works on a node. The
 * RuntimeClasses schedule only on `GVISOR_NODE_LABEL`; the version label
 * shows which nodes still run an older runsc. To confine sandboxed pods to
 * a node pool, change the installer's own `nodeSelector`.
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
 * Pod-spec fragment choosing the RuntimeClass for a pod that runs untrusted
 * code (workspace pods and the check probes that mimic them): `gvisor`, or
 * `gvisor-nested` when the pod runs a container engine.
 */
export function runtimeClassSpec(
  opts: { nested?: boolean } = {},
): { runtimeClassName?: string } {
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
/** Node-local cache of the verified release and the installed-version
 *  marker, so a restarted installer need not download again. */
export const NODE_GVISOR_CACHE_DIR = '/var/lib/yaac/gvisor'

/** Node paths the runsc configs land at. */
export const NODE_RUNSC_CONFIG_PATH = `${NODE_CONTAINERD_DIR}/runsc.toml`
export const NODE_RUNSC_NESTED_CONFIG_PATH = `${NODE_CONTAINERD_DIR}/runsc-nested.toml`
export const NODE_CONTAINERD_CONFIG_PATH = `${NODE_CONTAINERD_DIR}/config.toml`

/** Readiness marker in a pod-local emptyDir: written after a successful
 *  pass, removed when the installer exits. */
export const GVISOR_INSTALLER_STATE_DIR = '/run/yaac-gvisor'
export const GVISOR_INSTALLER_READY_FILE = `${GVISOR_INSTALLER_STATE_DIR}/.ready`

/** Idempotence marker for the containerd config.toml runtime block. */
export const GVISOR_CONTAINERD_MARKER = '# yaac-gvisor-runtimes'

/**
 * Where containerd reads per-registry `hosts.toml` files. yaac's registries
 * write theirs here, so a node's `config_path` must include it.
 */
export const NODE_CONTAINERD_CERTS_DIR = `${NODE_CONTAINERD_DIR}/certs.d`
/** Marker on the registry block the installer appends when a node has none. */
export const REGISTRY_CONFIG_MARKER = '# yaac-registry-config-path'

/** Seconds between installer passes. A pass only repairs a node that
 *  changed underneath it, so this is long. */
export const GVISOR_INSTALLER_INTERVAL_S = 600

/** Age at which a waiter breaks the node's install lock. Longer than any
 *  real pass (a ~60 MB download plus a containerd restart). */
export const GVISOR_INSTALL_LOCK_TIMEOUT_S = 900

/**
 * The node directories the install script writes, as pod volumes and
 * mounts. The installer is privileged anyway, so mounting only these four
 * directories is for auditability, not containment: they show exactly what
 * yaac writes on a node.
 */
export function gvisorInstallerHostMounts(): {
  volumes: Array<Record<string, unknown>>
  volumeMounts: Array<Record<string, unknown>>
} {
  const dirs: Array<[string, string]> = [
    ['node-bin', NODE_BIN_DIR],
    ['node-containerd', NODE_CONTAINERD_DIR],
    ['gvisor-cache', NODE_GVISOR_CACHE_DIR],
    ['node-systemd', NODE_SYSTEMD_CONF_DIR],
  ]
  return {
    volumes: [
      ...dirs.map(([name, dir]) => ({
        name,
        hostPath: { path: dir, type: 'DirectoryOrCreate' },
      })),
      // The readiness marker, pod-local so it dies with the pod.
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
 * runsc flags for one handler (the file named by `ConfigPath`):
 *  - platform systrap: needs no /dev/kvm, and works on kind nodes.
 *  - host-uds all: unix sockets on hostPath mounts become real host
 *    sockets, reachable from outside the sandbox.
 *  - allow-suid: honor setuid inside the sandbox so `sudo` works (gVisor
 *    drops it by default, google/gvisor#5299). The host process stays
 *    unprivileged.
 *  - overlay2 root:self: keep rootfs writes in a sentry-internal overlay
 *    for speed. Root only: `all:` would make hostPath volume writes
 *    ephemeral too.
 *  - nested only: raw/packet sockets for the in-sandbox container engine.
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
 * The CRI plugin key for `containerd.runtimes.*`. containerd config
 * version 3 renamed version 2's key. kind and managed node images vary, so
 * the script contains both blocks and picks by what the node's config uses.
 */
export const CRI_PLUGIN_KEY_V2 = 'io.containerd.grpc.v1.cri'
export const CRI_PLUGIN_KEY_V3 = 'io.containerd.cri.v1.runtime'
/** Version 3 split image handling, registry config included, into its own plugin. */
export const CRI_IMAGES_KEY_V3 = 'io.containerd.cri.v1.images'

/**
 * Registry block pointing containerd at `certs.d`, appended to a node
 * config that has no registry table.
 */
export function registryConfigPathToml(pluginKey: string): string {
  return [
    `${REGISTRY_CONFIG_MARKER} (written by the yaac gVisor installer; do not edit)`,
    `[plugins."${pluginKey}".registry]`,
    `  config_path = "${NODE_CONTAINERD_CERTS_DIR}"`,
  ].join('\n') + '\n'
}

/**
 * containerd config block registering both runsc handlers, appended once
 * (guarded by a marker). Passing through `dev.gvisor.*` pod annotations lets
 * manifests set per-mount runsc options, such as the nested graphroot tmpfs.
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
 * The RuntimeClasses. They are cluster-scoped and shared by every install on
 * the cluster, so they carry no install labels and teardown never deletes
 * them.
 *
 * Kubernetes merges `scheduling` into every pod that names the class. The
 * `nodeSelector` keeps sandboxed pods on nodes where the installer
 * succeeded; otherwise they would fail with "failed to get sandbox runtime"
 * instead of staying Pending with a clear event. `tolerations` lets every
 * such pod (workspaces, builders, check probes) run on a tainted,
 * dedicated workspace pool without each pod knowing about it. Cluster check
 * reads the same field to find usable nodes.
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
      ...(tolerations.length > 0 ? { tolerations } : {}),
    },
  }))
}

/**
 * The POSIX shell script the installer DaemonSet runs on every node, for
 * kind and real nodes alike. Each pass first applies node tuning
 * (node-tuning.ts), then installs gVisor. It re-runs on pod start and on a
 * timer, so every step is idempotent:
 *  - runsc and its shim are installed only when `runsc --version` is not
 *    the pinned release, and downloaded only when the node cache lacks a
 *    checksum-verified copy;
 *  - flag files and containerd blocks are compared before writing;
 *  - containerd must read registry hosts from `certs.d`. A config that
 *    already includes it is kept; one with no registry table gets the
 *    block; one pointing elsewhere or using the deprecated `mirrors` fails
 *    the pass, since the node could not pull yaac images;
 *  - containerd restarts only when something changed or the per-version
 *    marker is missing. The marker is written after the restart, so an
 *    interrupted pass restarts again. Drift in the live containerd is
 *    caught by cluster check's sentry probe, not here.
 *
 * Releases are checksum-verified on download and on every cache hit.
 * Passes take a node-local lock because two installs can share a node (e.g.
 * an e2e run), and interleaved passes could append duplicate TOML tables
 * that stop containerd from starting. Installs sharing a node must pin the
 * same GVISOR_VERSION, or each would restart containerd on every pass.
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
    // On exit, clear the readiness marker, and release the lock only if
    // this pass holds it (a waiter must not free the holder's lock).
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
    '# Write $2 to $1 only when it differs, via a temp file + rename. Exits',
    '# 0 when it wrote, 1 when the file already matched — the caller decides',
    '# what a change means (a containerd restart). A write that FAILS ends',
    '# the pass outright: callers run this as an `if` condition, which',
    '# suspends `set -e` for the whole function body, so it cannot be left',
    '# to -e — a failed printf would otherwise read as "unchanged".',
    'write_if_changed() {',
    `  printf '%s' "$2" > "$1.yaac-new" || exit 1`,
    '  if cmp -s "$1.yaac-new" "$1" 2>/dev/null; then',
    '    rm -f "$1.yaac-new"',
    '    return 1',
    '  fi',
    '  mv "$1.yaac-new" "$1" || exit 1',
    '}',
    '',
    nodeTuningScript(),
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
    `  if write_if_changed ${q(host(NODE_RUNSC_CONFIG_PATH))} ${q(runscShimConfigToml('gvisor'))}; then changed=1; fi`,
    `  if write_if_changed ${q(host(NODE_RUNSC_NESTED_CONFIG_PATH))} ${q(runscShimConfigToml('gvisor-nested'))}; then changed=1; fi`,
    '',
    '  if [ ! -f "$cfg" ]; then',
    '    echo "yaac-gvisor: no $cfg on this node — cannot register the runsc handlers" >&2',
    '    exit 1',
    '  fi',
    `  if ! grep -qF ${q(GVISOR_CONTAINERD_MARKER)} "$cfg"; then`,
    // Write the block under the key this node's config uses. containerd
    // silently ignores a block under the wrong key, so never guess.
    `    if grep -qF ${q(CRI_PLUGIN_KEY_V3)} "$cfg"; then`,
    '      key=v3',
    `    elif grep -qF ${q(CRI_PLUGIN_KEY_V2)} "$cfg"; then`,
    '      key=v2',
    // Fall back to the declared config version (anchored so e.g. 30 does
    // not match 3).
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
    `  certs=${q(NODE_CONTAINERD_CERTS_DIR)}`,
    `  if grep -qE '^[[:space:]]*config_path[[:space:]]*=' "$cfg"; then`,
    // A `:`-separated list containing certs.d counts (EKS AL2023 ships
    // `certs.d:/etc/docker/certs.d`).
    `    if ! grep -qE ${q(`^[[:space:]]*config_path[[:space:]]*=[[:space:]]*["']([^"']*:)?${NODE_CONTAINERD_CERTS_DIR.replace(/\./g, '\\.')}/?(:[^"']*)?["']`)} "$cfg"; then`,
    '      echo "yaac-gvisor: $cfg sets a registry config_path other than $certs, where'
    + ' the yaac registries write their hosts.toml — this node could pull none of'
    + ' their images" >&2',
    '      exit 1',
    '    fi',
    `  elif grep -qE '\\.registry(\\]|\\.)' "$cfg"; then`,
    '    echo "yaac-gvisor: $cfg configures registries without config_path (the'
    + ' deprecated mirrors/configs tables), and containerd refuses config_path beside'
    + ' them — move this node\'s registry config to config_path under $certs" >&2',
    '    exit 1',
    '  else',
    `    if grep -qF ${q(CRI_PLUGIN_KEY_V3)} "$cfg" || grep -qE '^[[:space:]]*version[[:space:]]*=[[:space:]]*3([^0-9].*)?$' "$cfg"; then`,
    `      printf '\\n%s' ${q(registryConfigPathToml(CRI_IMAGES_KEY_V3))} >> "$cfg"`,
    '    else',
    `      printf '\\n%s' ${q(registryConfigPathToml(CRI_PLUGIN_KEY_V2))} >> "$cfg"`,
    '    fi',
    '    echo "yaac-gvisor: pointed containerd at $certs for registry hosts"',
    '    changed=1',
    '  fi',
    '',
    '  if [ "$changed" = 1 ] || [ ! -f "$state/installed-$version" ]; then',
    '    echo "yaac-gvisor: restarting containerd to pick up the runsc handlers and registry config"',
    // Use the node's systemctl via PID 1's mount namespace. Running
    // containers survive a containerd restart.
    '    nsenter -t 1 -m -- systemctl restart containerd',
    '    mkdir -p "$state"',
    '    : > "$state/installed-$version"',
    '  fi',
    '',
    '  label_node',
    '}',
    '',
    // Tuning first, so a node that cannot be tuned fails before
    // downloading. Both run under the lock so a systemd reexec never races
    // a containerd restart.
    'while :; do',
    '  take_lock',
    '  tune_pass',
    '  install_pass',
    '  drop_lock',
    '  : > "$ready"',
    `  sleep ${GVISOR_INSTALLER_INTERVAL_S}`,
    'done',
    '',
  ].join('\n')
}
