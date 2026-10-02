/**
 * The node-local image store: a read-only containers/storage directory per
 * (node, project), written from the project registry by a node-side pod and
 * mounted into every nested workspace at `/var/lib/shared-images`. It is
 * only a cache of the registry. docs/nested-containers.md "The node-local
 * image store" explains the writer pod's shape (hostNetwork, no
 * CAP_SYS_ADMIN) and why opaque directories are rewritten.
 *
 * Generations are write-once: `<store>/gen-<stamp>/`, completed by writing
 * {@link DONE_MARKER} last. A new pod mounts the newest complete generation
 * by path, so its store never changes, and GC reads the in-use set from
 * pod specs.
 *
 * Limitation: every node gets the same generation name, but the server
 * picks the mount from its own node's directory. A pod on a node whose
 * writer has not finished that generation mounts an empty directory and
 * runs its engine cold.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  LABEL_PROJECT_ID,
  dataDirHash,
  k8sNamespace,
  kubectlGetJson,
  nodeLocalHostPath,
  runOnEachNode,
  type PodMount,
} from '#drivers/k8s/substrate'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { PROJECT_REGISTRY_PORT, projectRegistryClusterIp } from '#drivers/k8s/cluster'
import { ensureBuilderImage } from '#drivers/k8s/cluster'
import { imageStoreDir } from '@yaac/shared/project-paths'
import { CACHE_TAG_PREFIX, rankedRegistryTagsScript } from './image-promoter'
import { serverLog } from '#log'
import type { ProjectRef } from '#drivers/contract'

/** In-pod mount point of the store (Dockerfile.nestable's
 *  `additionalimagestores`). The image ships it empty, so a workspace with
 *  nothing mounted still works. */
export const SHARED_IMAGES_MOUNT = '/var/lib/shared-images'

/** Where the writer pod mounts the project's store directory. */
export const STORE_POD_PATH = '/store'

/** Written last in a generation directory to mark it complete. A crashed
 *  build leaves none, so it is never mounted and the next run drops it. */
export const DONE_MARKER = '.yaac-store-done'

/** `app` label of every store-writer pod. */
const IMAGE_STORE_APP_LABEL = 'yaac-image-store'

/** Ties writer pods to this install without the workspace-id label the
 *  workspace reaper selects on. */
const LABEL_STORE_DATA_DIR_HASH = 'yaac.store-data-dir-hash'

/** How often one project's store is refreshed. A salvage that pushed
 *  something forces an earlier refresh. */
export const STORE_REFRESH_INTERVAL_MS = 30 * 60_000

/** Deadline for one writer run (a cold store pulls everything). */
const STORE_REFRESH_TIMEOUT_MS = 30 * 60_000

/**
 * Retry delay after a failed refresh. Failures are usually brief (e.g.
 * racing the registry's maintenance rollout), so waiting the full interval
 * would leave the store stale for no reason.
 */
export const STORE_REFRESH_RETRY_MS = 5 * 60_000

function storeLabels(projectId: string): Record<string, string> {
  return {
    app: IMAGE_STORE_APP_LABEL,
    [LABEL_PROJECT_ID]: projectId,
    [LABEL_STORE_DATA_DIR_HASH]: dataDirHash(),
  }
}

/** Generation directory name. Lexical order is creation order, and the
 *  random suffix prevents collisions. */
export function generationName(nowMs = Date.now(), rand = crypto.randomBytes(4).toString('hex')): string {
  return `gen-${String(nowMs).padStart(14, '0')}-${rand}`
}

const GENERATION_DIR = /^gen-\d{14}-[0-9a-f]{8}$/

/**
 * Complete generations of one project's store on the server's node, newest
 * first. The writer leaves each generation directory world-readable so the
 * server can check the DONE marker. Returns `[]` on any read error, which
 * means "mount nothing".
 */
async function listStoreGenerations(projectId: string): Promise<string[]> {
  const parent = imageStoreDir(projectId)
  const names = await fs.readdir(parent).catch(() => [] as string[])
  const complete: string[] = []
  for (const name of names.filter((n) => GENERATION_DIR.test(n)).sort().reverse()) {
    if (await fs.access(path.join(parent, name, DONE_MARKER)).then(() => true, () => false)) {
      complete.push(name)
    }
  }
  return complete
}

