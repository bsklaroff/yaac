/**
 * The node-local image store: a per-(node, project) READ-ONLY
 * containers/storage lower, materialized from the project registry by a
 * node-side pod and mounted into every nested worktree at
 * `/var/lib/shared-images` (the `additionalimagestores` entry in
 * Dockerfile.nestable).
 *
 * It is a CACHE of the registry, never a second source of truth. The
 * registry is still what a salvage pushes to and what survives a node
 * dying; this only removes the per-worktree cost of getting those layers
 * back — a fresh worktree sees them with no warm-up pull and no
 * graphroot spend, and concurrent worktrees on one node share one copy of
 * the layer data. A cold node mounts nothing and simply behaves as it did
 * before there was a store.
 *
 * Generations are WRITE-ONCE. `ensureNodeImageStore` writes
 * `<store>/gen-<stamp>/` and writes {@link DONE_MARKER} last; nothing ever
 * mutates a published generation. Worktree create pins the newest complete
 * generation *path* into the pod at create time
 * ({@link nodeImageStoreMount}), so a running worktree's store never
 * changes underneath it and the GC below can tell "in use" from "stale" by
 * looking at live pods' mounts.
 *
 * ── Why the writer pod looks the way it does ────────────────────────────
 *
 * It BUILDS NOTHING, which is why it is not one of the trust-split builder
 * pods next door and does not carry their `yaac.role=builder` identity: it
 * pulls what the registry already holds and rearranges it on a node path.
 * It borrows only their pinned `quay.io/podman/stable` mirror
 * (`ensureBuilderImage`), for the podman that pulls and the python3 the
 * post-passes need. Otherwise its shape is the registry's `hosts.toml`
 * writers': runc, plain root, pinned to a node with `nodeName`, the store
 * parent hostPath-mounted rw. Three of its properties are load-bearing
 * rather than incidental:
 *
 *  - **hostNetwork.** The writer pulls from the project registry, whose
 *    ingress policy already admits the node's own address range (node
 *    containerd pulls through it). In the host netns the pod IS the node,
 *    so it needs no NetworkPolicy of its own on either side — and it must
 *    then name the registry by ClusterIP, since the node is not a
 *    cluster-DNS client.
 *  - **No CAP_SYS_ADMIN.** `podman pull --root` needs none (a pull untars
 *    into the layer's diff dir; nothing is mounted). Withholding it is what
 *    makes containers/storage treat itself as rootless
 *    (`unshare.IsRootless()` is true for a uid-0 process without
 *    CAP_SYS_ADMIN), so opaque directories are recorded as
 *    `user.overlay.opaque` — an xattr the post-pass below can read back.
 *    With the capability they would be `trusted.overlay.*`, which needs
 *    CAP_SYS_ADMIN to read too.
 *  - **CAP_MKNOD** (in the default set) — the post-pass writes whiteout
 *    character devices, and a pull writes them for deleted files.
 *
 * ── Why opaque directories are rewritten ─────────────────────────────────
 *
 * A layer that REPLACES a directory records that as an overlay xattr on
 * the diff dir rather than as a file. Measured on the dev cluster, neither
 * spelling survives the trip into a worktree:
 *
 *  - `trusted.overlay.opaque` is invisible through gVisor's gofer
 *    filesystem — every read of the `trusted.` namespace answers
 *    EOPNOTSUPP, so the sentry cannot see the marker at all;
 *  - `user.overlay.opaque` IS readable through the gofer, but the worktree
 *    engine mounts overlay without `userxattr` (it holds CAP_SYS_ADMIN
 *    in-sandbox, so containers/storage takes the rootful path), and so
 *    reads the `trusted.` name.
 *
 * Either way the marker is not honored and the replaced directory's old
 * entries RESURRECT in the merged view — a silently wrong image, not a
 * slow one. {@link buildStoreWriterScript}'s post-pass therefore rewrites every
 * opaque marker into the explicit per-entry whiteouts it stands for,
 * computed against the layer's own (fixed, write-once) parent chain. Those
 * are 0:0 character devices — plain metadata, which the gofer passes
 * through, verified alongside `security.capability` file caps.
 *
 * The marker is left in place: it costs nothing, and it keeps a generation
 * correct for a consumer that DOES honor it.
 *
 * ── One node today ───────────────────────────────────────────────────────
 *
 * The WRITE side is already per node: the ensure runs one pinned pod per
 * node, so a second node materializes its own generations. The READ side is
 * not — `listStoreGenerations` and `nodeImageStoreMount` enumerate the
 * SERVER's own filesystem, which is the same one the single local node
 * sees. Making this multi-node is the same shape the multi-node storage
 * plan already assumes for node-local caches: ask the node, not the server,
 * which generations it has, and choose the mount after the pod is
 * scheduled. Nothing about the layout or the triggers has to change for it,
 * and until then a project whose worktrees land on a second node simply
 * runs them cold there.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  LABEL_PROJECT,
  PRIORITY_CLASS_INFRA,
  dataDirHash,
  k8sNamespace,
  kubectlGetJson,
  kubectlWithRetry,
  runPodToCompletion,
  type PodMount,
} from '#runtime/k8s/substrate'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { PROJECT_REGISTRY_PORT, projectRegistryClusterIp } from '#runtime/k8s/cluster'
import { ensureBuilderImage } from './builder-pod'
import { imageStoreDir } from '@yaac/shared/project-paths'
import { env as yaacEnv } from '@yaac/shared/env'
import { CACHE_TAG_PREFIX, rankedRegistryTagsScript } from './image-promoter'
import { serverLog } from '#log'

/** In-pod mount point of a nested worktree's read-only additional store —
 *  the path Dockerfile.nestable's `additionalimagestores` names. Baked as
 *  an empty directory in that image, so a worktree with no generation to
 *  mount still starts (containers/storage skips an empty store). */
