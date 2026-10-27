import crypto from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { fakeRegistry } from '#test/support/fake-registry'
import type * as apiModule from '#drivers/k8s/substrate/api'
import type * as registryModule from '#drivers/k8s/cluster/registry'

// The rollout wait is the one kubectl process this path runs.
vi.mock('#drivers/k8s/substrate/api', async (importOriginal) => ({
  ...(await importOriginal<typeof apiModule>()),
  execFileAsync: vi.fn(),
}))

// Spied on to see the cached forward dropped after the containerd restart.
vi.mock('#drivers/k8s/cluster/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  invalidateRegistryEndpoint: vi.fn(),
}))

import { ensureGvisorRuntime } from '#drivers/k8s/install'
// Setup values, not units under test.
import {
  GVISOR_INSTALLER_APP_NAME,
  GVISOR_INSTALLER_MIRROR_TAG,
  GVISOR_INSTALLER_UPSTREAM_IMAGE,
} from '#drivers/k8s/install/gvisor-installer'
import {
  GVISOR_NODE_LABEL,
  GVISOR_PENDING_TAINT,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  WORKSPACE_POOL_KEY,
} from '#drivers/k8s/substrate'
import {
  CRI_IMAGES_KEY_V3,
  CRI_PLUGIN_KEY_V2,
  CRI_PLUGIN_KEY_V3,
  GVISOR_CONTAINERD_MARKER,
  GVISOR_INSTALLER_READY_FILE,
  GVISOR_INSTALL_LOCK_TIMEOUT_S,
  GVISOR_NODE_VERSION_LABEL,
  GVISOR_RELEASE_BASE,
  GVISOR_SHA512,
  GVISOR_VERSION,
  NODE_BIN_DIR,
  NODE_CONTAINERD_CERTS_DIR,
  NODE_CONTAINERD_CONFIG_PATH,
  NODE_CONTAINERD_DIR,
  NODE_GVISOR_CACHE_DIR,
  NODE_RUNSC_CONFIG_PATH,
  NODE_RUNSC_NESTED_CONFIG_PATH,
  REGISTRY_CONFIG_MARKER,
  SANDBOX_DENTRY_CACHE,
} from '#drivers/k8s/install/gvisor-runtime'
import {
  NODE_SYSTEMD_CONF_DIR,
  NODE_TASKSMAX_CONF,
  NODE_TASKSMAX_CONTENT,
  NODE_TASKSMAX_LIVE,
  NODE_TUNING_SYSCTLS,
} from '#drivers/k8s/install/node-tuning'
import { execFileAsync } from '#drivers/k8s/substrate/api'
import { invalidateRegistryEndpoint, registryRef } from '#drivers/k8s/cluster/registry'

const mockExec = vi.mocked(execFileAsync)
const mockInvalidate = vi.mocked(invalidateRegistryEndpoint)

interface Applied {
  kind: string
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  [key: string]: unknown
}

/** Every manifest this ensure applied, in order. */
function applied(): Applied[] {
  return fakeCluster.callsOf('apply').map((c) => c.body as unknown as Applied)
}

/** How many API calls had been made when the rollout wait ran. */
let callsBeforeRollout = -1

function ofKind(kind: string): Applied[] {
  return applied().filter((m) => m.kind === kind)
}

/** The installer pod's script and node mounts, as the applied DaemonSet carries them. */
function installerPod(): {
  script: string
  volumes: Array<{ name: string; hostPath?: { path: string; type: string }; emptyDir?: object }>
  volumeMounts: Array<{ name: string; mountPath: string }>
} {
  const pod = (ofKind('DaemonSet')[0] as unknown as {
    spec: { template: { spec: {
      containers: Array<{ command: string[]; volumeMounts: Array<{ name: string; mountPath: string }> }>
      volumes: Array<{ name: string; hostPath?: { path: string; type: string }; emptyDir?: object }>
    } } }
  }).spec.template.spec
  return { script: pod.containers[0].command[2], volumes: pod.volumes, volumeMounts: pod.containers[0].volumeMounts }
}

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


