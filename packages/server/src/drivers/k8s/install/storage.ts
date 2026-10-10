/**
 * The install's claims, and the volumes behind them
 * (docs/server-in-cluster.md "Storage claims"). `yaac-global` (RWX) holds
 * the global tier: the server mounts it whole and workspace pods mount
 * subPaths. `yaac-server-local` (RWO) is the server's alone.
 * `yaac-checkouts` is a second volume over the global tier's directory,
 * through which workspace pods mount their checkout with longer attribute
 * caching (docs/nfs-checkout-performance.md).
 *
 * The storage shape decides what backs them:
 *  - `static` (kind): a hostPath PV per claim into the host's data dir, so
 *    the data stays on the host and survives `yaac cluster delete`.
 *  - `classes` (byo): `yaac-global` and `yaac-server-local` are provisioned
 *    from named StorageClasses (NFS-family for RWX), then a one-shot binder
 *    pod claims each volume root for this install, and the volume is
 *    labeled with the install id. `yaac-checkouts` binds a static copy of
 *    the global volume.
 *
 * Every volume is `Retain`, so deleting a claim or namespace keeps the
 * data. PVs are cluster-scoped and shared by several installs, so static PV
 * names carry `dataDirHash()`; class volumes are matched by install id.
 */
import fs from 'node:fs/promises'
import {
  CHECKOUTS_CLAIM_NAME,
  GLOBAL_CLAIM_NAME,
  LABEL_CLAIM,
  LABEL_DATA_DIR_HASH,
  LABEL_INSTALL_ID,
  LABEL_INSTALL_NAMESPACE,
  SERVER_APP_NAME,
  SERVER_LOCAL_CLAIM_NAME,
  applyObject,
  dataDirHash,
  deleteObjects,
  k8sNamespace,
  listObjects,
  patchObject,
  readObject,
  runPodToCompletion,
  type InstallIdentity,
} from '#drivers/k8s/substrate'

/** Nominal size: hostPath enforces no quota, but a claim must ask for one. */
const NOMINAL_CAPACITY = '1Gi'

/**
 * Size requested by class-provisioned claims. RWX is nominal (NFS-family
 * drivers enforce no quota); RWO is a real disk holding the database,
 * logs, build scratch and downloaded models.
 */
const CLASS_CAPACITY = { ReadWriteMany: '100Gi', ReadWriteOnce: '50Gi' } as const

interface ClaimShape {
  claimName: string
  accessMode: 'ReadWriteMany' | 'ReadWriteOnce'
}

const GLOBAL: ClaimShape = { claimName: GLOBAL_CLAIM_NAME, accessMode: 'ReadWriteMany' }
const SERVER_LOCAL: ClaimShape = { claimName: SERVER_LOCAL_CLAIM_NAME, accessMode: 'ReadWriteOnce' }
const CHECKOUTS: ClaimShape = { claimName: CHECKOUTS_CLAIM_NAME, accessMode: 'ReadWriteMany' }

/** What backs the claims: see the module comment. */
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
    /** Which install the volumes are (`install.json`'s `installId`). */
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
 * Labels on a storage object. Re-adoption finds a Released class volume by
 * `LABEL_CLAIM` and `LABEL_INSTALL_ID`, since the provisioner names it.
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
 * A static hostPath PV into the data dir, pre-bound to its claim. Uses
 * `type: Directory` because kubelet would create a missing directory as
 * root, which PGlite cannot open; `ensureStorageClaims` creates both
 * directories as the user first.
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
      // Empty class: a static volume, never provisioned.
      storageClassName: '',
      claimRef: { namespace: k8sNamespace(), name: shape.claimName },
      hostPath: { path: hostPath, type: 'Directory' },
    },
  }
}

/** A claim; with `volumeName` it pre-binds to an existing volume. */
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
    csi?: { driver?: string; volumeHandle?: string } & Record<string, unknown>
  }
  status?: { phase?: string }
}