export const SHARED_IMAGES_MOUNT = '/var/lib/shared-images'

/** Where the writer pod mounts the project's generation parent — handed
 *  to the script as argv rather than baked into it, so the mount point
 *  stays the pod spec's business. */
export const STORE_POD_PATH = '/store'

/** Written last in a generation directory; its presence is what makes the
 *  generation publishable. A crashed or half-pulled build leaves the dir
 *  without one, so it is never mounted and the next GC drops it. */
export const DONE_MARKER = '.yaac-store-done'

/** `app` label shared by every store-writer pod, and the marker the stray
 *  sweep and the removal selector key on. */
export const IMAGE_STORE_APP_LABEL = 'yaac-image-store'

/** GC scope: ties writer pods to this install without making them visible
 *  to the worktree reaper (which filters on `yaac.session-id`). */
export const LABEL_STORE_DATA_DIR_HASH = 'yaac.store-data-dir-hash'

/** How often one project's store is refreshed. A generation only gains
 *  content when a salvage has pushed something, and every refresh costs a
 *  pod plus a pull of whatever is new — so this is the floor, and the
 *  salvage-side trigger is what makes a fresh push visible sooner. */
export const STORE_REFRESH_INTERVAL_MS = 30 * 60_000

/** Deadline for one writer run: a cold store pulls a project's whole
 *  working set out of the registry and untars it onto node disk. */
export const STORE_REFRESH_TIMEOUT_MS = 30 * 60_000

/**
 * How long a FAILED refresh waits instead of the full interval. Failures here
 * are usually transient and self-clearing — the commonest is racing the
 * registry's own maintenance rollout, which lasts seconds — and making
 * those wait out the whole interval would leave a project's store a
 * generation behind for half an hour over a few seconds of unavailability.
 * Still a backoff, so a registry that is down for good costs one pod run
 * every few minutes rather than one per reconcile pass.
 */
export const STORE_REFRESH_RETRY_MS = 5 * 60_000

/** Deadline for the one-shot removal pod (an `rm -rf` of one directory). */
export const STORE_REMOVE_TIMEOUT_MS = 60_000

/**
 * Whether this install can host a node image store at all. An INNER yaac
 * runs against its vcluster, whose synced-pod admission policy refuses the
 * node hostPath both the writer and the consuming worktree would need —
 * the same condition that leaves it without a project registry to
 * materialize a store FROM. Its worktrees simply run with a cold engine.
 */
function storeAvailable(): boolean {
  return !yaacEnv.nested
}

function storeLabels(projectSlug: string): Record<string, string> {
  return {
    app: IMAGE_STORE_APP_LABEL,
    [LABEL_PROJECT]: projectSlug,
    [LABEL_STORE_DATA_DIR_HASH]: dataDirHash(),
  }
}