/**
 * The read-only store mount for a new nested workspace pod, or undefined
 * when there is no complete generation yet. Mounts a generation path, not
 * a symlink, so the pod's store never changes during its life.
 */
export async function nodeImageStoreMount(projectId: string): Promise<PodMount | undefined> {
  const [newest] = await listStoreGenerations(projectId)
  if (!newest) return undefined
  return {
    // A node lacking this generation gets an empty directory (see the
    // module doc) instead of a FailedMount.
    source: { kind: 'hostPath', path: path.join(imageStoreDir(projectId), newest), type: 'DirectoryOrCreate' },
    mountPath: SHARED_IMAGES_MOUNT,
    readOnly: true,
  }
}

/**
 * The writer pod's script. Argv is `<store root> <generation to keep>…`,
 * the keep list being the generations live pods mount.
 *
 *  1. Seed from the previous complete generation with `cp -al`, so disk
 *     cost is only what changed (pulls never edit a layer in place).
 *     podman's own database is dropped: it records its graphroot path.
 *  2. Pull the working set chosen by `rankedRegistryTagsScript`, restoring
 *     bare names for named tags.
 *  3. Rewrite opaque directories into explicit whiteouts.
 *  4. Assert every layer has a recorded diff size.
 *  5. Write the DONE marker, then drop generations not kept.
 */
function buildStoreWriterScript(registryEndpoint: string, genName: string): string {
  return [
    'set -eu',
    'STORE="$1"; shift',
    `GEN="$STORE/${genName}"`,
    // Lowest CPU priority: interactive workspaces share this node.
    'command -v renice >/dev/null 2>&1 && renice -n 19 $$ >/dev/null 2>&1 || true',
    'rm -rf "$GEN"',
    // Newest complete predecessor to seed from.
    `PREV=$(ls -1 "$STORE" 2>/dev/null | grep -E '^gen-[0-9]{14}-[0-9a-f]{8}$' | sort -r `
    + `| while read -r g; do if [ -f "$STORE/$g/${DONE_MARKER}" ]; then echo "$g"; break; fi; `
    + 'done || true)',
    'if [ -n "${PREV:-}" ]; then',
    '  cp -al "$STORE/$PREV" "$GEN"',
    `  rm -rf "$GEN/${DONE_MARKER}" "$GEN/db.sql" "$GEN/libpod" "$GEN/networks" `
    + '"$GEN/volumes" "$GEN/overlay-containers" "$GEN/defaultNetworkBackend" '
    + '"$GEN/storage.lock" "$GEN/userns.lock"',
    'else',
    '  mkdir -p "$GEN"',
    'fi',
    'cat > /tmp/yaac-store.conf <<CONF',
    '[storage]',
    'driver = "overlay"',
    'runroot = "/run/yaac-store"',
    'graphroot = "$GEN"',
    'CONF',
    'export CONTAINERS_STORAGE_CONF=/tmp/yaac-store.conf',
    `REG=${registryEndpoint}`,
    rankedRegistryTagsScript(),
    'n=0',
    'for repo in $repos; do',
    '  for tag in $(ranked_tags "$repo"); do',
    '    ref="$REG/$repo:$tag"',
    '    podman pull -q --tls-verify=false "$ref" >/dev/null 2>&1 || continue',
    // Keep only the bare name, which is what workspaces refer to.
    `    case "$tag" in ${CACHE_TAG_PREFIX}*) ;; *) podman tag "$ref" "$repo:$tag" >/dev/null 2>&1 || true;; esac`,
    '    podman untag "$ref" "$ref" >/dev/null 2>&1 || true',
    '    n=$((n+1))',
    '  done',
    'done',
    'echo "store-pulled $n"',
    // An empty store must still have the layout the post-passes and the
    // workspace engine expect.
    'mkdir -p "$GEN/overlay" "$GEN/overlay-images" "$GEN/overlay-layers"',
    `python3 - "$GEN" <<'PY'`,
    OPAQUE_REWRITE_PY,
    'PY',
    `python3 - "$GEN" <<'PY'`,
    DIFF_SIZE_CHECK_PY,
    'PY',
    // World-readable so the server (unprivileged) can list generations and
    // check their markers. Set after the pulls, which reset the mode.
    'chmod 0755 "$GEN"',
    // Flush the layer data before writing the marker, so a node crash
    // cannot leave a complete-looking generation with truncated files.
    'sync',
    `date -u +%FT%TZ > "$GEN/${DONE_MARKER}"`,
    `chmod 0644 "$GEN/${DONE_MARKER}"`,
    'sync',
    // Keep this generation, those live pods mount, and the predecessor: a
    // pod created after the keep list was read may be mounting it.
    // Incomplete generations are dropped too.
    'kept=0; dropped=0',
    `for g in $(ls -1 "$STORE" 2>/dev/null | grep -E '^gen-[0-9]{14}-[0-9a-f]{8}$'); do`,
    "  keep=''",
    `  if [ "$g" = "${genName}" ] || [ "$g" = "\${PREV:-}" ]; then keep=1; fi`,
    '  for k in "$@"; do if [ "$g" = "$k" ]; then keep=1; fi; done',
    '  if [ -n "$keep" ]; then kept=$((kept+1)); else rm -rf "$STORE/$g"; dropped=$((dropped+1)); fi',
    'done',
    'echo "store-generations kept $kept dropped $dropped"',
  ].join('\n')
}

