/**
 * The two claims the server workload mounts, and the static PersistentVolumes
 * that back them on kind (docs/server-in-cluster.md "Storage is two
 * claims").
 *
 * `yaac-global` (RWX) carries the GLOBAL tier: the server pod mounts it
 * whole and every worktree pod mounts subPaths of it. `yaac-server-local`
 * (RWO) carries the SERVER-LOCAL tier and is the server's alone. On kind
 * each claim binds a static hostPath PV that install renders into the
 * host's data dir — `<dataDir>/global` and `<dataDir>/server-local` — so
 * the bytes stay on the host disk under `~/.yaac`, and `yaac cluster
 * delete` keeps touching none of them: `kind delete` takes the PV objects
 * with the cluster, and `Retain` is what keeps a claim or namespace delete
 * from touching the hostPath either.
 *
 * Kubernetes enforces no access mode on hostPath, so the claim spec is the
 * same one a cloud backend binds through a StorageClass. The PV names carry
 * `dataDirHash()` because PVs are cluster-scoped and one cluster hosts more
 * than one install (the real one, and every e2e namespace); the claims are
 * namespaced and carry no hash, because a namespace belongs to one install.
 *
 * Install-only, like the rest of this folder: the server references the
 * claim names and never applies a claim.
 */
import fs from 'node:fs/promises'
import {
  GLOBAL_CLAIM_NAME,
  LABEL_DATA_DIR_HASH,
  LABEL_INSTALL_NAMESPACE,
  SERVER_APP_NAME,
  SERVER_LOCAL_CLAIM_NAME,
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#drivers/k8s/substrate'

/**
 * Nominal: a hostPath PV enforces no quota, and a claim has to ask for
 * SOMETHING for the binder to match it to the volume.
 */
const NOMINAL_CAPACITY = '1Gi'

interface ClaimShape {
  claimName: string
  accessMode: 'ReadWriteMany' | 'ReadWriteOnce'
}

const GLOBAL: ClaimShape = { claimName: GLOBAL_CLAIM_NAME, accessMode: 'ReadWriteMany' }
const SERVER_LOCAL: ClaimShape = { claimName: SERVER_LOCAL_CLAIM_NAME, accessMode: 'ReadWriteOnce' }

/** The PV a claim binds: `<claim>-<install hash>`, cluster-scoped. */
export function storageVolumeName(claimName: string): string {
  return `${claimName}-${dataDirHash()}`
}

function storageLabels(): Record<string, string> {
  return {
    app: SERVER_APP_NAME,
    [LABEL_INSTALL_NAMESPACE]: k8sNamespace(),
    [LABEL_DATA_DIR_HASH]: dataDirHash(),
  }
}

/**
 * A static hostPath PV into the data dir, pre-bound to its claim by
 * `claimRef` so no other claim in any namespace can take it.
 *
 * `type: Directory`, never `DirectoryOrCreate`: a directory the kubelet
 * creates is root-owned, and a root-owned `server-local/` is a database
 * PGlite cannot open. `ensureStorageClaims` pre-creates both as the user.
 */
function buildPvManifest(shape: ClaimShape, hostPath: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: storageVolumeName(shape.claimName), labels: storageLabels() },
    spec: {
      capacity: { storage: NOMINAL_CAPACITY },
      accessModes: [shape.accessMode],
      persistentVolumeReclaimPolicy: 'Retain',
      // The empty class is what makes this a STATIC volume: a claim naming
      // the same empty class binds it and never asks a provisioner.
      storageClassName: '',
      claimRef: { namespace: k8sNamespace(), name: shape.claimName },
      hostPath: { path: hostPath, type: 'Directory' },
    },
  }
}

function buildPvcManifest(shape: ClaimShape): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: shape.claimName, namespace: k8sNamespace(), labels: storageLabels() },
    spec: {
      accessModes: [shape.accessMode],
      storageClassName: '',
      volumeName: storageVolumeName(shape.claimName),
      resources: { requests: { storage: NOMINAL_CAPACITY } },
    },
  }
}

export function buildGlobalPvManifest(opts: { hostPath: string }): Record<string, unknown> {
  return buildPvManifest(GLOBAL, opts.hostPath)
}

export function buildServerLocalPvManifest(opts: { hostPath: string }): Record<string, unknown> {
  return buildPvManifest(SERVER_LOCAL, opts.hostPath)
}

export function buildGlobalPvcManifest(): Record<string, unknown> {
  return buildPvcManifest(GLOBAL)
}