/** Selector matching this install's store-writer pods for one project. */
function storeSelector(projectSlug: string): string {
  return Object.entries(storeLabels(projectSlug)).map(([k, v]) => `${k}=${v}`).join(',')
}

/** Generation directory names, shaped so lexical order IS creation order
 *  (fixed-width epoch millis) and two builds a millisecond apart cannot
 *  collide on a name. */
export function generationName(nowMs = Date.now(), rand = crypto.randomBytes(4).toString('hex')): string {
  return `gen-${String(nowMs).padStart(14, '0')}-${rand}`
}

const GENERATION_DIR = /^gen-\d{14}-[0-9a-f]{8}$/

/**
 * Complete generations of one project's store on THIS node, newest first.
 * "Complete" means the DONE marker exists — the server can stat it even
 * though the store's contents are root-owned, because the writer leaves
 * the generation directory itself world-readable.
 *
 * Returns `[]` for a cold node, an install that cannot host a store, and
 * any error reading the parent: all three mean "mount nothing", which is
 * the pre-store behavior.
 */
export async function listStoreGenerations(projectSlug: string): Promise<string[]> {
  if (!storeAvailable()) return []
  const parent = imageStoreDir(projectSlug)
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
 * The read-only store mount for a new nested worktree pod, or undefined
 * when this node has no complete generation yet.
 *
 * Pinned to a generation PATH rather than a stable symlink on purpose: the
 * mount a pod is created with is the store it keeps for its whole life, so
 * a generation published mid-worktree can never change the layers an
 * engine has already loaded, and the GC can read the live set off pod
 * specs. A worktree picks up a newer generation the next time it is
 * created.
 */
export async function nodeImageStoreMount(projectSlug: string): Promise<PodMount | undefined> {
  const [newest] = await listStoreGenerations(projectSlug)
  if (!newest) return undefined
  return {
    source: { kind: 'hostPath', path: path.join(imageStoreDir(projectSlug), newest) },
    mountPath: SHARED_IMAGES_MOUNT,
    readOnly: true,
  }
}

/**
 * The in-pod script. Runs in the writer pod against
 * `/store` (the project's generation parent), and is the whole of what a
 * generation is:
 *
 *  1. **seed by hardlink** — `cp -al` the previous complete generation, so
 *     a generation costs disk proportional to what CHANGED. A pull only
 *     adds layer directories and rewrites the metadata files via
 *     temp+rename, which breaks the link safely; it never mutates a layer
 *     diff in place, so the previous generation stays byte-identical for
 *     the worktrees still mounting it. podman's OWN state
 *     (`db.sql`, `libpod/`, …) is dropped from the copy: its database
 *     records the absolute graphroot it was created under and refuses to
 *     open under a different one.
 *  2. **pull the working set** — ranked by `rankedRegistryTagsScript`, so
 *     what lands here is the project's live set rather than an archive:
 *     everything the catalog holds, minus all but the newest
 *     CACHED_GENERATIONS_KEPT content-hash generations per yaac-built repo
 *     and the chain slots belonging to the generations dropped. Named tags
 *     get their bare name restored; `yaac-cache-` slots stay dangling, the
 *     way a local `--layers` build leaves its intermediates.
 *  3. **rewrite opaque directories** into explicit whiteouts (see the
 *     module doc), skipping layers a previous generation already did — the
 *     marker file is hardlinked in by step 1.
 *  4. **assert complete metadata** — every layer must carry a recorded
 *     diff size, or `podman images` would recompute it by decompressing
 *     each layer's tar-split, which over the gofer is the classic
 *     "images takes minutes" failure. A pull always records them; this is
 *     the guard that keeps a future shortcut from silently removing them.
 *  5. **publish** by writing the DONE marker last, then drop every
 *     generation the server did not ask to keep.
 *
 * Argv is `<store root> <generation to keep>…`: the mount point the pod
 * spec chose, then the generations still referenced by a live pod — which
 * only the server knows, because it wrote those mounts.
 */
export function buildStoreWriterScript(registryEndpoint: string, genName: string): string {
  return [
    'set -eu',
    'STORE="$1"; shift',
    `GEN="$STORE/${genName}"`,
    // Lowest priority: this shares a node with interactive worktrees, and
    // untarring a project's whole working set is exactly the kind of
    // background work that must lose the CPU to them.
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
    // World-readable so the SERVER (an unprivileged uid) can stat the DONE
    // marker and enumerate generations without reading their contents.
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
    // The bare name is what a worktree's `FROM` and `docker run` name the
    // image by; the registry-qualified one is dropped so the store reads
    // like a local build's store.
    `    case "$tag" in ${CACHE_TAG_PREFIX}*) ;; *) podman tag "$ref" "$repo:$tag" >/dev/null 2>&1 || true;; esac`,
    '    podman untag "$ref" "$ref" >/dev/null 2>&1 || true',
    '    n=$((n+1))',
    '  done',
    'done',
    'echo "store-pulled $n"',
    // A store with nothing in it yet (an empty registry, a project whose
    // first salvage has not landed) still has to be a WELL-FORMED store,
    // because the layout is what the post-passes and the consuming engine
    // walk. podman creates these on first use; creating them here means
    // "no images" and "no store" are the same shape.
    'mkdir -p "$GEN/overlay" "$GEN/overlay-images" "$GEN/overlay-layers"',
    `python3 - "$GEN" <<'PY'`,
    OPAQUE_REWRITE_PY,
    'PY',
    `python3 - "$GEN" <<'PY'`,
    DIFF_SIZE_CHECK_PY,
    'PY',
    // World-readable so the SERVER (an unprivileged uid) can enumerate
    // generations and stat their markers without reading their contents.
    // After the pulls, because the engine owns the graphroot's mode until
    // then.
    'chmod 0755 "$GEN"',
    // The marker CERTIFIES the layer data, so it must not reach disk ahead
    // of it. Nothing above forces the pulls out of page cache, and under
    // delayed allocation a node crash just after publish can leave the
    // marker durable while `overlay/*/diff` files come back truncated —
    // producing a generation that looks complete and serves corrupt bytes
    // as image content. One flush at the end of an already IO-heavy build
    // buys the ordering; the second flush pushes the marker itself out, so
    // the same reordering cannot bite from the other side either.
    'sync',
    `date -u +%FT%TZ > "$GEN/${DONE_MARKER}"`,
    `chmod 0644 "$GEN/${DONE_MARKER}"`,
    'sync',
    // What survives: this build's own generation, the ones the server saw a
    // live pod mounting, and the predecessor this build seeded from.
    //
    // That last one closes a real race. The server reads the newest
    // complete generation to pin into a new pod, THEN fires this build —
    // so a pod can be created after the keep list was computed and be
    // holding a generation the GC would otherwise drop out from under its
    // running engine. Keeping the predecessor buys exactly one build cycle,
    // by which time that pod is in the live set the next run reads.
    //
    // A directory without a DONE marker is a crashed build's leftovers and
    // goes with the rest — which makes THIS sweep the only reclaimer of
    // them. A project whose builds stop for good (its registry deleted, the
    // project kept) therefore keeps its partial and superseded generations
    // until the project itself is removed; there is no orphan-store sweep.
    // Bounded by how many builds ran before they stopped, so it is a leak
    // measured in generations, not one that grows.
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
 * The opaque-marker rewrite (see the module doc for WHY). For each layer
 * not already processed, every directory carrying an overlay opaque xattr
 * gains a 0:0 character-device whiteout for each name the layers BELOW it
 * would otherwise contribute — which is exactly what the marker means.
 *
 * RECURSIVELY, which is the whole subtlety. Opacity hides the lower
 * directory *and everything under it*: a lower `app/src/old.js` is
 * invisible even though `src` exists on both sides. Whiting out only the
 * first level would therefore leave every name the two trees SHARE as a
 * live merge point — and sharing is the common case, since a replaced
 * directory is usually replaced with the same layout (`rm -rf app && COPY`,
 * a node_modules reinstall). So each shared name that is a directory on
 * both sides is descended into and whited out at its own level, and so on
 * down. A non-directory in the upper needs no descent: it covers the lower
 * entry whole.
 *
 * The lower chain comes from containers/storage's own `lower` file
 * (nearest first, `l/<link>` symlinks into a sibling layer's diff), so the
 * names are computed against the same layers the consuming overlay mount
 * will stack. The accumulation stops at a lower that is itself opaque at
 * that path — nothing below it is visible either way.
 *
 * A whiteout for a name that turns out not to be visible below is harmless
 * (overlay hides whiteout entries from readdir regardless), which is why
 * the walk can union across lowers without modelling what a nearer lower
 * already hid. A name the layer itself provides is never whitened.
 *
 * FAIL-CLOSED. Every read this pass depends on is load-bearing: a `lower`
 * file that exists but cannot be parsed, a link that will not resolve, an
 * xattr listing that errors for any reason but "this filesystem has none"
 * — each would silently shrink the whiteout set, and the marker below
 * would then hardlink that hole into every future generation. They exit
 * nonzero instead, so no DONE marker is written and the last good
 * generation stays mounted, matching how the diff-size assertion behaves.
 *
 * The per-layer marker makes this incremental: `cp -al` hardlinks it into
 * the next generation, so a layer is walked once in the life of a store.
 * The marker is VERSIONED — a change to what this pass emits must bump it,
 * or seeded layers would pin the old pass's output forever. Reprocessing a
 * seeded layer is safe against the hardlinks: `cp -al` recreates directory
 * inodes, so a whiteout added here lands in this generation alone.
 *
 * Each whiteout is printed as it is made. That is the pass's only window
 * from outside — the set it computes is the whole product, and a store
 * where it is wrong looks perfectly healthy.
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
 * The metadata post-check (M2). Every layer in `layers.json` must carry a
 * recorded uncompressed size; without one `podman images` reconstructs it
 * from the layer's tar-split, and a store is read over the gofer where
 * that is ruinous. Failing the build here is right: an incomplete
 * generation never gets a DONE marker, so worktrees keep mounting the last
 * good one.
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

/**
 * The writer pod. Trusted infra like the registry's node-write pods (no
 * runtimeClassName, so it runs on runc), pinned to one node, with the
 * blanket toleration those pods carry for the same reason: `nodeName`
 * bypasses the scheduler but not kubelet admission or the taint manager,
 * so a NoExecute pool taint would otherwise deny the pod the very node it
 * exists to write.
 *
 * See the module doc for why it is hostNetwork'd and why it deliberately
 * asks for no capabilities beyond the container default.
 */
export function buildStoreWriterPodManifest(params: {
  projectSlug: string
  imageRef: string
  nodeName: string
  registryEndpoint: string
  genName: string
  keep: string[]
  runId: string
  nodeIndex: number
}): Record<string, unknown> {
  const { projectSlug, imageRef, nodeName, registryEndpoint, genName, keep, runId } = params
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `yaac-store-${storeNameSuffix(projectSlug)}-${params.nodeIndex}-${runId}`,
      namespace: k8sNamespace(),
      labels: storeLabels(projectSlug),
    },
    spec: {
      nodeName,
      // The node's own address range is what the project registry's
      // ingress policy admits, and the node is not a cluster-DNS client —
      // hence the ClusterIP endpoint above.
      hostNetwork: true,
      restartPolicy: 'Never',
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // Infra tier: a worktree pod filling this node must not keep the
      // cache those worktrees read from being built.
      priorityClassName: PRIORITY_CLASS_INFRA,
      containers: [{
        name: 'write',
        image: imageRef,
        imagePullPolicy: 'IfNotPresent',
        command: [
          'sh', '-c', `${buildStoreWriterScript(registryEndpoint, genName)}\n`,
          '--', STORE_POD_PATH, ...keep,
        ],
        securityContext: { runAsUser: 0 },
        volumeMounts: [{ name: 'store', mountPath: STORE_POD_PATH }],
      }],
      volumes: [{
        name: 'store',
        hostPath: { path: imageStoreDir(projectSlug), type: 'DirectoryOrCreate' },
      }],
    },
  }
}

/**
 * One-shot pod dropping a project's whole store from a node. Its contents
 * are root-owned, so the server cannot remove them itself — the same
 * reason the store lives outside the project tree the server `rm -rf`s
 * (see {@link imageStoreDir}). Mounts the PARENT so the project's own
 * directory can go, matching the registry cleanup pod.
 */
export function buildStoreCleanupPodManifest(params: {
  projectSlug: string
  imageRef: string
  nodeName: string
  runId: string
  nodeIndex: number
}): Record<string, unknown> {
  const { projectSlug, imageRef, nodeName, runId } = params
  const dir = imageStoreDir(projectSlug)
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `yaac-store-rm-${storeNameSuffix(projectSlug)}-${params.nodeIndex}-${runId}`,
      namespace: k8sNamespace(),
      labels: storeLabels(projectSlug),
    },
    spec: {
      nodeName,
      restartPolicy: 'Never',
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      priorityClassName: PRIORITY_CLASS_INFRA,
      containers: [{
        name: 'remove',
        image: imageRef,
        imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-c', `rm -rf /store-parent/${path.basename(dir)}`],
        securityContext: { runAsUser: 0 },
        volumeMounts: [{ name: 'parent', mountPath: '/store-parent' }],
      }],
      volumes: [{
        name: 'parent',
        hostPath: { path: path.dirname(dir), type: 'DirectoryOrCreate' },
      }],
    },
  }
}