/**
 * Python pass that replaces overlay opaque-directory markers with explicit
 * whiteouts (see docs/nested-containers.md). In each opaque directory it
 * creates a 0:0 character device for every name the lower layers (from
 * containers/storage's `lower` file) would contribute, stopping at a lower
 * that is itself opaque.
 *
 * It recurses: opacity also hides everything under a lower directory, so
 * names that are directories on both sides are descended into and
 * whited out at each level. Extra whiteouts are harmless.
 *
 * Any read error other than "no xattrs here" exits nonzero, so no DONE
 * marker is written; a silently missing whiteout would otherwise be copied
 * into every later generation.
 *
 * A per-layer marker, hardlinked forward by `cp -al`, means each layer is
 * processed once. Bump its version when the output changes. Each whiteout
 * is printed, since a wrong result looks healthy.
 */
const OPAQUE_REWRITE_PY = [
  'import errno, os, stat, sys',
  "ovl = os.path.join(sys.argv[1], 'overlay')",
  'if not os.path.isdir(ovl):',
  "    print('store-opaque layers=0 dirs=0 whiteouts=0')",
  '    raise SystemExit(0)',
  "OPAQUE = ('user.overlay.opaque', 'trusted.overlay.opaque')",
  "MARKER = '.yaac-opaque-rewritten-v2'",
  'NO_XATTRS = (errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENODATA)',
  'def die(msg):',
  "    sys.exit('store-opaque: ' + msg)",
  'def opaque(p):',
  '    try:',
  '        names = os.listxattr(p, follow_symlinks=False)',
  '    except OSError as e:',
  '        if e.errno in NO_XATTRS:',
  '            return False',
  "        die('cannot read xattrs of %s: %s' % (p, e))",
  '    return any(n in names for n in OPAQUE)',
  'def lowers(layer):',
  '    try:',
  "        raw = open(os.path.join(ovl, layer, 'lower')).read().strip()",
  '    except FileNotFoundError:',
  '        return []',
  '    except OSError as e:',
  "        die('cannot read lower chain of %s: %s' % (layer, e))",
  '    out = []',
  "    for part in raw.split(':'):",
  '        if not part:',
  '            continue',
  '        link = os.path.join(ovl, part)',
  '        try:',
  '            out.append(os.path.normpath(os.path.join(os.path.dirname(link), os.readlink(link))))',
  '        except OSError as e:',
  "            die('cannot resolve lower %s of %s: %s' % (part, layer, e))",
  '    return out',
  'def listdir(p):',
  '    try:',
  '        return set(os.listdir(p))',
  '    except OSError:',
  '        return None',
  'made = [0]',
  '# Whiteout what the lowers contribute at `rel`, then recurse into every',
  '# name both sides hold as a directory. Returns the dirs visited.',
  'def whiteout(root, low, rel):',
  '    own = listdir(root)',
  '    if own is None:',
  '        return 0',
  '    below = set()',
  '    for ld in low:',
  '        p = os.path.join(ld, rel) if rel else ld',
  '        names = listdir(p)',
  '        if names is None:',
  '            continue',
  '        below.update(names)',
  '        if opaque(p):',
  '            break',
  '    for name in sorted(below - own):',
  '        try:',
  '            os.mknod(os.path.join(root, name), stat.S_IFCHR, os.makedev(0, 0))',
  "            print('store-opaque-whiteout %s' % os.path.join(rel, name))",
  '            made[0] += 1',
  '        except FileExistsError:',
  '            pass',
  '    n = 1',
  '    for name in sorted(below & own):',
  '        sub = os.path.join(root, name)',
  '        if os.path.isdir(sub) and not os.path.islink(sub):',
  '            n += whiteout(sub, low, os.path.join(rel, name) if rel else name)',
  '    return n',
  'dirs = layers = 0',
  'for layer in sorted(os.listdir(ovl)):',
  '    d = os.path.join(ovl, layer)',
  "    if layer == 'l' or not os.path.isdir(d):",
  '        continue',
  '    if os.path.exists(os.path.join(d, MARKER)):',
  '        continue',
  '    layers += 1',
  "    diff, low = os.path.join(d, 'diff'), lowers(layer)",
  '    if low:',
  '        for root, _sub, _files in os.walk(diff):',
  '            if not opaque(root):',
  '                continue',
  '            rel = os.path.relpath(root, diff)',
  "            dirs += whiteout(root, low, '' if rel == '.' else rel)",
  "    open(os.path.join(d, MARKER), 'w').close()",
  "print('store-opaque layers=%d dirs=%d whiteouts=%d' % (layers, dirs, made[0]))",
].join('\n')

