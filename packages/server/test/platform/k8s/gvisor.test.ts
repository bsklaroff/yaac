import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  GVISOR_NODE_LABEL,
  GVISOR_NODE_VERSION_LABEL,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  buildRuntimeClassManifests,
  gvisorInstallScript,
  gvisorInstallerHostMounts,
  runtimeClassSpec,
} from '#platform/k8s'
// Internals, for pins only: the release the installer downloads, the node
// paths it writes, and the containerd wiring it appends.
import {
  CRI_PLUGIN_KEY_V2,
  CRI_PLUGIN_KEY_V3,
  GVISOR_CONTAINERD_MARKER,
  GVISOR_INSTALLER_READY_FILE,
  GVISOR_INSTALL_LOCK_TIMEOUT_S,
  GVISOR_RELEASE_BASE,
  GVISOR_VERSION,
  NODE_BIN_DIR,
  NODE_CONTAINERD_CONFIG_PATH,
  NODE_CONTAINERD_DIR,
  NODE_GVISOR_CACHE_DIR,
  NODE_RUNSC_CONFIG_PATH,
  NODE_RUNSC_NESTED_CONFIG_PATH,
} from '#platform/k8s/gvisor'

/** Real `sh -n`: the install program is generated shell, so parsing it is
 *  the one property a string assertion cannot cover. */
const runSh = promisify(execFile)

/**
 * The single-quoted shell literal following `prefix` — the flag files and
 * containerd blocks are embedded that way and span many lines, so a
 * line-wise search would only ever see their first line. Safe because none
 * of the embedded content contains a single quote.
 */
function shellLiteralAfter(script: string, prefix: string): string {
  const start = script.indexOf(prefix) + prefix.length + 1
  expect(start).toBeGreaterThan(prefix.length)
  return script.slice(start, script.indexOf("'", start))
}

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
  it('maps both classes to their runsc handlers and schedules them on installed nodes only', () => {
    const manifests = buildRuntimeClassManifests() as Array<{
      apiVersion: string
      kind: string
      metadata: { name: string }
      handler: string
      scheduling: { nodeSelector: Record<string, string> }
    }>

    expect(manifests.map((m) => m.metadata.name))
      .toEqual([RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED])
    expect(manifests.map((m) => m.handler)).toEqual(['runsc', 'runsc-nested'])
    expect(manifests.every((m) => m.apiVersion === 'node.k8s.io/v1' && m.kind === 'RuntimeClass'))
      .toBe(true)
    // The scheduling gate: admission merges this into every pod naming the
    // class, so a sandboxed pod cannot land on a node the installer has not
    // converged. Keyed on the runtime label, never on a node pool — which is
    // what leaves a sessions-only pool a change to the installer alone.
    for (const m of manifests) {
      expect(m.scheduling.nodeSelector).toEqual({ [GVISOR_NODE_LABEL]: 'true' })
    }
    // Cluster-scoped and install-independent: no namespace, no install labels
    // (coexisting installs share these objects).
    expect(manifests.every((m) => !('namespace' in m.metadata))).toBe(true)
    // No tolerations by default, and the field absent rather than empty: an
    // untainted cluster needs none, and cluster check reads this same field
    // to decide which nodes a session can use — an empty array there would
    // be indistinguishable from a pool toleration that was dropped.
    expect(manifests.every((m) => !('tolerations' in m.scheduling))).toBe(true)
  })

  it('carries a sessions-pool toleration onto both classes when one is declared', () => {
    // The one declaration point for a dedicated sessions pool: admission
    // merges this into session pods, builder pods, vcluster-synced pods and
    // cluster check's pinned probes alike, so nothing per-pod knows the pool
    // exists. NoExecute as well as NoSchedule, since a pool taint is
    // typically both (keep others off, evict what drifted on).
    const tolerations = [
      { key: 'yaac.dev/sessions', operator: 'Equal', value: 'true', effect: 'NoSchedule' },
      { key: 'yaac.dev/sessions', operator: 'Equal', value: 'true', effect: 'NoExecute' },
    ]
    const manifests = buildRuntimeClassManifests({ tolerations }) as Array<{
      metadata: { name: string }
      scheduling: { nodeSelector: Record<string, string>; tolerations?: unknown }
    }>

    expect(manifests.map((m) => m.metadata.name))
      .toEqual([RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED])
    for (const m of manifests) {
      expect(m.scheduling.tolerations).toEqual(tolerations)
      // The selector is untouched: where the runtime IS and which pool it
      // belongs to are separate questions, and the label the installer
      // stamps answers only the first.
      expect(m.scheduling.nodeSelector).toEqual({ [GVISOR_NODE_LABEL]: 'true' })
    }
  })
})