/** Pod-name fragment for a project: a DNS-label-safe slug plus an install-
 *  and slug-keyed hash, so truncation cannot collide (same shape as
 *  `projectRegistryName`). */
function storeNameSuffix(projectSlug: string): string {
  const safe = projectSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 18)
  const hash8 = crypto.createHash('sha256')
    .update(`${dataDirHash()}/${projectSlug}`)
    .digest('hex')
    .slice(0, 8)
  return `${safe}-${hash8}`.replace(/--+/g, '-')
}

interface RawNodeList {
  items: Array<{ metadata: { name: string } }>
}

async function listNodeNames(): Promise<string[]> {
  const list = await kubectlGetJson<RawNodeList>(['get', 'nodes'])
  return (list?.items ?? []).map((n) => n.metadata.name)
}

interface RawPodList {
  items: Array<{
    spec?: { volumes?: Array<{ hostPath?: { path?: string } }> }
  }>
}

/**
 * Generation names a live worktree pod of this project still has mounted.
 * The server wrote those mounts, so reading them back off the pod specs is
 * the authoritative "in use" set — a generation is safe to drop exactly
 * when nothing is pointing at it.
 *
 * A failure to list is treated as "everything is in use": the cost of
 * keeping a stale generation is disk, the cost of dropping a live one is a
 * worktree whose engine loses its store mid-run.
 */