/**
 * Create the claims for the storage shape and wait until all are
 * `Bound`. An existing claim is left alone, since a bound claim's spec is
 * immutable; if it is bound to a different volume or class, this throws
 * a message naming both.
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
  // The checkouts volume needs no mount options here: a hostPath mount
  // caches nothing.
  const pairs: Array<[ClaimShape, string]> = [
    [GLOBAL, shape.globalHostPath],
    [SERVER_LOCAL, shape.serverLocalHostPath],
    [CHECKOUTS, shape.globalHostPath],
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
    await applyObject(buildStaticPvManifest(claim, hostPath))
    const pv = await readVolume(wanted)
    if (pv?.status?.phase === 'Released') await clearStaleClaimRef(wanted, claim, log)
    await applyObject(buildPvcManifest(claim, {
      storageClassName: '', volumeName: wanted, storage: NOMINAL_CAPACITY,
    }))
  }
  await waitForBound([GLOBAL, SERVER_LOCAL, CHECKOUTS], log)
}

/**
 * Class-provisioned claims: re-adopt this install's Released volumes, apply
 * the claims, run the binder (the first consumer a `WaitForFirstConsumer`
 * class waits for), then pin and label the bound volumes.
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
    await applyObject(buildPvcManifest(claim, adopted
      ? { storageClassName: adopted.storageClassName, volumeName: adopted.name, storage: adopted.storage }
      : { storageClassName: className, storage: CLASS_CAPACITY[claim.accessMode] }))
  }
  await runBinder(shape, log)
  await waitForBound([GLOBAL, SERVER_LOCAL], log)
  for (const [claim] of pairs) await pinVolume(claim, shape.installId)
  await ensureCheckoutsClaim(shape.installId, log)
}

/**
 * Bind `yaac-checkouts` to a static copy of the bound global volume: the
 * same directory through the same driver, but with checkout caching mount
 * options. Kubernetes has no per-pod mount options, so a second volume is
 * the only way to mount one directory two ways. The copy is named after the
 * global volume, whose CSI block cannot change, so an existing copy is
 * already right.
 */
async function ensureCheckoutsClaim(installId: string, log: (message: string) => void): Promise<void> {
  const globalVolume = (await readClaim(GLOBAL_CLAIM_NAME))?.spec?.volumeName
  const source = globalVolume ? await readVolume(globalVolume) : null
  const csi = source?.spec?.csi
  if (!globalVolume || !csi?.driver || !csi.volumeHandle) {
    throw new Error(`the ${GLOBAL_CLAIM_NAME} volume ${globalVolume ?? '<unbound>'} is not a CSI volume, `
      + `so ${CHECKOUTS_CLAIM_NAME} cannot mount the same directory`)
  }
  const name = `${globalVolume}-checkouts`
  if ((await readVolume(name))?.status?.phase === 'Released') await clearStaleClaimRef(name, CHECKOUTS, log)
  await applyObject({
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name, labels: storageLabels(CHECKOUTS_CLAIM_NAME, installId) },
    spec: {
      capacity: { storage: source?.spec?.capacity?.storage ?? NOMINAL_CAPACITY },
      accessModes: [CHECKOUTS.accessMode],
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: '',
      mountOptions: withCheckoutCaching(source?.spec?.mountOptions ?? []),
      claimRef: { namespace: k8sNamespace(), name: CHECKOUTS_CLAIM_NAME },
      csi: { ...csi, volumeHandle: checkoutsVolumeHandle(csi.driver, csi.volumeHandle) },
    },
  })
  if (!await readClaim(CHECKOUTS_CLAIM_NAME)) {
    await applyObject(buildPvcManifest(CHECKOUTS, { storageClassName: '', volumeName: name, storage: NOMINAL_CAPACITY }))
  }
  await waitForBound([CHECKOUTS], log)
}

/**
 * The global volume's handle, rewritten so it names the same directory but
 * differs as a string. kubelet keys a CSI volume by driver and handle, so
 * two volumes sharing a handle would be mounted once in a pod that uses
 * both. Each NFS-family driver (`isNfsFamily`) has its own handle format:
 *
 * - csi-driver-nfs mounts from the volume's attributes and only needs the
 *   handle to be unique, so a suffix is enough.
 * - The EFS driver reads `[efs:]<fs id>[:<path>[:<access point>]]`; an empty
 *   path and `/` mount the same directory, as do `/x` and `/x/`.
 * - The Azure Files driver reads `#`-separated fields whose fifth is a
 *   free-form uuid, there to tell apart handles for one share. With no
 *   resource group (the first field) it reads the fifth as a secret
 *   namespace instead, so that form is refused.
 */
