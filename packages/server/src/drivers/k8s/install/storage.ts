/**
 * The two claims the server workload mounts, and what backs them
 * (docs/server-in-cluster.md "Storage is two claims").
 *
 * `yaac-global` (RWX) carries the GLOBAL tier: the server pod mounts it
 * whole and every workspace pod mounts subPaths of it. `yaac-server-local`
 * (RWO) carries the SERVER-LOCAL tier and is the server's alone. The claims
 * are the same on every backend; what differs is the volume behind each,
 * and that is the storage SHAPE install hands in:
 *
 *  - `static` (kind): a hostPath PV per claim into the host's data dir —
 *    `<dataDir>/global` and `<dataDir>/server-local` — so the bytes stay on
 *    the host disk under `~/.yaac`, and `yaac cluster delete` keeps
 *    touching none of them. Kubernetes enforces no access mode on hostPath,
 *    so the claim spec is the one the class shape binds.
 *  - `classes` (byo): each claim provisioned from a named StorageClass — an
 *    NFS-family class for the RWX one, any block class for the RWO one —
 *    then claimed for the install and made its uid's by a one-shot binder
 *    pod, pinned `Retain`, given the NFS coherence option on the RWX
 *    volume, and labelled with the install id so this install — and only
 *    this one — finds it again after a namespace delete.
 *
 * Either way every volume is `Retain`: a claim or namespace delete never
 * takes the data with it. PV names and labels carry `dataDirHash()` because
 * PVs are cluster-scoped and one cluster hosts more than one install (the
 * real one, and every e2e namespace); the claims are namespaced and carry
 * no hash, because a namespace belongs to one install. The hash names a
 * static volume, whose host path is this machine's own; a class volume is
 * matched by the install id, because the same data-dir path on two
 * machines is two installs.
 *
 * Install-only, like the rest of this folder: the server references the
 * claim names and never applies a claim.
 */
import fs from 'node:fs/promises'
import {
  GLOBAL_CLAIM_NAME,
  LABEL_CLAIM,
  LABEL_DATA_DIR_HASH,
  LABEL_INSTALL_ID,
  LABEL_INSTALL_NAMESPACE,
  SERVER_APP_NAME,
  SERVER_LOCAL_CLAIM_NAME,
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  runPodToCompletion,
  type InstallIdentity,
} from '#drivers/k8s/substrate'

/**
 * Nominal: a hostPath PV enforces no quota, and a claim has to ask for
 * SOMETHING for the binder to match it to the volume.
 */
const NOMINAL_CAPACITY = '1Gi'

/**
 * What a class-provisioned claim asks for. The RWX size is nominal as
 * well — the NFS-family drivers provision a directory or an elastic share
 * and enforce no quota at it — while the RWO one is a real disk: the
 * database, the logs, the build scratch and any downloaded models.
 */
const CLASS_CAPACITY = { ReadWriteMany: '100Gi', ReadWriteOnce: '50Gi' } as const

interface ClaimShape {
  claimName: string
  accessMode: 'ReadWriteMany' | 'ReadWriteOnce'
}

const GLOBAL: ClaimShape = { claimName: GLOBAL_CLAIM_NAME, accessMode: 'ReadWriteMany' }
const SERVER_LOCAL: ClaimShape = { claimName: SERVER_LOCAL_CLAIM_NAME, accessMode: 'ReadWriteOnce' }

/** What backs the two claims: see the module comment. */
export type StorageShape =
  | {
    kind: 'static'
    globalHostPath: string
    serverLocalHostPath: string
    nodeLocalHostPath: string
  }
  | {
    kind: 'classes'
    /** The NFS-family class `yaac-global` is provisioned from. */
    rwx: string
    /** The class `yaac-server-local` is provisioned from. */
    rwo: string
    /** Who each volume root is made to belong to. */
    identity: InstallIdentity
    /** Which install the volumes are (`server.json`'s `installId`). */
    installId: string
    /** An image in the cluster registry with `sh`, `stat` and `chown` —
     *  the binder pod's. */
    binderImage: string
  }