async function generationsInUse(projectSlug: string): Promise<string[] | null> {
  const parent = imageStoreDir(projectSlug)
  const pods = await kubectlGetJson<RawPodList>([
    'get', 'pods', '-n', k8sNamespace(), '-l', `${LABEL_PROJECT}=${projectSlug}`,
  ]).catch(() => null)
  if (!pods) return null
  const names = new Set<string>()
  for (const pod of pods.items ?? []) {
    for (const vol of pod.spec?.volumes ?? []) {
      const p = vol.hostPath?.path
      if (p && path.dirname(p) === parent) names.add(path.basename(p))
    }
  }
  return [...names]
}

/** Per-project queue: an ensure is a pod run, and two of them racing would
 *  interleave their GC passes over one directory. */
const storeEnsureMutex = createKeyedMutex()

/** Last successful (or attempted) refresh per project — module state, so a
 *  server restart makes the next pass eligible again. */
const lastRefreshMs = new Map<string, number>()

/** Projects with a refresh in flight, marked synchronously so a reconcile
 *  tick and a salvage cannot both fire one. */
const refreshing = new Set<string>()

/** Test hook: forget the per-project throttle and in-flight marks. */
export function _resetImageStoreForTests(): void {
  lastRefreshMs.clear()
  refreshing.clear()
}

