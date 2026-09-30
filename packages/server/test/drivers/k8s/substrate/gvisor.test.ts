import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  GVISOR_NODE_LABEL,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  buildRuntimeClassManifests,
  gvisorInstallScript,
  gvisorInstallerHostMounts,
  runtimeClassSpec,
} from '#drivers/k8s/substrate'
// Setup values, not units under test.
import {
  CRI_IMAGES_KEY_V3,
  CRI_PLUGIN_KEY_V2,
  CRI_PLUGIN_KEY_V3,
  GVISOR_CONTAINERD_MARKER,
  GVISOR_INSTALLER_READY_FILE,
  GVISOR_INSTALL_LOCK_TIMEOUT_S,
  GVISOR_NODE_VERSION_LABEL,
  GVISOR_RELEASE_BASE,
  GVISOR_VERSION,
  NODE_BIN_DIR,
  NODE_CONTAINERD_CERTS_DIR,
  NODE_CONTAINERD_CONFIG_PATH,
  NODE_CONTAINERD_DIR,
  NODE_GVISOR_CACHE_DIR,
  NODE_RUNSC_CONFIG_PATH,
  NODE_RUNSC_NESTED_CONFIG_PATH,
  REGISTRY_CONFIG_MARKER,
} from '#drivers/k8s/substrate/gvisor'
import {
  NODE_SYSTEMD_CONF_DIR,
  NODE_TASKSMAX_CONF,
  NODE_TASKSMAX_CONTENT,
  NODE_TASKSMAX_LIVE,
  NODE_TUNING_SYSCTLS,
} from '#drivers/k8s/substrate/node-tuning'

/** Runs a real shell, to syntax-check the generated install script. */
const runSh = promisify(execFile)

/**
 * The multi-line single-quoted shell literal after `prefix`. Safe because
 * no embedded content contains a single quote.
 */
function shellLiteralAfter(script: string, prefix: string): string {
  const start = script.indexOf(prefix) + prefix.length + 1
  expect(start).toBeGreaterThan(prefix.length)
  return script.slice(start, script.indexOf("'", start))
}