/** The PV a static claim binds: `<claim>-<install hash>`, cluster-scoped. */
function staticVolumeName(claimName: string): string {
  return `${claimName}-${dataDirHash()}`
}

/**
 * The install's labels on a storage object. `LABEL_CLAIM` and
 * `LABEL_INSTALL_ID` are what re-adoption finds a Released class volume by
 * — its name is the provisioner's, not ours.
 */
function storageLabels(claimName: string, installId?: string): Record<string, string> {
  return {
    app: SERVER_APP_NAME,
    [LABEL_INSTALL_NAMESPACE]: k8sNamespace(),
    [LABEL_DATA_DIR_HASH]: dataDirHash(),
    [LABEL_CLAIM]: claimName,
    ...(installId ? { [LABEL_INSTALL_ID]: installId } : {}),
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
function buildStaticPvManifest(shape: ClaimShape, hostPath: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: staticVolumeName(shape.claimName), labels: storageLabels(shape.claimName) },
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

/**
 * A claim naming its class, and — when it is re-adopting a volume of this
 * install — that volume, which pre-binds it rather than provisioning.
 */
function buildPvcManifest(
  shape: ClaimShape,
  opts: { storageClassName: string; volumeName?: string; storage: string },
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: shape.claimName, namespace: k8sNamespace(), labels: storageLabels(shape.claimName) },
    spec: {
      accessModes: [shape.accessMode],
      storageClassName: opts.storageClassName,
      ...(opts.volumeName ? { volumeName: opts.volumeName } : {}),
      resources: { requests: { storage: opts.storage } },
    },
  }
}

/** How long a claim may take to bind once something consumes it. */
const BIND_TIMEOUT_MS = 60_000
/** How long the binder may take: a provisioner, an attach and an image pull. */
const BINDER_TIMEOUT_MS = 300_000
const BINDER_POD_NAME = 'yaac-storage-bind'

interface RawPvc {
  spec?: { volumeName?: string; storageClassName?: string }
  status?: { phase?: string }
}

interface RawPv {
  metadata?: { name?: string; labels?: Record<string, string> }
  spec?: {
    storageClassName?: string
    capacity?: { storage?: string }
    mountOptions?: string[]
    claimRef?: { namespace?: string; name?: string }
  }
  status?: { phase?: string }
}

/**
 * Converge both claims for the storage shape, and wait for both to read
 * `Bound`.
 *
 * A claim that is already bound is left alone — a claim's spec is
 * immutable after binding, so re-applying a differing one is an apiserver
 * error that should name the claim rather than surface as a generic apply
 * failure. A claim bound to some OTHER volume (static) or through some
 * other class (classes) is exactly that error, raised here with both names.
 */
export async function ensureStorageClaims(opts: {
  shape: StorageShape
  log?: (message: string) => void
}): Promise<void> {
  const log = opts.log ?? (() => { /* quiet by default */ })
  if (opts.shape.kind === 'static') await ensureStaticClaims(opts.shape, log)
  else await ensureClassClaims(opts.shape, log)
}

async function ensureStaticClaims(
  shape: Extract<StorageShape, { kind: 'static' }>,
  log: (message: string) => void,
): Promise<void> {
  for (const dir of [shape.globalHostPath, shape.serverLocalHostPath, shape.nodeLocalHostPath]) {
    await fs.mkdir(dir, { recursive: true })
  }
  const pairs: Array<[ClaimShape, string]> = [
    [GLOBAL, shape.globalHostPath],
    [SERVER_LOCAL, shape.serverLocalHostPath],
  ]
  for (const [claim, hostPath] of pairs) {
    const existing = await readClaim(claim.claimName)
    const wanted = staticVolumeName(claim.claimName)
    if (existing?.status?.phase === 'Bound') {
      if (existing.spec?.volumeName !== wanted) {
        throw new Error(
          `the ${claim.claimName} claim in namespace ${k8sNamespace()} is bound to `
          + `${existing.spec?.volumeName ?? '<none>'}, not to ${wanted}. A claim's binding `
          + 'is immutable; delete the claim (its volume keeps the data) and re-run '
          + '`yaac cluster install`.',
        )
      }
      continue
    }
    await kubectlApply(buildStaticPvManifest(claim, hostPath))
    const pv = await kubectlGetJson<RawPv>(['get', 'pv', wanted])
    if (pv?.status?.phase === 'Released') await clearStaleClaimRef(wanted, claim, log)
    await kubectlApply(buildPvcManifest(claim, {
      storageClassName: '', volumeName: wanted, storage: NOMINAL_CAPACITY,
    }))
  }
  await waitForBound([GLOBAL, SERVER_LOCAL], log)
}