export interface EnsureStoreOptions {
  /** Ignore the per-project throttle (an explicit "there is new content"
   *  signal, e.g. a salvage that actually pushed). */
  force?: boolean
  nowMs?: number
}

/**
 * Write a fresh generation of this project's node image store on every node, then
 * drop the generations nothing is using. Best-effort: any failure is
 * logged and swallowed — a store is a cache, and its absence costs a
 * rebuild, never correctness.
 *
 * Returns true when a generation was published, false when it was skipped
 * (throttled, already in flight, unavailable on this install) or the build
 * failed — a failure shortens the next attempt to
 * {@link STORE_REFRESH_RETRY_MS} rather than waiting out the full interval.
 */
export async function ensureNodeImageStore(
  projectSlug: string,
  opts: EnsureStoreOptions = {},
): Promise<boolean> {
  if (!storeAvailable()) return false
  const now = opts.nowMs ?? Date.now()
  const last = lastRefreshMs.get(projectSlug)
  if (!opts.force && last !== undefined && now - last < STORE_REFRESH_INTERVAL_MS) return false
  if (refreshing.has(projectSlug)) return false
  refreshing.add(projectSlug)
  lastRefreshMs.set(projectSlug, now)
  try {
    const wrote = await storeEnsureMutex(projectSlug, () => writeOneStore(projectSlug))
    if (!wrote) lastRefreshMs.set(projectSlug, now - STORE_REFRESH_INTERVAL_MS + STORE_REFRESH_RETRY_MS)
    return wrote
  } catch (err) {
    serverLog(`[image-store] ${projectSlug}: ${String(err)}`)
    lastRefreshMs.set(projectSlug, now - STORE_REFRESH_INTERVAL_MS + STORE_REFRESH_RETRY_MS)
    return false
  } finally {
    refreshing.delete(projectSlug)
  }
}