/**
 * Python check that every layer in `layers.json` records its uncompressed
 * size. Without it `podman images` decompresses each layer through the
 * gofer, which takes minutes. Failing leaves no DONE marker, so the last
 * good generation stays mounted.
 */
const DIFF_SIZE_CHECK_PY = [
  'import json, os, sys',
  "p = os.path.join(sys.argv[1], 'overlay-layers', 'layers.json')",
  'try:',
  '    layers = json.load(open(p))',
  'except OSError:',
  '    layers = []',
  "missing = [l.get('id', '?') for l in layers if not l.get('diff-size') and not l.get('uncompressed-size')]",
  'if missing:',
  '    sys.exit("store layers missing recorded diff sizes: %s" % missing[:5])',
  "print('store-layers %d' % len(layers))",
].join('\n')

interface RawPodList {
  items: Array<{
    spec?: { volumes?: Array<{ hostPath?: { path?: string } }> }
  }>
}

/**
 * Generation names mounted by this project's live pods, read from their
 * specs by the `shared-images/<id>/<gen>` path suffix. Null when pods
 * cannot be listed; the caller then keeps everything.
 */
async function generationsInUse(projectId: string): Promise<string[] | null> {
  const suffix = `/shared-images/${projectId}/`
  const pods = await kubectlGetJson<RawPodList>([
    'get', 'pods', '-n', k8sNamespace(), '-l', `${LABEL_PROJECT_ID}=${projectId}`,
  ]).catch(() => null)
  if (!pods) return null
  const names = new Set<string>()
  for (const pod of pods.items ?? []) {
    for (const vol of pod.spec?.volumes ?? []) {
      const p = vol.hostPath?.path
      const at = p?.lastIndexOf(suffix) ?? -1
      if (!p || at < 0) continue
      const gen = p.slice(at + suffix.length)
      if (GENERATION_DIR.test(gen)) names.add(gen)
    }
  }
  return [...names]
}

/** Per-project lock, so two runs never GC the same directory at once. */
const storeEnsureMutex = createKeyedMutex()

/** Last refresh attempt per project id (reset by a server restart). */
const lastRefreshMs = new Map<string, number>()