beforeEach(() => {
  vi.clearAllMocks()
  fakeRegistry.install()
  fakeRegistry.mirror(GVISOR_INSTALLER_MIRROR_TAG)
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  mockExec.mockImplementation((() => {
    callsBeforeRollout = fakeCluster.calls.length
    return Promise.resolve({ stdout: '', stderr: '' })
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('ensureGvisorRuntime', () => {
  it('applies the installer DaemonSet, waits for it, then applies the RuntimeClasses', async () => {
    await ensureGvisorRuntime()

    expect(applied().map((m) => m.kind)).toEqual([
      'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'DaemonSet',
      'RuntimeClass', 'RuntimeClass',
    ])

    const ds = ofKind('DaemonSet')[0] as unknown as {
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      spec: {
        selector: { matchLabels: Record<string, string> }
        updateStrategy: { type: string; rollingUpdate: { maxUnavailable: number } }
        template: {
          metadata: { labels: Record<string, string> }
          spec: {
            hostNetwork: boolean
            hostPID: boolean
            dnsPolicy: string
            nodeSelector?: Record<string, string>
            serviceAccountName: string
            runtimeClassName?: string
            tolerations: Array<{ operator: string }>
            priorityClassName: string
            containers: Array<{
              image: string
              command: string[]
              securityContext: { privileged: boolean; runAsUser: number }
              env: Array<{ name: string; valueFrom: { fieldRef: { fieldPath: string } } }>
              readinessProbe: { exec: { command: string[] } }
              volumeMounts: Array<{ name: string; mountPath: string }>
            }>
            volumes: Array<{ name: string; hostPath?: { path: string } }>
          }
        }
      }
    }
    expect(ds.metadata.name).toBe(GVISOR_INSTALLER_APP_NAME)
    expect(ds.metadata.namespace).toBe('test-ns')
    const pod = ds.spec.template.spec

    // Privileged + hostPID: it installs node binaries, edits containerd's
    // config and restarts containerd from PID 1's mount namespace.
    expect(pod.containers[0].securityContext).toEqual({ privileged: true, runAsUser: 0 })
    expect(pod.hostPID).toBe(true)
    // Host network and DNS, so it works before CNI/CoreDNS are up.
    expect(pod.hostNetwork).toBe(true)
    expect(pod.dnsPolicy).toBe('Default')
    // runc: it installs gVisor, so it cannot run on it.
    expect(pod.runtimeClassName).toBeUndefined()
    // Node infrastructure: runs on every node and is not evicted first.
    expect(pod.tolerations).toEqual([{ operator: 'Exists' }])
    expect(pod.priorityClassName).toBe('system-node-critical')
    // One node's containerd restart at a time.
    expect(ds.spec.updateStrategy).toEqual({
      type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 },
    })

    // Runs from the mirrored upstream image by the digest install recorded
    // (it is full node root), with the node name for the label patch.
    expect(pod.containers[0].image)
      .toBe(registryRef(`curlimages/curl@${fakeRegistry.digestOf(GVISOR_INSTALLER_MIRROR_TAG)}`))
    expect(pod.containers[0].command[0]).toBe('sh')
    expect(pod.containers[0].command[2]).toContain('nsenter -t 1 -m -- systemctl restart containerd')
    // The same pass also tunes the node (docs/cluster-setup.md).
    expect(pod.containers[0].command[2]).toContain('nsenter -t 1 -m -- systemctl daemon-reexec')
    expect(pod.containers[0].env).toEqual([
      { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
    ])
    // Ready means this node's runtime is live, which the rollout waits for.
    expect(pod.containers[0].readinessProbe.exec.command)
      .toEqual(['test', '-f', GVISOR_INSTALLER_READY_FILE])
    expect(pod.volumes.filter((v) => v.hostPath).map((v) => v.hostPath!.path))
      .toEqual(['/usr/local/bin', '/etc/containerd', '/var/lib/yaac/gvisor', '/etc/systemd/system.conf.d'])

    // RBAC: only labelling nodes.
    const role = ofKind('ClusterRole')[0] as unknown as {
      metadata: { name: string; labels: Record<string, string> }
      rules: Array<{ apiGroups: string[]; resources: string[]; verbs: string[] }>
    }
    expect(role.rules).toEqual([
      { apiGroups: [''], resources: ['nodes'], verbs: ['get', 'patch'] },
    ])
    // Cluster-scoped names include the namespace so the real install and
    // e2e runs can coexist.
    expect(role.metadata.name).toBe(`${GVISOR_INSTALLER_APP_NAME}-test-ns`)
    expect(role.metadata.labels['yaac.install-namespace']).toBe('test-ns')
    const binding = ofKind('ClusterRoleBinding')[0] as unknown as {
      roleRef: { name: string }
      subjects: Array<{ name: string; namespace: string }>
    }
    expect(binding.roleRef.name).toBe(`${GVISOR_INSTALLER_APP_NAME}-test-ns`)
    expect(binding.subjects).toEqual([
      { kind: 'ServiceAccount', name: GVISOR_INSTALLER_APP_NAME, namespace: 'test-ns' },
    ])

    // RuntimeClasses select on the label the DaemonSet adds, so they are
    // applied after the rollout; otherwise gVisor pods would sit Pending.
    expect(mockExec).toHaveBeenCalledWith(
      'kubectl',
      ['rollout', 'status', `daemonset/${GVISOR_INSTALLER_APP_NAME}`, '-n', 'test-ns', '--timeout=300s'],
      expect.anything(),
    )
    // The ConfigMap is the mirror digest record the image is looked up in.
    expect(fakeCluster.calls.slice(0, callsBeforeRollout).map((c) => c.kind))
      .toEqual(['ConfigMap', 'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'DaemonSet', 'Node'])

    // Restarting containerd kills port-forwards. The registry forward is
    // dropped after the rollout so the next lookup reconnects instead of
    // reading a dead connection as a missing image.
    expect(mockInvalidate).toHaveBeenCalledTimes(1)
    expect(mockInvalidate.mock.invocationCallOrder[0]).toBeGreaterThan(mockExec.mock.invocationCallOrder[0])

    const classes = ofKind('RuntimeClass') as unknown as Array<{
      metadata: { name: string }
      handler: string
      scheduling: { nodeSelector: Record<string, string> }
    }>
    expect(classes.map((c) => c.metadata.name))
      .toEqual([RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED])
    expect(classes.map((c) => c.handler)).toEqual(['runsc', 'runsc-nested'])
    for (const c of classes) {
      expect(c.scheduling.nodeSelector).toEqual({ [GVISOR_NODE_LABEL]: 'true' })
    }
  })

  it('installs on every node, waiting longer for a rollout through more of them', async () => {
    // A bump rolls one node at a time, and each extracts the release, so
    // the wait scales with the node count.
    fakeCluster.seed(...['n1', 'n2', 'n3'].map((name) => ({ apiVersion: 'v1', kind: 'Node', metadata: { name } })))
    await ensureGvisorRuntime()
    const spec = (ofKind('DaemonSet')[0].spec as { template: { spec: Record<string, unknown> } })
      .template.spec
    expect(spec).not.toHaveProperty('nodeSelector')
    expect(mockExec).toHaveBeenCalledWith(
      'kubectl',
      ['rollout', 'status', `daemonset/${GVISOR_INSTALLER_APP_NAME}`, '-n', 'test-ns', '--timeout=900s'],
      expect.anything(),
    )
  })

  it('takes the installer image from the registry, never the host engine', async () => {
    // `yaac cluster install` mirrors the digest-pinned upstream image; this
    // only looks it up, so applying the DaemonSet needs no container engine.
    await ensureGvisorRuntime()
    expect(GVISOR_INSTALLER_UPSTREAM_IMAGE).toMatch(/^docker\.io\/curlimages\/curl@sha256:[0-9a-f]{64}$/)
    // Its only process is the rollout wait: nothing is pulled or pushed.
    expect(mockExec.mock.calls.every(([, args]) => args[0] === 'rollout')).toBe(true)
    expect(applied()).not.toHaveLength(0)
  })

  it('refuses, naming the command that mirrors it, when the registry lacks the tag', async () => {
    fakeRegistry.tags.clear()
    fakeRegistry.collect()
    await expect(ensureGvisorRuntime()).rejects.toThrow(/missing.*yaac cluster install/s)
    expect(mockExec).not.toHaveBeenCalled()
    expect(applied()).toHaveLength(0)
  })

  it('maps both classes to their runsc handlers and schedules them on installed nodes only', async () => {
    await ensureGvisorRuntime()
    const manifests = ofKind('RuntimeClass') as unknown as Array<{
      apiVersion: string
      kind: string
      metadata: { name: string }
      handler: string
      scheduling: { nodeSelector: Record<string, string>; tolerations: unknown }
    }>

    expect(manifests.map((m) => m.metadata.name))
      .toEqual([RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED])
    expect(manifests.map((m) => m.handler)).toEqual(['runsc', 'runsc-nested'])
    expect(manifests.every((m) => m.apiVersion === 'node.k8s.io/v1' && m.kind === 'RuntimeClass'))
      .toBe(true)
    // Admission adds both to every pod using the class: a sandboxed pod
    // only lands on nodes where the installer finished, and may land on a
    // workspace pool tainted with the pool key (any value or effect), which
    // nothing else tolerates.
    for (const m of manifests) {
      expect(m.scheduling.nodeSelector).toEqual({ [GVISOR_NODE_LABEL]: 'true' })
      expect(m.scheduling.tolerations).toEqual([{ key: WORKSPACE_POOL_KEY, operator: 'Exists' }])
    }
    // Cluster-scoped and shared by coexisting installs: no namespace, no
    // install labels.
    expect(manifests.every((m) => !('namespace' in m.metadata))).toBe(true)
  })

  it('mounts exactly the node directories the script writes, and nothing else', async () => {
    await ensureGvisorRuntime()
    const { volumes, volumeMounts } = installerPod()

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
    const referenced = installerPod().script.match(/'\/host[^']*'/g) ?? []
    expect(referenced.length).toBeGreaterThan(0)
    for (const raw of referenced) {
      const p = raw.slice(1, -1)
      expect(mounted.some((m) => p === m || p.startsWith(`${m}/`))).toBe(true)
    }
  })

  // The script runs on every node; these run its parts for real, against
  // stand-ins for the node's binaries.
  describe('the installer script', () => {
    let script: string
    beforeEach(async () => {
      await ensureGvisorRuntime()
      script = installerPod().script
    })

    it('parses as a POSIX shell program', async () => {
      // Flag files and containerd blocks are embedded as shell literals, so a
      // quoting mistake would only fail on a node.
      await expect(runSh('sh', ['-n', '-c', script])).resolves.toBeDefined()
    })

    it('installs the pinned, checksum-verified release and registers both handlers', () => {

      // Pinned version per arch, checked against the SHA-512 pinned here
      // (never one fetched beside it) in a scratch dir before anything
      // reaches the node's PATH.
      expect(script).toContain(`version='${GVISOR_VERSION}'`)
      expect(script).toContain(`base='${GVISOR_RELEASE_BASE}'`)
      expect(script).toContain('curl -fsSL "$base/$arch/$1" -o "$1"')
      expect(script).not.toContain('.sha512"')
      // Both uname spellings of each arch.
      expect(script).toContain(`x86_64|amd64) arch=x86_64 sum=${GVISOR_SHA512.x86_64} ;;`)
      expect(script).toContain(`aarch64|arm64) arch=aarch64 sum=${GVISOR_SHA512.aarch64} ;;`)
      expect(script).toContain('unsupported node architecture for gVisor')

      // The cache outlives the pod, so a hit is re-verified; otherwise an
      // interrupted write would be installed forever.
      expect(script).toContain(`cache='/host${NODE_GVISOR_CACHE_DIR}'`)
      expect(script).toContain('if [ -f "$dest" ] && pinned "$dest"; then')
      // Staged in the cache dir so publishing is an atomic rename, not a
      // cross-device copy (busybox makes the file executable while partial).
      expect(script).toContain('tmp="$(dirname "$dest")/.tmp-$$"')

      // runsc (which the version check reads) is moved in after the sidecars
      // and shim, so a pass that dies midway is not mistaken for converged.
      const sidecars = script.indexOf('mv "$new/gvisor-bin" "$bin/gvisor-bin"')
      expect(sidecars).toBeGreaterThan(-1)
      expect(script.indexOf('for f in containerd-shim-runsc-v1 runsc; do mv "$new/$f" "$bin/$f"; done'))
        .toBeGreaterThan(sidecars)
      expect(script).toContain('    install_release\n    changed=1\n  fi\n  prune_cache\n')
      expect(script).toContain(`bin='/host${NODE_BIN_DIR}'`)

      // Handler flag files: systrap, host-uds for hostPath unix sockets, suid,
      // a rootfs-only overlay (overlay on everything would drop workspace dir
      // writes) and a dentry cache bigger than a checkout, written as the
      // string the shim requires. Only the nested handler gets raw/packet
      // sockets.
      const [defaultCfg, nestedCfg] = [NODE_RUNSC_CONFIG_PATH, NODE_RUNSC_NESTED_CONFIG_PATH]
        .map((p) => shellLiteralAfter(script, `write_if_changed '/host${p}' `))
      for (const cfg of [defaultCfg, nestedCfg]) {
        expect(cfg).toContain('[runsc_config]')
        expect(cfg).toContain('platform = "systrap"')
        expect(cfg).toContain('host-uds = "all"')
        expect(cfg).toContain('allow-suid = "true"')
        expect(cfg).toContain('overlay2 = "root:self"')
        expect(cfg).toContain(`dcache = "${String(SANDBOX_DENTRY_CACHE)}"`)
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

    it('upgrades a node from the separate-binary layout, recovers an interrupted pass and prunes the cache', async () => {
      // Run the real fetch, install_release and prune_cache against a stub
      // release server: curl copies from a directory holding a tarball shaped
      // like gVisor's.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-gvisor-release-'))
      try {
        const [srv, src, bin, cache] = ['srv', 'src', 'bin', 'cache'].map((d) => path.join(dir, d))
        await fs.mkdir(path.join(src, 'gvisor-bin'), { recursive: true })
        for (const f of ['runsc', 'containerd-shim-runsc-v1', 'gvisor-bin/gvisor_sentry']) {
          await fs.writeFile(path.join(src, f), `#!/bin/sh\necho ${f} new\n`, { mode: 0o755 })
        }
        await fs.mkdir(srv)
        await runSh('sh', ['-c', `tar -cjf '${srv}/gvisor.tar.bz2' -C '${src}' .`])
        const sum = crypto.createHash('sha512').update(await fs.readFile(path.join(srv, 'gvisor.tar.bz2'))).digest('hex')

        // A node as releases before the tarball left it: separate runsc and
        // shim binaries, no gvisor-bin/, and a cache of those binaries. A
        // waiter's install lock sits beside them.
        await fs.mkdir(bin)
        for (const f of ['runsc', 'containerd-shim-runsc-v1']) {
          await fs.writeFile(path.join(bin, f), 'old')
          await fs.mkdir(path.join(cache, 'v0', 'x86_64'), { recursive: true })
          await fs.writeFile(path.join(cache, 'v0', 'x86_64', f), 'old')
          await fs.writeFile(path.join(cache, 'v0', 'x86_64', `${f}.sha512`), '')
        }
        await fs.mkdir(path.join(cache, 'state'))
        await fs.writeFile(path.join(cache, 'state', 'installed-v0'), '')
        await fs.mkdir(path.join(cache, '.install-lock'))
        await fs.writeFile(path.join(cache, '.install-lock', 'taken-at'), '1')

        const install = (pin = sum): Promise<{ stdout: string }> => runSh('sh', ['-c', [
          'set -eu',
          `bin='${bin}' cache='${cache}' version=v1 arch=x86_64 base=http://release sum=${pin}`,
          `curl() { echo "GET $2"; cp "${srv}/\${2##*/}" "$4"; }`,
          shellFunction(script, 'pinned') + '\n}',
          shellFunction(script, 'fetch') + '\n}',
          shellFunction(script, 'install_release') + '\n}',
          shellFunction(script, 'prune_cache') + '\n}',
          'install_release',
          'prune_cache',
        ].join('\n')])
        const expectInstalled = async (): Promise<void> => {
          expect((await runSh(path.join(bin, 'runsc'), [])).stdout).toBe('runsc new\n')
          expect((await runSh(path.join(bin, 'containerd-shim-runsc-v1'), [])).stdout)
            .toBe('containerd-shim-runsc-v1 new\n')
          expect(await fs.readdir(path.join(bin, 'gvisor-bin'))).toEqual(['gvisor_sentry'])
          // No staging dir or old sidecars are left in the node's PATH dir.
          expect((await fs.readdir(bin)).sort()).toEqual(['containerd-shim-runsc-v1', 'gvisor-bin', 'runsc'])
        }

        expect((await install()).stdout).toContain('GET http://release/x86_64/gvisor.tar.bz2')
        await expectInstalled()
        // The older release leaves the cache. The install markers and the
        // lock stay: deleting the lock mid-pass would let a second pass in.
        expect((await fs.readdir(cache)).sort()).toEqual(['.install-lock', 'state', 'v1'])
        expect(await fs.readdir(path.join(cache, 'state'))).toEqual(['installed-v0'])
        expect(await fs.readFile(path.join(cache, '.install-lock', 'taken-at'), 'utf8')).toBe('1')

        // A verified cache hit downloads nothing.
        expect((await install()).stdout).not.toContain('GET')

        // A pass that died between the two gvisor-bin moves left a staging
        // dir and the old sidecars aside, with no gvisor-bin/ at all. A rerun
        // from a corrupted cache downloads again and cleans both up.
        await fs.rename(path.join(bin, 'gvisor-bin'), path.join(bin, 'gvisor-bin.yaac-old'))
        await fs.writeFile(path.join(bin, 'gvisor-bin.yaac-old', 'stale'), '')
        await fs.mkdir(path.join(bin, '.yaac-gvisor-new', 'gvisor-bin'), { recursive: true })
        await fs.appendFile(path.join(cache, 'v1', 'x86_64', 'gvisor.tar.bz2'), 'x')
        expect((await install()).stdout).toContain('GET http://release/x86_64/gvisor.tar.bz2')
        await expectInstalled()

        // A release that does not match its pin is never installed.
        await fs.appendFile(path.join(cache, 'v1', 'x86_64', 'gvisor.tar.bz2'), 'x')
        await expect(install('0'.repeat(128))).rejects
          .toMatchObject({ stderr: expect.stringContaining('does not match its pinned SHA-512') as unknown })
        await expect(fs.access(path.join(cache, 'v1', 'x86_64', 'gvisor.tar.bz2'))).rejects.toThrow()
        await expectInstalled()
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })

    it('lifts the pending taint after labelling the node, removing only that taint', async () => {
      // A pool that registers nodes with the taint keeps pods off them until
      // the runtime is in, so the label must land before the taint goes.
      expect(script).toContain('  label_node\n  untaint_node\n}')

      // Run the real functions against a stub apiserver: curl with no -X reads
      // the node, and a JSON patch succeeds only if its `test` names the index
      // that really holds the taint.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-untaint-'))
      try {
        await fs.writeFile(path.join(dir, 'token'), 't')
        const untaint = async (taints: string[], opts: { getFails?: boolean } = {}): Promise<string> => {
          // Pretty-printed, as the apiserver answers curl.
          const node = JSON.stringify({ spec: { taints: taints.map((key) => ({ key, effect: 'NoSchedule' })) } }, null, 2)
          const program = [
            'set -eu',
            `sa='${dir}'`,
            'curl() {',
            '  case "$*" in',
            '    *"-X PATCH"*) echo "PATCH $*" >> "$sa/patches"',
            `      i=$(printf %s "$*" | sed -n 's|.*/spec/taints/\\([0-9]*\\)/key.*|\\1|p')`,
            '      [ "$i" = "$TAINT_AT" ] || return 22 ;;',
            `    *) [ -z "\${GET_FAILS:-}" ] || return 22; printf '%s' '${node}' ;;`,
            '  esac',
            '}',
            shellFunction(script, 'node_api') + '\n}',
            shellFunction(script, 'untaint_node') + '\n}',
            'untaint_node',
          ].join('\n')
          const at = taints.indexOf(GVISOR_PENDING_TAINT)
          await fs.rm(path.join(dir, 'patches'), { force: true })
          const { stdout } = await runSh('sh', ['-c', program], {
            env: {
              ...process.env,
              TAINT_AT: String(at),
              GET_FAILS: opts.getFails ? '1' : '',
              NODE_NAME: 'n1',
              KUBERNETES_SERVICE_HOST: '10.96.0.1',
              KUBERNETES_SERVICE_PORT: '443',
            },
          })
          return stdout + await fs.readFile(path.join(dir, 'patches'), 'utf8').catch(() => '')
        }

        const lifted = await untaint(['node.kubernetes.io/not-ready', GVISOR_PENDING_TAINT])
        expect(lifted).toContain(`removed the ${GVISOR_PENDING_TAINT} taint`)
        expect(lifted.match(/^PATCH /gm)).toHaveLength(2)
        expect(lifted).toContain(
          `{"op":"test","path":"/spec/taints/1/key","value":"${GVISOR_PENDING_TAINT}"},{"op":"remove","path":"/spec/taints/1"}`)

        // A node without it is left alone.
        expect(await untaint(['node.kubernetes.io/not-ready'])).not.toContain('PATCH')

        // A read that fails is not "no taint": the pass fails, so the pod
        // restarts and retries rather than sleeping a whole interval.
        await expect(untaint([GVISOR_PENDING_TAINT], { getFails: true })).rejects.toThrow()
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })

    it('labels every node for the runtime except one labelled infrastructure-only', async () => {
      const label = async (metadata: { labels?: Record<string, string>; annotations?: Record<string, string> }): Promise<string> => {
        // Pretty-printed, as the apiserver answers curl; the label patch is
        // echoed rather than sent.
        const node = JSON.stringify({ metadata }, null, 2)
        const program = [
          'set -eu',
          'curl() {',
          '  case "$*" in',
          '    *"-X PATCH"*) printf %s "$*" | sed -n \'s/.*--data \\([^ ]*\\) .*/\\1/p\' ;;',
          `    *) printf '%s' '${node}' ;;`,
          '  esac',
          '}',
          'sa=/nonexistent',
          shellFunction(script, 'node_api') + '\n}',
          shellFunction(script, 'label_node') + '\n}',
          'label_node',
        ].join('\n')
        const { stdout } = await runSh('sh', ['-c', program], {
          env: { ...process.env, NODE_NAME: 'n1', KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' },
        })
        return stdout
      }
      const on = JSON.stringify({ metadata: { labels: { [GVISOR_NODE_LABEL]: 'true', [GVISOR_NODE_VERSION_LABEL]: GVISOR_VERSION } } })
      const off = JSON.stringify({ metadata: { labels: { [GVISOR_NODE_LABEL]: null, [GVISOR_NODE_VERSION_LABEL]: null } } })

      expect(await label({})).toBe(on)
      expect(await label({ labels: { [WORKSPACE_POOL_KEY]: 'true' } })).toBe(on)
      // Only the label's own value counts: not a look-alike key (the dot is
      // literal), nor the label quoted inside an annotation (k3s records its
      // node args).
      expect(await label({ labels: { pool: 'system', [WORKSPACE_POOL_KEY]: 'false' } })).toBe(off)
      expect(await label({ labels: { 'yaacXworkspaces': 'false' } })).toBe(on)
      expect(await label({
        annotations: { 'k3s.io/node-args': JSON.stringify(['--node-label', `${WORKSPACE_POOL_KEY}=false`]) },
      })).toBe(on)
    })

    it('tunes the node before installing the runtime, and never restarts containerd for it', () => {

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
})