export function buildServerLocalPvcManifest(): Record<string, unknown> {
  return buildPvcManifest(SERVER_LOCAL)
}

/** How long a static pair may take to bind — it is immediate in practice. */
const BIND_TIMEOUT_MS = 60_000

interface RawPvc {
  spec?: { volumeName?: string }
  status?: { phase?: string }
}

/**
 * Create the host directories as the user, apply PV then PVC for each
 * tier, and wait for both claims to read `Bound`.
 *
 * A claim that is already bound to the expected volume is left alone:
 * a claim's spec is immutable after binding, so re-applying an identical
 * manifest is a no-op but a differing one is an apiserver error that
 * should name the claim rather than surface as a generic apply failure.
 * A claim bound ELSEWHERE is exactly that error, raised here with the two
 * volume names.
 */
export async function ensureStorageClaims(opts: {
  globalHostPath: string
  serverLocalHostPath: string
  nodeLocalHostPath: string
  log?: (message: string) => void
}): Promise<void> {
  const log = opts.log ?? (() => { /* quiet by default */ })
  for (const dir of [opts.globalHostPath, opts.serverLocalHostPath, opts.nodeLocalHostPath]) {
    await fs.mkdir(dir, { recursive: true })
  }
  const pairs: Array<[ClaimShape, string]> = [
    [GLOBAL, opts.globalHostPath],
    [SERVER_LOCAL, opts.serverLocalHostPath],
  ]
  for (const [shape, hostPath] of pairs) {
    const existing = await readClaim(shape.claimName)
    const wanted = storageVolumeName(shape.claimName)
    if (existing?.status?.phase === 'Bound') {
      if (existing.spec?.volumeName !== wanted) {
        throw new Error(
          `the ${shape.claimName} claim in namespace ${k8sNamespace()} is bound to `
          + `${existing.spec?.volumeName ?? '<none>'}, not to ${wanted}. A claim's binding `
          + 'is immutable; delete the claim (its volume keeps the data) and re-run '
          + '`yaac cluster install`.',
        )
      }
      continue
    }
    await kubectlApply(buildPvManifest(shape, hostPath))
    // A Retain volume whose claim was deleted (by hand, or with its
    // namespace) is `Released`: its claimRef still carries the old claim's
    // uid, and it binds to nothing until that is cleared. The volume is
    // this install's own, so clear it here rather than fail the bind.
    const pv = await kubectlGetJson<RawPv>(['get', 'pv', wanted])
    if (pv?.status?.phase === 'Released') {
      await kubectlWithRetry([
        'patch', 'pv', wanted, '--type=merge',
        '-p', JSON.stringify({ spec: { claimRef: { uid: null, resourceVersion: null } } }),
      ])
      log(`Storage volume ${wanted} was Released; cleared its stale claim reference.`)
    }
    await kubectlApply(buildPvcManifest(shape))
  }
  const deadline = Date.now() + BIND_TIMEOUT_MS
  for (const [shape] of pairs) {
    for (;;) {
      const claim = await readClaim(shape.claimName)
      if (claim?.status?.phase === 'Bound') break
      if (Date.now() > deadline) {
        throw new Error(
          `the ${shape.claimName} claim did not bind within ${String(BIND_TIMEOUT_MS / 1000)}s `
          + `(phase ${claim?.status?.phase ?? 'absent'}). Inspect it with `
          + `\`kubectl -n ${k8sNamespace()} describe pvc ${shape.claimName}\`.`,
        )
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    log(`Storage claim ${shape.claimName} bound (${storageVolumeName(shape.claimName)}).`)
  }
}

interface RawPv {
  status?: { phase?: string }
}

async function readClaim(name: string): Promise<RawPvc | null> {
  return kubectlGetJson<RawPvc>(['get', 'pvc', name, '-n', k8sNamespace()])
}

/**
 * Delete this install's PVs — the cluster-scoped half of the pair, which
 * does not cascade with the namespace. For the e2e harness; `yaac cluster
 * delete` takes the whole cluster and needs no per-object delete. The
 * hostPath bytes are untouched either way (`Retain`).
 */
export async function deleteStorageVolumes(installNamespace: string): Promise<void> {
  await kubectlWithRetry([
    'delete', 'pv', '-l', `${LABEL_INSTALL_NAMESPACE}=${installNamespace}`,
    '--ignore-not-found', '--wait=false',
  ], { timeout: 30_000, maxAttempts: 1 }).catch(() => { /* cluster gone — nothing to sweep */ })
}