/** Projects with a refresh in flight. */
const refreshing = new Set<string>()

/** Test hook: forget the per-project throttle and in-flight marks. */
export function _resetImageStoreForTests(): void {
  lastRefreshMs.clear()
  refreshing.clear()
}

interface EnsureStoreOptions {
  /** Ignore the throttle, e.g. after a salvage pushed something. */
  force?: boolean
  nowMs?: number
}

/**
 * Write a new store generation for the project on every node and drop
 * unused ones. Best-effort: failures are logged. Returns true when a
 * generation was published. A failure retries after
 * {@link STORE_REFRESH_RETRY_MS}.
 */
export async function ensureNodeImageStore(
  project: ProjectRef,
  opts: EnsureStoreOptions = {},
): Promise<boolean> {
  const { id } = project
  const now = opts.nowMs ?? Date.now()
  const last = lastRefreshMs.get(id)
  if (!opts.force && last !== undefined && now - last < STORE_REFRESH_INTERVAL_MS) return false
  if (refreshing.has(id)) return false
  refreshing.add(id)
  lastRefreshMs.set(id, now)
  try {
    const wrote = await storeEnsureMutex(id, () => writeOneStore(project))
    if (!wrote) lastRefreshMs.set(id, now - STORE_REFRESH_INTERVAL_MS + STORE_REFRESH_RETRY_MS)
    return wrote
  } catch (err) {
    serverLog(`[image-store] ${project.slug}: ${String(err)}`)
    lastRefreshMs.set(id, now - STORE_REFRESH_INTERVAL_MS + STORE_REFRESH_RETRY_MS)
    return false
  } finally {
    refreshing.delete(id)
  }
}

/**
 * Run one writer pod per node: root, with the project's store directory
 * mounted. docs/nested-containers.md explains hostNetwork and the default
 * capabilities. False when nothing was published (no project registry, or
 * every node failed).
 */
async function writeOneStore(project: ProjectRef): Promise<boolean> {
  const { slug, id } = project
  const clusterIp = await projectRegistryClusterIp(id)
  if (!clusterIp) return false
  const imageRef = await ensureBuilderImage()
  const keep = await generationsInUse(id)
  // Unknown live set: keep every complete generation.
  const keepNames = keep ?? await listStoreGenerations(id)
  // Same name on every node, since the server picks the mount from its
  // own node's generations.
  const genName = generationName()
  const registryEndpoint = `${clusterIp}:${PROJECT_REGISTRY_PORT}`
  const runs = await runOnEachNode({
    name: `yaac-store-${id}`,
    labels: storeLabels(id),
    timeoutMs: STORE_REFRESH_TIMEOUT_MS,
    pod: () => ({
      image: imageRef,
      command: [
        'sh', '-c', `${buildStoreWriterScript(registryEndpoint, genName)}\n`,
        '--', STORE_POD_PATH, ...keepNames,
      ],
      container: {
        securityContext: { runAsUser: 0 },
        volumeMounts: [{ name: 'store', mountPath: STORE_POD_PATH }],
      },
      spec: {
        // The registry admits node addresses; the node has no cluster DNS,
        // hence the ClusterIP endpoint.
        hostNetwork: true,
        volumes: [{
          name: 'store',
          hostPath: { path: nodeLocalHostPath(imageStoreDir(id)), type: 'DirectoryOrCreate' },
        }],
      },
    }),
  })
  for (const { node, phase, logs } of runs) {
    const tail = logs.trim().split('\n').slice(-4).join(' | ')
    serverLog(phase === 'Succeeded'
      ? `[image-store] ${slug} on ${node}: ${genName} ${tail}`
      : `[image-store] ${slug} on ${node}: pod ${phase}${tail ? `; ${tail}` : ''}`)
  }
  return runs.some((r) => r.phase === 'Succeeded')
}

/**
 * Reconcile step: refresh each project's store in the background,
 * throttled by {@link STORE_REFRESH_INTERVAL_MS}.
 */
export function reconcileNodeImageStores(projects: ProjectRef[]): void {
  for (const project of projects) {
    void ensureNodeImageStore(project)
  }
}