/**
 * The class path, in the order that makes every step load-bearing:
 * re-adopt a Released volume of this install before provisioning a new
 * one; apply the claims; run the binder, which is the first consumer a
 * `WaitForFirstConsumer` class needs and the one place a volume root is
 * made the install uid's; then pin and label what bound.
 */
async function ensureClassClaims(
  shape: Extract<StorageShape, { kind: 'classes' }>,
  log: (message: string) => void,
): Promise<void> {
  const pairs: Array<[ClaimShape, string]> = [[GLOBAL, shape.rwx], [SERVER_LOCAL, shape.rwo]]
  for (const [claim, className] of pairs) {
    const existing = await readClaim(claim.claimName)
    if (existing) {
      const bound = existing.spec?.storageClassName ?? ''
      if (bound !== className) {
        throw new Error(
          `the ${claim.claimName} claim in namespace ${k8sNamespace()} is provisioned `
          + `through class "${bound}", not "${className}". A claim's class is immutable, `
          + 'and the data is on the volume it already has: re-run with the class it was '
          + 'installed with.',
        )
      }
      continue
    }
    const adopted = await readoptVolume(claim, className, shape.installId, log)
    await kubectlApply(buildPvcManifest(claim, adopted
      ? { storageClassName: adopted.storageClassName, volumeName: adopted.name, storage: adopted.storage }
      : { storageClassName: className, storage: CLASS_CAPACITY[claim.accessMode] }))
  }
  await runBinder(shape, log)
  await waitForBound([GLOBAL, SERVER_LOCAL], log)
  for (const [claim] of pairs) await pinVolume(claim, shape.installId)
}

/**
 * Re-adopt a volume of this install that lost its claim. `Retain` only
 * protects data a later install can find again: a namespace delete leaves
 * both volumes `Released`, and a fresh claim would otherwise provision two
 * empty volumes beside them. So look for one carrying this install's id,
 * namespace and the claim's name, clear the stale claim reference if it is
 * Released, and hand back what the new claim must name to pre-bind it.
 *
 * Refused rather than guessed at: this install's volume under another
 * class (the claim would silently skip the class gate), and a volume left
 * from this data-dir PATH by another install — the same path on another
 * machine, or this one's `server.json` lost — which is someone's database
 * and credentials, adopted only on purpose.
 */
async function readoptVolume(
  claim: ClaimShape,
  className: string,
  installId: string,
  log: (message: string) => void,
): Promise<{ name: string; storageClassName: string; storage: string } | undefined> {
  const list = await kubectlGetJson<{ items?: RawPv[] }>([
    'get', 'pv', '-l', `${LABEL_CLAIM}=${claim.claimName},${LABEL_INSTALL_NAMESPACE}=${k8sNamespace()}`,
  ])
  const loose = (list?.items ?? []).filter((v) =>
    v.status?.phase === 'Released' || v.status?.phase === 'Available')
  const pv = loose.find((v) => v.metadata?.labels?.[LABEL_INSTALL_ID] === installId)
  const name = pv?.metadata?.name
  if (!pv || !name) {
    const foreign = loose.find((v) => v.metadata?.labels?.[LABEL_DATA_DIR_HASH] === dataDirHash())
    if (foreign) {
      const other = foreign.metadata?.name ?? '?'
      throw new Error(
        `the volume ${other} was left in namespace ${k8sNamespace()} for ${claim.claimName} by an install `
        + 'from this same data-dir path, but not by this one (its install id is '
        + `${foreign.metadata?.labels?.[LABEL_INSTALL_ID] ?? 'unset'}, this install's is ${installId}). `
        + 'It holds that install\'s database and credentials, so it is not adopted by default. '
        + `To adopt it on purpose:\n  kubectl label pv ${other} ${LABEL_INSTALL_ID}=${installId} --overwrite\n`
        + `To leave it be and provision a fresh volume:\n  kubectl label pv ${other} ${LABEL_DATA_DIR_HASH}-`,
      )
    }
    return undefined
  }
  const pvClass = pv.spec?.storageClassName ?? ''
  if (pvClass !== className) {
    throw new Error(
      `this install's ${claim.claimName} volume ${name} is in class "${pvClass}", not "${className}": `
      + 'the data is on it, so re-run with the class it was installed with.',
    )
  }
  if (pv.status?.phase === 'Released') await clearStaleClaimRef(name, claim, log)
  log(`Re-adopting ${claim.claimName}'s volume ${name} (it outlived its claim).`)
  return {
    name,
    storageClassName: pvClass,
    storage: pv.spec?.capacity?.storage ?? NOMINAL_CAPACITY,
  }
}