/** The body of `name() { ... }` in the script, up to its closing brace. */
function shellFunction(script: string, name: string): string {
  const start = script.indexOf(`${name}() {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return script.slice(start, script.indexOf('\n}\n', start))
}

describe('runtimeClassSpec', () => {
  it('stamps gvisor by default and gvisor-nested for nested pods', () => {
    expect(runtimeClassSpec({})).toEqual({ runtimeClassName: RUNTIME_CLASS_GVISOR })
    expect(runtimeClassSpec({ nested: true }))
      .toEqual({ runtimeClassName: RUNTIME_CLASS_GVISOR_NESTED })
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
    // Admission adds this to every pod using the class, so a sandboxed pod
    // only lands on nodes where the installer finished. It keys on the runtime
    // label, not a node pool, so pools are configured in the installer alone.
    for (const m of manifests) {
      expect(m.scheduling.nodeSelector).toEqual({ [GVISOR_NODE_LABEL]: 'true' })
    }
    // Cluster-scoped and shared by coexisting installs: no namespace, no
    // install labels.
    expect(manifests.every((m) => !('namespace' in m.metadata))).toBe(true)
    // No tolerations field by default, rather than an empty one, since
    // cluster check reads it to decide which nodes can take a workspace.
    expect(manifests.every((m) => !('tolerations' in m.scheduling))).toBe(true)
  })

  it('carries a sessions-pool toleration onto both classes when one is declared', () => {
    // The single place a workspace pool is declared: admission adds this to
    // workspace pods, builder pods and cluster check's probes alike. Both
    // NoExecute and NoSchedule, as pool taints usually are.
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
      // The selector is unchanged: it says where the runtime is, not which
      // pool.
      expect(m.scheduling.nodeSelector).toEqual({ [GVISOR_NODE_LABEL]: 'true' })
    }
  })
})

describe('gvisorInstallScript', () => {
  it('parses as a POSIX shell program', async () => {
    // Flag files and containerd blocks are embedded as shell literals, so a
    // quoting mistake would only fail on a node.
    await expect(runSh('sh', ['-n', '-c', gvisorInstallScript()])).resolves.toBeDefined()
  })

  it('installs the pinned, checksum-verified release and registers both handlers', () => {
    const script = gvisorInstallScript()

    // Pinned version per arch, with the sha512 verified in a scratch dir
    // before anything reaches the node's PATH.
    expect(script).toContain(`version='${GVISOR_VERSION}'`)
    expect(script).toContain(`base='${GVISOR_RELEASE_BASE}'`)
    expect(script).toContain('curl -fsSL "$base/$arch/$1" -o "$1"')
    expect(script).toContain('curl -fsSL "$base/$arch/$1.sha512" -o "$1.sha512"')
    expect(script).toContain('sha512sum -c "$1.sha512" >/dev/null')
    // Both uname spellings of each arch.
    expect(script).toContain('x86_64|amd64) arch=x86_64')
    expect(script).toContain('aarch64|arm64) arch=aarch64')
    expect(script).toContain('unsupported node architecture for gVisor')

    // The cache outlives the pod, so a hit is re-verified; otherwise an
    // interrupted write would be installed forever.
    expect(script).toContain(`cache='/host${NODE_GVISOR_CACHE_DIR}'`)
    expect(script).toContain('if [ -f "$dest" ] && [ -f "$dest.sha512" ] \\')
    expect(script).toContain('&& (cd "$(dirname "$dest")" && sha512sum -c "$1.sha512" >/dev/null 2>&1); then')
    // Staged in the cache dir so publishing is an atomic rename, not a
    // cross-device copy (busybox makes the file executable while partial).
    expect(script).toContain('tmp="$(dirname "$dest")/.tmp-$$"')
    // The checksum is written before the binary.
    expect(script.indexOf('mv "$1.sha512" "$dest.sha512"'))
      .toBeLessThan(script.indexOf('mv "$1" "$dest"'))

    // Both binaries are fetched first, and runsc (which the version check
    // reads) is installed last, so a pass that dies midway is not mistaken
    // for converged.
    expect(script).toContain('for f in containerd-shim-runsc-v1 runsc; do fetch "$f"; done')
    expect(script).toMatch(/for f in containerd-shim-runsc-v1 runsc; do\n\s+#/)
    expect(script).not.toContain('for f in runsc containerd-shim-runsc-v1')
    expect(script).toContain('mv "$bin/$f.yaac-new" "$bin/$f"')
    expect(script).toContain(`bin='/host${NODE_BIN_DIR}'`)

    // Handler flag files: systrap, host-uds for hostPath unix sockets, suid,
    // and a rootfs-only overlay (overlay on everything would drop workspace
    // dir writes). Only the nested handler gets raw/packet sockets.
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

    // A marker-guarded append to the node's containerd config, choosing the
    // plugin key from the config's version (kind uses 2; containerd 2.x
    // uses 3). Both blocks ship.
    expect(script).toContain(`grep -qF '${GVISOR_CONTAINERD_MARKER}' "$cfg"`)
    expect(script).toContain(`grep -qF '${CRI_PLUGIN_KEY_V3}' "$cfg"`)
    expect(script).toContain(`grep -qF '${CRI_PLUGIN_KEY_V2}' "$cfg"`)
    expect(script).toContain(`cfg='/host${NODE_CONTAINERD_CONFIG_PATH}'`)
    // With neither plugin named, the version line decides. With no version
    // either, the pass fails rather than append a block containerd would
    // ignore. The regex stops after the digit so "30" does not match "3".
    expect(script).toContain(
      `grep -qE '^[[:space:]]*version[[:space:]]*=[[:space:]]*3([^0-9].*)?$' "$cfg"`)
    expect(script).toContain(
      `grep -qE '^[[:space:]]*version[[:space:]]*=[[:space:]]*2([^0-9].*)?$' "$cfg"`)
    expect(script).toContain('cannot tell which CRI plugin key $cfg uses')
    const appended = [...script.matchAll(/printf '\\n%s' '([\s\S]*?)' >> "\$cfg"/g)].map((m) => m[1])
      .filter((b) => b.includes(GVISOR_CONTAINERD_MARKER))
    expect(appended).toHaveLength(2)
    for (const key of [CRI_PLUGIN_KEY_V2, CRI_PLUGIN_KEY_V3]) {
      const block = appended.find((b) => b.includes(`plugins."${key}"`))!
      expect(block).toContain(GVISOR_CONTAINERD_MARKER)
      expect(block).toContain(`[plugins."${key}".containerd.runtimes.runsc]`)
      expect(block).toContain(`[plugins."${key}".containerd.runtimes.runsc-nested]`)
      expect(block).toContain(`ConfigPath = "${NODE_RUNSC_CONFIG_PATH}"`)
      expect(block).toContain(`ConfigPath = "${NODE_RUNSC_NESTED_CONFIG_PATH}"`)
      // dev.gvisor.* annotations pass through for graphroot mount options.
      expect(block).toContain('pod_annotations = ["dev.gvisor.*"]')
      expect(block.match(/runtime_type = "io\.containerd\.runsc\.v1"/g)).toHaveLength(2)
    }
  })

  it('restarts containerd only on change or an unproven install, then claims the node', () => {
    const script = gvisorInstallScript()

    // Files on disk do not prove the running containerd loaded them. The
    // per-version marker is written only after the restart, so an
    // interrupted restart is retried next pass.
    expect(script).toContain('if [ "$changed" = 1 ] || [ ! -f "$state/installed-$version" ]; then')
    expect(script).toContain('nsenter -t 1 -m -- systemctl restart containerd')
    expect(script.indexOf('nsenter -t 1 -m -- systemctl restart containerd'))
      .toBeLessThan(script.indexOf(': > "$state/installed-$version"'))
    // Callers set `changed`; the helper only reports. The tuning pass shares
    // the helper and must not restart containerd for a systemd drop-in.
    expect(shellFunction(script, 'write_if_changed')).not.toContain('changed=1')
    expect(script).toContain('    return 1\n  fi\n  mv "$1.yaac-new" "$1" || exit 1\n}')
    expect(script).toContain(
      `if write_if_changed '/host${NODE_RUNSC_CONFIG_PATH}' `)
    expect(script.match(/; then changed=1; fi$/gm)).toHaveLength(2)
    // A node with no containerd config is unsupported; writing a fresh one
    // would lose its defaults.
    expect(script).toContain('cannot register the runsc handlers')

    // The node label the RuntimeClasses select on, patched via the
    // apiserver's service IP so no cluster DNS is needed.
    expect(script).toContain('-X PATCH')
    expect(script).toContain(JSON.stringify({
      metadata: { labels: { [GVISOR_NODE_LABEL]: 'true', [GVISOR_NODE_VERSION_LABEL]: GVISOR_VERSION } },
    }))
    expect(script).toContain('"https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT/api/v1/nodes/$NODE_NAME"')
    // Ready is set after a pass and lost when the process exits, so a
    // crash-looping installer never looks converged.
    expect(script).toContain(`ready='${GVISOR_INSTALLER_READY_FILE}'`)
    expect(script).toContain(
      `trap 'rm -f "$ready"; if [ "$held" = 1 ]; then rm -rf "$lock"; fi' EXIT`)
    expect(script).toMatch(
      /while :; do\n {2}take_lock\n {2}tune_pass\n {2}install_pass\n {2}drop_lock\n {2}: > "\$ready"/)
  })

  it('tunes the node before installing the runtime, and never restarts containerd for it', () => {
    const script = gvisorInstallScript()

    // Every pass re-applies the sysctls and the TasksMax drop-in, so a
    // restarted node is re-tuned without re-running install. Tuning runs
    // first (cheap, and fails before a download) and under the lock.
    expect(script.indexOf('tune_pass() {')).toBeLessThan(script.indexOf('install_pass() {'))
    // Limits are only raised, so a higher operator value is kept.
    expect(script).toContain('if [ "$3" = raise ] && [ "$cur" -ge "$2" ]; then return 0; fi')
    expect(script).toContain('if [ "$3" = set ] && [ "$cur" = "$2" ]; then return 0; fi')
    expect(script).toContain('echo "$2" > "/proc/sys/$1" || exit 1')
    // A missing knob (compaction_proactiveness needs 5.9+) is skipped, not
    // fatal.
    expect(script).toContain('if [ ! -e "/proc/sys/$1" ]; then')
    expect(script).toContain('is not on this kernel; skipped')
    expect(NODE_TUNING_SYSCTLS.length).toBeGreaterThan(0)
    for (const s of NODE_TUNING_SYSCTLS) {
      expect(script).toContain(`  tune_sysctl '${s.path}' ${String(s.value)} ${s.mode}`)
    }
    expect(NODE_TUNING_SYSCTLS.find((s) => s.path === 'vm/min_free_kbytes')?.mode).toBe('raise')
    expect(NODE_TUNING_SYSCTLS.find((s) => s.path === 'vm/compaction_proactiveness')?.mode)
      .toBe('set')

    // The drop-in is written through the hostPath mount (for the next boot),
    // and systemd reexecs when its live value shows it has not loaded it. This
    // is not keyed on the file diff, which an interrupted pass would leave
    // looking done, nor on the containerd restart flag.
    expect(shellLiteralAfter(script, `if write_if_changed '/host${NODE_TASKSMAX_CONF}' `))
      .toBe(NODE_TASKSMAX_CONTENT)
    expect(script).toContain(
      `if [ "$(nsenter -t 1 -m -- systemctl show -p DefaultTasksMax --value)" != '${NODE_TASKSMAX_LIVE}' ]; then`)
    expect(script.match(/nsenter -t 1 -m -- systemctl daemon-reexec/g)).toHaveLength(1)
    expect(shellFunction(script, 'tune_pass')).not.toContain('changed=1')
  })

  it('reexecs systemd once per pod life for a drop-in it can never see applied', async () => {
    // A manager that never reports `infinity` (an operator drop-in overriding
    // ours) must not reexec every pass. Under a real sh with a fake nsenter:
    // two passes give one reexec and a warning; a file change allows one
    // more.
    const script = gvisorInstallScript()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tune-'))
    try {
      const target = path.join(dir, 'tasksmax.conf')
      const program = [
        'set -eu',
        shellFunction(script, 'write_if_changed') + '\n}',
        'tasksmax_reexeced=0',
        shellFunction(script, 'tune_pass').replaceAll(`'/host${NODE_TASKSMAX_CONF}'`, `'${target}'`) + '\n}',
        // Stubbed: not under test, and it would write /proc/sys.
        'tune_sysctl() { :; }',
        'nsenter() { case "$*" in *daemon-reexec*) echo REEXEC ;; *) echo 4915 ;; esac; }',
        'tune_pass; tune_pass',
        `printf 'changed' > '${target}'`,
        'tune_pass; tune_pass',
      ].join('\n')
      const { stdout, stderr } = await runSh('sh', ['-c', program])
      expect(stdout.match(/^REEXEC$/gm)).toHaveLength(2)
      expect(stderr.match(/still not infinity after a reexec/g)).toHaveLength(2)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('ends the pass when a node file cannot be written, even from an `if` list', async () => {
    // `set -e` does not apply inside an `if` condition, so the helper must
    // fail explicitly; otherwise an unwritable target would read as
    // "unchanged" and the pass would mark the node Ready.
    const script = gvisorInstallScript()
    const program = [
      'set -eu',
      shellFunction(script, 'write_if_changed') + '\n}',
      "if write_if_changed /nonexistent-yaac-dir/x 'content'; then echo WROTE; fi",
      'echo REACHED',
    ].join('\n')
    const result = await runSh('sh', ['-c', program]).then(
      (r) => ({ code: 0, stdout: r.stdout }),
      (e: { code?: number; stdout?: string }) => ({ code: e.code ?? 1, stdout: e.stdout ?? '' }),
    )
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('REACHED')
    expect(result.stdout).not.toContain('WROTE')
    // Changed exits 0, unchanged exits 1, and nothing is left behind.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-wic-'))
    try {
      const target = path.join(dir, 'f.toml')
      const ok = [
        'set -eu',
        shellFunction(script, 'write_if_changed') + '\n}',
        `if write_if_changed '${target}' 'a'; then echo FIRST=wrote; fi`,
        `if write_if_changed '${target}' 'a'; then echo SECOND=wrote; else echo SECOND=same; fi`,
        `if write_if_changed '${target}' 'b'; then echo THIRD=wrote; fi`,
      ].join('\n')
      const { stdout } = await runSh('sh', ['-c', ok])
      expect(stdout).toBe('FIRST=wrote\nSECOND=same\nTHIRD=wrote\n')
      expect(await fs.readFile(target, 'utf8')).toBe('b')
      expect(await fs.readdir(dir)).toEqual(['f.toml'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('points containerd at certs.d when a node has no registry config, and refuses one it cannot', async () => {
    // A stock node (kind's included) sets no config_path, so containerd would
    // never read the registries' hosts.toml and every yaac pull would fail.
    // Run under a real sh for each config shape.
    const script = gvisorInstallScript()
    const start = script.indexOf('  certs=')
    const step = script.slice(start, script.indexOf('\n\n  if [ "$changed" = 1 ]', start))
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-registry-cfg-'))
    const run = async (config: string): Promise<{ code: number; out: string; after: string }> => {
      const cfg = path.join(dir, 'config.toml')
      await fs.writeFile(cfg, config)
      const program = `set -eu\ncfg='${cfg}'\nchanged=0\n${step}\necho "changed=$changed"`
      const result = await runSh('sh', ['-c', program]).then(
        (r) => ({ code: 0, out: r.stdout + r.stderr }),
        (e: { code?: number; stdout?: string; stderr?: string }) =>
          ({ code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }),
      )
      return { ...result, after: await fs.readFile(cfg, 'utf8') }
    }
    try {
      // No registry table: the block is appended under the version's key, and
      // containerd restarts.
      const v2 = await run(`version = 2\n[plugins."${CRI_PLUGIN_KEY_V2}".containerd]\n  snapshotter = "overlayfs"\n`)
      expect(v2.out).toContain('changed=1')
      expect(v2.after).toContain(`${REGISTRY_CONFIG_MARKER}`)
      expect(v2.after).toContain(`[plugins."${CRI_PLUGIN_KEY_V2}".registry]\n  config_path = "${NODE_CONTAINERD_CERTS_DIR}"`)
      const v3 = await run(`version = 3\n[plugins."${CRI_PLUGIN_KEY_V3}"]\n`)
      expect(v3.after).toContain(`[plugins."${CRI_IMAGES_KEY_V3}".registry]`)

      // Already set (yaac's kind config): unchanged.
      const set = await run(`version = 2\n[plugins."${CRI_PLUGIN_KEY_V2}".registry]\n  config_path = "${NODE_CONTAINERD_CERTS_DIR}"\n`)
      expect(set.out).toContain('changed=0')
      expect(set.after).not.toContain(REGISTRY_CONFIG_MARKER)
      // A list including it (EKS AL2023) or a TOML literal string: unchanged.
      for (const value of [`"${NODE_CONTAINERD_CERTS_DIR}:/etc/docker/certs.d"`, `'${NODE_CONTAINERD_CERTS_DIR}'`]) {
        const listed = await run(`version = 2\n[plugins."${CRI_PLUGIN_KEY_V2}".registry]\n  config_path = ${value}\n`)
        expect(listed.out).toContain('changed=0')
      }

      // Pointing elsewhere, or with the deprecated mirrors (which containerd
      // refuses alongside config_path): fails with the reason, changing nothing.
      for (const value of ['"/etc/other"', `"/etc/other:${NODE_CONTAINERD_CERTS_DIR}.bak"`]) {
        const other = await run(`version = 2\n[plugins."${CRI_PLUGIN_KEY_V2}".registry]\n  config_path = ${value}\n`)
        expect(other.code).not.toBe(0)
        expect(other.out).toContain('config_path other than')
      }
      const mirrors = await run(`version = 2\n[plugins."${CRI_PLUGIN_KEY_V2}".registry.mirrors."docker.io"]\n  endpoint = ["x"]\n`)
      expect(mirrors.code).not.toBe(0)
      expect(mirrors.out).toContain('deprecated mirrors/configs')
      expect(mirrors.after).not.toContain(REGISTRY_CONFIG_MARKER)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('serializes passes across installs sharing the node, and breaks a dead one\'s lock', () => {
    const script = gvisorInstallScript()

    // Two installs can share a node (e.g. an e2e run), and interleaved passes
    // could both append containerd tables, which stops containerd from
    // restarting.
    expect(script).toContain(`lock='/host${NODE_GVISOR_CACHE_DIR}/.install-lock'`)
    expect(script).toContain('while ! mkdir "$lock" 2>/dev/null; do')
    // A pod killed while holding the lock must not wedge the node, so a stale
    // lock is broken. Staleness uses the lock's own timestamp, so two waiters
    // cannot break it in turn.
    expect(script).toContain('date +%s > "$lock/taken-at"')
    expect(script).toContain('taken=$(cat "$lock/taken-at" 2>/dev/null || echo 0)')
    expect(script).toContain(
      `if [ "$taken" -gt 0 ] && [ "$(( $(date +%s) - taken ))" -ge ${GVISOR_INSTALL_LOCK_TIMEOUT_S} ]; then`)
    expect(script).not.toContain('waited=')
    expect(script).toContain('breaking a stale install lock')
    // Only the holder releases the lock, not a pod that dies waiting.
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
      .toEqual([NODE_BIN_DIR, NODE_CONTAINERD_DIR, NODE_GVISOR_CACHE_DIR, NODE_SYSTEMD_CONF_DIR])
    // DirectoryOrCreate: a missing hostPath would leave the pod Pending.
    expect(hostPaths.every((v) => v.hostPath!.type === 'DirectoryOrCreate')).toBe(true)
    // The readiness marker is pod-local, so a restarted installer
    // re-converges.
    expect(volumes.find((v) => v.emptyDir)?.name).toBe('state')

    expect(volumeMounts.map((m) => m.name)).toEqual(volumes.map((v) => v.name))
    expect(volumeMounts.map((m) => m.mountPath)).toEqual([
      `/host${NODE_BIN_DIR}`,
      `/host${NODE_CONTAINERD_DIR}`,
      `/host${NODE_GVISOR_CACHE_DIR}`,
      `/host${NODE_SYSTEMD_CONF_DIR}`,
      GVISOR_INSTALLER_READY_FILE.replace(/\/[^/]+$/, ''),
    ])

    // Every node path the script uses must be under one of these mounts, or
    // it would only fail on a real node.
    const mounted = volumeMounts.map((m) => m.mountPath)
    const referenced = gvisorInstallScript().match(/'\/host[^']*'/g) ?? []
    expect(referenced.length).toBeGreaterThan(0)
    for (const raw of referenced) {
      const p = raw.slice(1, -1)
      expect(mounted.some((m) => p === m || p.startsWith(`${m}/`))).toBe(true)
    }
  })
})