function checkoutsVolumeHandle(driver: string, handle: string): string {
  switch (driver) {
    case 'nfs.csi.k8s.io':
      return `${handle}#checkouts`
    case 'efs.csi.aws.com': {
      const parts = handle.split(':')
      const at = parts[0] === 'efs' ? 2 : 1
      while (parts.length <= at) parts.push('')
      const p = parts[at]
      parts[at] = p === '' ? '/' : p === '/' ? '' : p.endsWith('/') ? p.slice(0, -1) : `${p}/`
      return parts.join(':')
    }
    case 'file.csi.azure.com': {
      const fields = handle.split('#')
      if (fields[0] === '') {
        throw new Error(`the Azure Files volume handle ${handle} names no resource group, so its fifth field `
          + 'is a secret namespace yaac cannot vary to mount the share a second way')
      }
      while (fields.length < 5) fields.push('')
      fields[4] = `${fields[4]}checkouts`
      return fields.join('#')
    }
    default:
      throw new Error(`${driver} is not an NFS-family CSI driver yaac can mount a second way`)
  }
}

/**
 * Find this install's volume for a claim that was deleted (e.g. with its
 * namespace), so the new claim binds to it instead of provisioning an empty
 * one. Returns what the claim must name, or undefined if there is none.
 *
 * Throws when this install's volume is in a different class, or when a
 * volume from the same data-dir path belongs to a different install id
 * (another machine, or a lost `install.json`); the latter is only adopted
 * when the user relabels it.
 */
async function readoptVolume(
  claim: ClaimShape,
  className: string,
  installId: string,
  log: (message: string) => void,
): Promise<{ name: string; storageClassName: string; storage: string } | undefined> {
  const volumes = await listObjects<RawPv>('v1', 'PersistentVolume', {
    labelSelector: `${LABEL_CLAIM}=${claim.claimName},${LABEL_INSTALL_NAMESPACE}=${k8sNamespace()}`,
  })
  const loose = volumes.filter((v) =>
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
 * A Released volume's claimRef still holds the deleted claim's uid, so it
 * binds to nothing. Point it at the claim about to be applied.
 */
async function clearStaleClaimRef(
  volume: string,
  claim: ClaimShape,
  log: (message: string) => void,
): Promise<void> {
  await patchObject(volumeRef(volume), {
    spec: {
      claimRef: { namespace: k8sNamespace(), name: claim.claimName, uid: null, resourceVersion: null },
    },
  })
  log(`Storage volume ${volume} was Released; cleared its stale claim reference.`)
}

/** File at each volume root naming the install that owns it. */
const INSTALL_MARKER = '.yaac-install'

/**
 * The binder's script. For each volume root it refuses one that belongs to
 * another install (a marker with another id, or unmarked content besides
 * `lost+found`). Otherwise it writes this install's marker, chowns the root
 * (not recursively) and makes it setgid group-writable. Refusals are
 * printed and fail the pod.
 *
 * A marker is needed because every byo install runs as the same uid, and a
 * class with a fixed `subDir` gives every claim the same directory.
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
 * Run the one-shot binder pod (root, mounting both claims). It is the
 * first consumer that a `WaitForFirstConsumer` class waits for, and it
 * chowns each volume root once, instead of `fsGroup` chowning on every
 * mount. If NFS root squash blocks the chown, it fails with a clear error.
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
      + 'its record was lost, restore the install.json that names that install id instead.',
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

/** Wait for every claim to bind, then log the volume each bound to. */
async function waitForBound(claims: ClaimShape[], log: (message: string) => void): Promise<void> {
  const deadline = Date.now() + BIND_TIMEOUT_MS
  // A failed read counts as not bound yet; the deadline judges.
  const read = (name: string) => readClaim(name).catch(() => null)
  for (const claim of claims) {
    let bound = await read(claim.claimName)
    while (bound?.status?.phase !== 'Bound' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000))
      bound = await read(claim.claimName)
    }
    if (bound?.status?.phase !== 'Bound') {
      throw new Error(
        `the ${claim.claimName} claim did not bind within ${String(BIND_TIMEOUT_MS / 1000)}s `
        + `(phase ${bound?.status?.phase ?? 'absent'}). Inspect it with `
        + `\`kubectl -n ${k8sNamespace()} describe pvc ${claim.claimName}\`.`,
      )
    }
    log(`Storage claim ${claim.claimName} bound (${bound.spec?.volumeName ?? '?'}).`)
  }
}