/**
 * A Retain volume whose claim was deleted (by hand, or with its namespace)
 * is `Released`: its claimRef still carries the old claim's uid, and it
 * binds to nothing until that is cleared. Pointed at the claim about to be
 * applied, in this namespace, so nothing else can take it meanwhile.
 */
async function clearStaleClaimRef(
  volume: string,
  claim: ClaimShape,
  log: (message: string) => void,
): Promise<void> {
  await kubectlWithRetry([
    'patch', 'pv', volume, '--type=merge',
    '-p', JSON.stringify({
      spec: {
        claimRef: { namespace: k8sNamespace(), name: claim.claimName, uid: null, resourceVersion: null },
      },
    }),
  ])
  log(`Storage volume ${volume} was Released; cleared its stale claim reference.`)
}

/**
 * The file at each volume root that says which install the root is.
 * Claimed by the binder, never by the server, and checked on every run.
 */
const INSTALL_MARKER = '.yaac-install'

/**
 * The binder's script. For each volume root: refuse it if it is another
 * install's — a marker naming another install id, or no marker over
 * content (`lost+found` aside, which a freshly formatted block volume
 * carries) — and otherwise claim it with this install's marker, chown it
 * (never recursively: everything below the root is created by the server
 * at that identity) and make it setgid group-writable. A refusal is
 * reported by name and fails the pod; nothing is retried.
 *
 * The marker, not the owner, is what tells installs apart: every byo
 * install runs as the same uid, and a class with a fixed `subDir` or base
 * path hands every claim the SAME directory, so a second install on it
 * would otherwise be handed the first one's data and write into it.
 */
const BINDER_SCRIPT = [
  'uid=$1; gid=$2; id=$3; rc=0',
  'for m in /claims/global /claims/server-local; do',
  `  mark="$m/${INSTALL_MARKER}"`,
  '  if [ -f "$mark" ]; then',
  '    if [ "$(cat "$mark")" != "$id" ]; then echo "BIND_FOREIGN=$m=$(cat "$mark")"; rc=1; continue; fi',
  '  elif [ -n "$(ls -A "$m" | grep -vx lost+found)" ]; then',
  '    echo "BIND_FOREIGN=$m="; rc=1; continue',
  '  elif ! printf %s "$id" > "$mark"; then',
  '    echo "BIND_REFUSED=$m"; rc=1; continue',
  '  fi',
  '  if [ "$(stat -c %u:%g "$m")" != "$uid:$gid" ]; then',
  '    if chown "$uid:$gid" "$m" "$mark"; then echo "BIND_CHOWNED=$m"; else echo "BIND_REFUSED=$m"; rc=1; continue; fi',
  '  fi',
  '  if [ "$(stat -c %a "$m")" != 2775 ]; then',
  '    chmod 2775 "$m" || { echo "BIND_REFUSED=$m"; rc=1; }',
  '  fi',
  'done',
  'exit $rc',
].join('\n')