describe('gvisorInstallScript', () => {
  it('parses as a POSIX shell program', async () => {
    // Every flag file and containerd block is embedded as a shell literal;
    // a quoting slip would produce a script that only fails on a node.
    await expect(runSh('sh', ['-n', '-c', gvisorInstallScript()])).resolves.toBeDefined()
  })

  it('installs the pinned, checksum-verified release and registers both handlers', () => {
    const script = gvisorInstallScript()

    // The release: pinned version, per-arch, with the published sha512
    // verified in a scratch dir (the checksum file names the artifact's
    // original basename) before anything lands on the node's PATH.
    expect(script).toContain(`version='${GVISOR_VERSION}'`)
    expect(script).toContain(`base='${GVISOR_RELEASE_BASE}'`)
    expect(script).toContain('curl -fsSL "$base/$arch/$1" -o "$1"')
    expect(script).toContain('curl -fsSL "$base/$arch/$1.sha512" -o "$1.sha512"')
    expect(script).toContain('sha512sum -c "$1.sha512" >/dev/null')
    // Arch comes from the node, in both spellings uname reports.
    expect(script).toContain('x86_64|amd64) arch=x86_64')
    expect(script).toContain('aarch64|arm64) arch=aarch64')
    expect(script).toContain('unsupported node architecture for gVisor')

    // The cache is node state that outlives the pod, so a hit is a
    // re-verification, never a bare existence test: one interrupted write
    // would otherwise be installed forever.
    expect(script).toContain(`cache='/host${NODE_GVISOR_CACHE_DIR}'`)
    expect(script).toContain('if [ -f "$dest" ] && [ -f "$dest.sha512" ] \\')
    expect(script).toContain('&& (cd "$(dirname "$dest")" && sha512sum -c "$1.sha512" >/dev/null 2>&1); then')
    // Staged inside the cache dir, so the move that publishes it is a rename
    // (atomic) rather than a cross-device copy — which busybox creates at its
    // final 0755 mode from the first byte, i.e. executable while partial.
    expect(script).toContain('tmp="$(dirname "$dest")/.tmp-$$"')
    // Checksum lands before the binary it proves.
    expect(script.indexOf('mv "$1.sha512" "$dest.sha512"'))
      .toBeLessThan(script.indexOf('mv "$1" "$dest"'))

    // Both binaries fetched before either is installed, and the one the
    // version gate reads (runsc) installed LAST — otherwise a pass that died
    // between them would leave new runsc + old shim looking converged.
    expect(script).toContain('for f in containerd-shim-runsc-v1 runsc; do fetch "$f"; done')
    expect(script).toMatch(/for f in containerd-shim-runsc-v1 runsc; do\n\s+#/)
    expect(script).not.toContain('for f in runsc containerd-shim-runsc-v1')
    expect(script).toContain('mv "$bin/$f.yaac-new" "$bin/$f"')
    expect(script).toContain(`bin='/host${NODE_BIN_DIR}'`)

    // Handler flag files: systrap, host-uds for the hostPath unix sockets,
    // suid, and the rootfs-only overlay (all: would discard session-dir
    // writes). Only the nested handler gets raw/packet sockets.
    const [defaultCfg, nestedCfg] = [NODE_RUNSC_CONFIG_PATH, NODE_RUNSC_NESTED_CONFIG_PATH]
      .map((p) => shellLiteralAfter(script, `write_if_changed '/host${p}' `))
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

    // containerd: marker-guarded append to the node's own config, with the
    // plugin key chosen from what that config declares — both blocks ship,
    // the node picks (kind is still version 2; containerd 2.x is version 3).
    expect(script).toContain(`grep -qF '${GVISOR_CONTAINERD_MARKER}' "$cfg"`)
    expect(script).toContain(`grep -qF '${CRI_PLUGIN_KEY_V3}' "$cfg"`)
    expect(script).toContain(`grep -qF '${CRI_PLUGIN_KEY_V2}' "$cfg"`)
    expect(script).toContain(`cfg='/host${NODE_CONTAINERD_CONFIG_PATH}'`)
    // A config naming neither plugin still declares its dialect; one naming
    // neither AND no version is unreadable, and a guess there would append a
    // block containerd silently ignores — leaving the node labelled,
    // restarted, and running no runsc handler at all.
    // Anchored past the digit: a two-digit config version must not read as
    // the one it starts with.
    expect(script).toContain(
      `grep -qE '^[[:space:]]*version[[:space:]]*=[[:space:]]*3([^0-9].*)?$' "$cfg"`)
    expect(script).toContain(
      `grep -qE '^[[:space:]]*version[[:space:]]*=[[:space:]]*2([^0-9].*)?$' "$cfg"`)
    expect(script).toContain('cannot tell which CRI plugin key $cfg uses')
    const appended = [...script.matchAll(/printf '\\n%s' '([\s\S]*?)' >> "\$cfg"/g)].map((m) => m[1])
    expect(appended).toHaveLength(2)
    for (const key of [CRI_PLUGIN_KEY_V2, CRI_PLUGIN_KEY_V3]) {
      const block = appended.find((b) => b.includes(`plugins."${key}"`))!
      expect(block).toContain(GVISOR_CONTAINERD_MARKER)
      expect(block).toContain(`[plugins."${key}".containerd.runtimes.runsc]`)
      expect(block).toContain(`[plugins."${key}".containerd.runtimes.runsc-nested]`)
      expect(block).toContain(`ConfigPath = "${NODE_RUNSC_CONFIG_PATH}"`)
      expect(block).toContain(`ConfigPath = "${NODE_RUNSC_NESTED_CONFIG_PATH}"`)
      // dev.gvisor.* annotations pass through for the graphroot mount options.
      expect(block).toContain('pod_annotations = ["dev.gvisor.*"]')
      expect(block.match(/runtime_type = "io\.containerd\.runsc\.v1"/g)).toHaveLength(2)
    }
  })

  it('restarts containerd only on change or an unproven install, then claims the node', () => {
    const script = gvisorInstallScript()

    // Files on disk do not prove the RUNNING containerd has the handlers: an
    // interrupted restart leaves exactly that state. The per-version marker
    // is written only AFTER the restart returns, so such a node restarts on
    // the next pass instead of being mistaken for converged.
    expect(script).toContain('if [ "$changed" = 1 ] || [ ! -f "$state/installed-$version" ]; then')
    expect(script).toContain('nsenter -t 1 -m -- systemctl restart containerd')
    expect(script.indexOf('nsenter -t 1 -m -- systemctl restart containerd'))
      .toBeLessThan(script.indexOf(': > "$state/installed-$version"'))
    // A node with no containerd config is an unsupported node, not one to
    // write a fresh (defaults-losing) config onto.
    expect(script).toContain('cannot register the runsc handlers')

    // The label the RuntimeClasses schedule on, patched through the
    // apiserver's injected service IP so no cluster DNS is involved.
    expect(script).toContain('-X PATCH')
    expect(script).toContain(JSON.stringify({
      metadata: { labels: { [GVISOR_NODE_LABEL]: 'true', [GVISOR_NODE_VERSION_LABEL]: GVISOR_VERSION } },
    }))
    expect(script).toContain('"https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT/api/v1/nodes/$NODE_NAME"')
    // Readiness is asserted after a pass and dropped when the process goes,
    // so a crash-looping installer never reports a converged node.
    expect(script).toContain(`ready='${GVISOR_INSTALLER_READY_FILE}'`)
    expect(script).toContain(
      `trap 'rm -f "$ready"; if [ "$held" = 1 ]; then rm -rf "$lock"; fi' EXIT`)
    expect(script).toMatch(
      /while :; do\n {2}take_lock\n {2}install_pass\n {2}drop_lock\n {2}: > "\$ready"/)
  })

  it('serializes passes across installs sharing the node, and breaks a dead one\'s lock', () => {
    const script = gvisorInstallScript()

    // Two installs CAN share a node (the real one plus an e2e run's), and
    // the steps are only individually idempotent: interleaved, both could
    // pass the containerd marker check before either appends, leaving
    // duplicate TOML tables that stop containerd from restarting at all.
    expect(script).toContain(`lock='/host${NODE_GVISOR_CACHE_DIR}/.install-lock'`)
    expect(script).toContain('while ! mkdir "$lock" 2>/dev/null; do')
    // A pod killed holding the lock must not wedge the node forever — a pass
    // is idempotent, so a long-stale lock is safe to break. Staleness is the
    // lock's own age: judged per-waiter, two waiters that had both waited out
    // the timeout would break in sequence, the second removing the lock the
    // first had just taken.
    expect(script).toContain('date +%s > "$lock/taken-at"')
    expect(script).toContain('taken=$(cat "$lock/taken-at" 2>/dev/null || echo 0)')
    expect(script).toContain(
      `if [ "$taken" -gt 0 ] && [ "$(( $(date +%s) - taken ))" -ge ${GVISOR_INSTALL_LOCK_TIMEOUT_S} ]; then`)
    expect(script).not.toContain('waited=')
    expect(script).toContain('breaking a stale install lock')
    // The release is ownership-scoped: a pod that dies WAITING must not free
    // the holder's lock.
    expect(script).toContain('  held=1\n}')
    expect(script).toContain('drop_lock() {\n  held=0\n  rm -rf "$lock"\n}')
  })
})

describe('gvisorInstallerHostMounts', () => {
  it('mounts exactly the node directories the script writes, and nothing else', () => {
    const { volumes, volumeMounts } = gvisorInstallerHostMounts() as {
      volumes: Array<{ name: string; hostPath?: { path: string; type: string }; emptyDir?: object }>
      volumeMounts: Array<{ name: string; mountPath: string }>
    }

    const hostPaths = volumes.filter((v) => v.hostPath)
    expect(hostPaths.map((v) => v.hostPath!.path))
      .toEqual([NODE_BIN_DIR, NODE_CONTAINERD_DIR, NODE_GVISOR_CACHE_DIR])
    // DirectoryOrCreate: the cache (and, on a bare node, /usr/local/bin) may
    // not exist yet, and a missing hostPath would leave the pod Pending.
    expect(hostPaths.every((v) => v.hostPath!.type === 'DirectoryOrCreate')).toBe(true)
    // The readiness marker is pod-local: a restarted installer re-converges
    // rather than inheriting a claim about the node.
    expect(volumes.find((v) => v.emptyDir)?.name).toBe('state')

    expect(volumeMounts.map((m) => m.name)).toEqual(volumes.map((v) => v.name))
    expect(volumeMounts.map((m) => m.mountPath)).toEqual([
      `/host${NODE_BIN_DIR}`,
      `/host${NODE_CONTAINERD_DIR}`,
      `/host${NODE_GVISOR_CACHE_DIR}`,
      GVISOR_INSTALLER_READY_FILE.replace(/\/[^/]+$/, ''),
    ])

    // The invariant that ties the two halves together: every node path the
    // script touches is inside one of these mounts. A path added to the
    // script without a mount would fail only on a real node.
    const mounted = volumeMounts.map((m) => m.mountPath)
    const referenced = gvisorInstallScript().match(/'\/host[^']*'/g) ?? []
    expect(referenced.length).toBeGreaterThan(0)
    for (const raw of referenced) {
      const p = raw.slice(1, -1)
      expect(mounted.some((m) => p === m || p.startsWith(`${m}/`))).toBe(true)
    }
  })
})