/** Runs one writer pod per node. Returns false when nothing was
 *  published — no registry to read from, or every node's pod failed —
 *  which is what shortens the throttle to {@link STORE_REFRESH_RETRY_MS}. */
async function writeOneStore(projectSlug: string): Promise<boolean> {
  const clusterIp = await projectRegistryClusterIp(projectSlug)
  if (!clusterIp) return false
  const imageRef = await ensureBuilderImage()
  const runId = crypto.randomBytes(4).toString('hex')
  const keep = await generationsInUse(projectSlug)
  // Null means the live set is unknown; keep every complete generation
  // rather than risk unmounting one from under a running worktree.
  const keepNames = keep ?? await listStoreGenerations(projectSlug)

  // Strays from a run whose server died mid-poll: the per-run name suffix
  // means no later namesake delete collects them.
  await kubectlWithRetry([
    'delete', 'pod', '-l', storeSelector(projectSlug), '-n', k8sNamespace(), '--ignore-not-found',
  ]).catch(() => { /* best effort */ })

  let published = 0
  for (const [nodeIndex, nodeName] of (await listNodeNames()).entries()) {
    const genName = generationName()
    const manifest = buildStoreWriterPodManifest({
      projectSlug,
      imageRef,
      nodeName,
      registryEndpoint: `${clusterIp}:${PROJECT_REGISTRY_PORT}`,
      genName,
      keep: keepNames,
      runId,
      nodeIndex,
    })
    const { phase, logs } = await runPodToCompletion(manifest, {
      timeoutMs: STORE_REFRESH_TIMEOUT_MS,
      pollMs: 2000,
    })
    const tail = logs.trim().split('\n').slice(-4).join(' | ')
    if (phase !== 'Succeeded') {
      serverLog(`[image-store] ${projectSlug} on ${nodeName}: pod ${phase}${tail ? `; ${tail}` : ''}`)
      continue
    }
    published += 1
    serverLog(`[image-store] ${projectSlug} on ${nodeName}: ${genName} ${tail}`)
  }
  return published > 0
}

/**
 * Reconcile step: keep every project's node store fresh. Fires detached
 * per project — a refresh is a pod run of minutes, and the pass must not
 * stall behind it — and each is throttled by
 * {@link STORE_REFRESH_INTERVAL_MS}.
 */
export function reconcileNodeImageStores(projectSlugs: string[]): void {
  if (!storeAvailable()) return
  for (const slug of projectSlugs) {
    void ensureNodeImageStore(slug)
  }
}

/**
 * Drop a project's store from every node, at project removal. Best-effort
 * per node: a recreated or unreachable cluster took the store with the
 * node it lived on.
 */
export async function removeNodeImageStore(projectSlug: string): Promise<void> {
  if (!storeAvailable()) return
  const imageRef = await ensureBuilderImage().catch(() => null)
  if (!imageRef) return
  const runId = crypto.randomBytes(4).toString('hex')
  const nodes = await listNodeNames().catch(() => [] as string[])
  for (const [nodeIndex, nodeName] of nodes.entries()) {
    await runPodToCompletion(
      buildStoreCleanupPodManifest({ projectSlug, imageRef, nodeName, runId, nodeIndex }),
      { timeoutMs: STORE_REMOVE_TIMEOUT_MS, pollMs: 500 },
    ).catch(() => { /* node-side residue is harmless */ })
  }
}