/**
 * After a class volume binds, set it to `Retain`, add the install's labels,
 * and on the RWX volume add the NFS coherence mount option. Mount options
 * are read at each mount, so later pods get them.
 */
async function pinVolume(claim: ClaimShape, installId: string): Promise<void> {
  const pvc = await readClaim(claim.claimName)
  const volume = pvc?.spec?.volumeName
  if (!volume) return
  const pv = await readVolume(volume)
  await patchObject(volumeRef(volume), {
    metadata: { labels: storageLabels(claim.claimName, installId) },
    spec: {
      persistentVolumeReclaimPolicy: 'Retain',
      ...(claim.accessMode === 'ReadWriteMany'
        ? { mountOptions: withNfsCoherence(pv?.spec?.mountOptions ?? []) }
        : {}),
    },
  })
}

const ATTRIBUTE_CACHE_OPTION = /^(actimeo|acregmin|acregmax|acdirmin|acdirmax)=|^noac$/

/**
 * Add `actimeo=1` to an RWX volume's mount options, replacing any
 * attribute-cache options. It keeps NFS clients from seeing each other's
 * stale attributes for up to a minute (measured 25–57ms visibility with
 * it), at the cost of a GETATTR per file per second. Other options,
 * including `soft`/`hard`, are kept (docs/cluster-setup.md "Bring your
 * own cluster").
 */
function withNfsCoherence(options: string[]): string[] {
  return [...options.filter((o) => !ATTRIBUTE_CACHE_OPTION.test(o)), 'actimeo=1']
}

/**
 * The checkouts volume's attribute caching. File attributes are cached for
 * 3 to 60 seconds, so a warm `git status` stats from the cache; directory
 * attributes for at most a second, so a file another machine creates,
 * deletes or renames in (the server writing `.git`, the file editor) shows
 * within a second. An edit to an existing file can stay unseen by `stat`
 * for up to a minute unless the file is opened, which revalidates it; the
 * file editor opens what it writes in the workspace for that reason.
 */
export const CHECKOUT_CACHE_OPTIONS = ['acregmin=3', 'acregmax=60', 'acdirmin=1', 'acdirmax=1']

function withCheckoutCaching(options: string[]): string[] {
  return [...options.filter((o) => !ATTRIBUTE_CACHE_OPTION.test(o)), ...CHECKOUT_CACHE_OPTIONS]
}

/**
 * Whether a StorageClass or CSI driver is NFS-family, the only RWX kind a
 * byo install accepts for the global claim. Azure Files counts only over
 * NFS.
 */
export function isNfsFamily(provisioner: string, parameters: Record<string, string> = {}): boolean {
  if (provisioner === 'nfs.csi.k8s.io' || provisioner === 'efs.csi.aws.com') return true
  return provisioner === 'file.csi.azure.com' && parameters.protocol?.toLowerCase() === 'nfs'
}

async function readClaim(name: string): Promise<RawPvc | null> {
  return readObject<RawPvc>({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', name, namespace: k8sNamespace() })
}

function volumeRef(name: string): { apiVersion: string; kind: string; name: string } {
  return { apiVersion: 'v1', kind: 'PersistentVolume', name }
}

async function readVolume(name: string): Promise<RawPv | null> {
  return readObject<RawPv>(volumeRef(name))
}

/**
 * Delete this install's PVs, which are not deleted with the namespace. Used
 * by the e2e harness. The data is kept (`Retain`).
 */
export async function deleteStorageVolumes(installNamespace: string): Promise<void> {
  await deleteObjects('v1', 'PersistentVolume', {
    labelSelector: `${LABEL_INSTALL_NAMESPACE}=${installNamespace}`,
  }).catch(() => { /* cluster gone — nothing to sweep */ })
}