/**
 * The one-shot binder pod: runc, root, mounting both claims. It is the
 * first consumer a `WaitForFirstConsumer` class — the usual block class,
 * and local-path's — waits for before binding anything, so install cannot
 * wait on `Bound` alone; and it makes each volume root the install uid's,
 * once. That replaces `fsGroup`, which is the kubelet doing the same chown
 * as root on every mount of every pod, and which root squash defeats
 * exactly as it defeats this — except that this fails loudly, once.
 */
async function runBinder(
  shape: Extract<StorageShape, { kind: 'classes' }>,
  log: (message: string) => void,
): Promise<void> {
  log('Binding the storage claims (a one-shot pod that owns each volume root)...')
  const { phase, logs } = await runPodToCompletion({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: BINDER_POD_NAME, namespace: k8sNamespace(), labels: { app: BINDER_POD_NAME } },
    spec: {
      restartPolicy: 'Never',
      // An aborted install leaves nothing lingering past this.
      activeDeadlineSeconds: BINDER_TIMEOUT_MS / 1000,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: { runAsUser: 0, runAsGroup: 0 },
      containers: [{
        name: 'bind',
        image: shape.binderImage,
        imagePullPolicy: 'IfNotPresent',
        command: [
          'sh', '-c', BINDER_SCRIPT, '--', String(shape.identity.uid), String(shape.identity.gid), shape.installId,
        ],
        volumeMounts: [
          { name: 'global', mountPath: '/claims/global' },
          { name: 'server-local', mountPath: '/claims/server-local' },
        ],
      }],
      volumes: [
        { name: 'global', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } },
        { name: 'server-local', persistentVolumeClaim: { claimName: SERVER_LOCAL_CLAIM_NAME } },
      ],
    },
  }, { timeoutMs: BINDER_TIMEOUT_MS })
  for (const line of logs.split('\n')) {
    const chowned = /^BIND_CHOWNED=(.*)$/.exec(line)?.[1]
    if (chowned) log(`  ${chowned} now belongs to uid ${String(shape.identity.uid)}.`)
  }
  const foreign = logs.split('\n').map((l) => /^BIND_FOREIGN=([^=]*)=(.*)$/.exec(l)).filter((m) => m !== null)
  if (foreign.length > 0) {
    throw new Error(
      `${foreign.map(([, root, other]) => `${root} already holds ${other ? `the install ${other}'s` : 'someone else\'s'} data`)
        .join(', and ')}, not this install's (${shape.installId}), so nothing was written to it. A class `
      + 'that gives every claim the same directory — a fixed `subDir` or base path — cannot host two '
      + 'installs: use a class that provisions a directory per volume. If it IS this install\'s data and '
      + 'its record was lost, restore the server.json that names that install id instead.',
    )
  }
  const refused = logs.split('\n').map((l) => /^BIND_REFUSED=(.*)$/.exec(l)?.[1]).filter(Boolean)
  if (refused.length > 0) {
    throw new Error(
      `the storage binder could not make ${refused.join(' and ')} belong to uid `
      + `${String(shape.identity.uid)}: the volume refuses root's chown, which is what an NFS `
      + 'export that squashes root does. Serve the export with no_root_squash '
      + '(ganesha: `Squash = No_Root_Squash`), or set the class\'s `mountPermissions` '
      + 'so the provisioner creates the directory writable, then re-run `yaac cluster install`.',
    )
  }
  if (phase !== 'Succeeded') {
    throw new Error(
      `the storage binder pod ended in phase ${phase}, so the claims did not bind `
      + `(${logs.trim().split('\n').pop() ?? 'no output'}). Inspect the claims with `
      + `\`kubectl -n ${k8sNamespace()} describe pvc ${GLOBAL_CLAIM_NAME} ${SERVER_LOCAL_CLAIM_NAME}\`: `
      + 'a class whose provisioner is not running leaves them Pending.',
    )
  }
}

async function waitForBound(claims: ClaimShape[], log: (message: string) => void): Promise<void> {
  const deadline = Date.now() + BIND_TIMEOUT_MS
  for (const claim of claims) {
    let bound: RawPvc | null
    for (;;) {
      bound = await readClaim(claim.claimName)
      if (bound?.status?.phase === 'Bound') break
      if (Date.now() > deadline) {
        throw new Error(
          `the ${claim.claimName} claim did not bind within ${String(BIND_TIMEOUT_MS / 1000)}s `
          + `(phase ${bound?.status?.phase ?? 'absent'}). Inspect it with `
          + `\`kubectl -n ${k8sNamespace()} describe pvc ${claim.claimName}\`.`,
        )
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    log(`Storage claim ${claim.claimName} bound (${bound.spec?.volumeName ?? '?'}).`)
  }
}

/**
 * Make a class-provisioned volume this install's, after it bound: `Retain`
 * whatever the class said, the install's labels, and on the RWX volume the
 * NFS coherence option — the spike's finding (`actimeo=1`), applied to the
 * volume yaac owns rather than demanded of a class the operator owns. The
 * binder's own mount predates the options and is gone before any real pod
 * mounts the volume, and a PV's `mountOptions` are read at each mount.
 */
async function pinVolume(claim: ClaimShape, installId: string): Promise<void> {
  const pvc = await readClaim(claim.claimName)
  const volume = pvc?.spec?.volumeName
  if (!volume) return
  const pv = await kubectlGetJson<RawPv>(['get', 'pv', volume])
  await kubectlWithRetry([
    'patch', 'pv', volume, '--type=merge',
    '-p', JSON.stringify({
      metadata: { labels: storageLabels(claim.claimName, installId) },
      spec: {
        persistentVolumeReclaimPolicy: 'Retain',
        ...(claim.accessMode === 'ReadWriteMany'
          ? { mountOptions: withNfsCoherence(pv?.spec?.mountOptions ?? []) }
          : {}),
      },
    }),
  ])
}

/**
 * An RWX volume's mount options with yaac's coherence bound merged in:
 * `actimeo=1` bounds how long one client serves another's stale
 * attributes (cross-client visibility of 25–57ms in the spike, against
 * NFS's default of up to a minute). It costs a GETATTR per file per second
 * of use, which on EFS is billed latency — the price of a workspace seeing
 * the server's writes before its agent acts on them. Every other option the
 * class set is kept, `soft` or `hard` included: that trade (an EIO versus a
 * hang when the server goes away) is the operator's, and Linux's default is
 * `hard` (docs/cluster-setup.md "Bring your own cluster").
 */
export function withNfsCoherence(options: string[]): string[] {
  const superseded = /^(actimeo|acregmin|acregmax|acdirmin|acdirmax)=|^noac$/
  return [...options.filter((o) => !superseded.test(o)), 'actimeo=1']
}

/**
 * Whether a StorageClass (or a volume, by its CSI driver) is NFS-family —
 * the only RWX kind the spike measured, and so the only one a byo install
 * accepts for the global claim. Azure Files counts only when it speaks NFS.
 */
export function isNfsFamily(provisioner: string, parameters: Record<string, string> = {}): boolean {
  if (provisioner === 'nfs.csi.k8s.io' || provisioner === 'efs.csi.aws.com') return true
  return provisioner === 'file.csi.azure.com' && parameters.protocol?.toLowerCase() === 'nfs'
}

async function readClaim(name: string): Promise<RawPvc | null> {
  return kubectlGetJson<RawPvc>(['get', 'pvc', name, '-n', k8sNamespace()])
}

/**
 * Delete this install's PVs — the cluster-scoped half of the pair, which
 * does not cascade with the namespace. For the e2e harness; `yaac cluster
 * delete` takes the whole cluster and needs no per-object delete. The
 * bytes are untouched either way (`Retain`).
 */
export async function deleteStorageVolumes(installNamespace: string): Promise<void> {
  await kubectlWithRetry([
    'delete', 'pv', '-l', `${LABEL_INSTALL_NAMESPACE}=${installNamespace}`,
    '--ignore-not-found', '--wait=false',
  ], { timeout: 30_000, maxAttempts: 1 }).catch(() => { /* cluster gone — nothing to sweep */ })
}
