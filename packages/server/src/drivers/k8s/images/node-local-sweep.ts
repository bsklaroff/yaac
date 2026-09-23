/**
 * The node-local orphan sweep: one root pod per node, walking this
 * install's node-local tree and removing what no live worktree owns.
 *
 * The NODE-LOCAL tier holds, per project, package-manager caches and each
 * opencode worktree's working copy (docs/server-in-cluster.md "Storage is
 * two claims") — and, on a node an older install ran worktrees on, the
 * shared pnpm store and per-worktree module dirs this sweep retires
 * (docs/legacy-compat-shims.md "The retired pnpm store and module dirs"). None of it is
 * on the server's own filesystem on a multi-node cluster — it is on
 * whichever node the worktree ran on — so nothing about it is read or
 * written from the server; the sweep runs where the bytes are, on the
 * node-write-pod shape the image store's writer uses (store-writer.ts).
 *
 * The keep-list is the set of worktree ids with a LIVE pod, per slug, and
 * it is the only keep-list: a stopped worktree's module dir was per life,
 * and its opencode working copy is either already deleted by its
 * own `preStop` checkpoint or a stale copy the global checkpoint outranks
 * on the next start. Everything else under the two entry kinds is an
 * orphan — except what was written since the cutoff, which is a create
 * staging into a directory its pod has not appeared with yet (the same
 * slack `inUseBySweep` gives the global half).
 */
import crypto from 'node:crypto'
import {
  PRIORITY_CLASS_INFRA,
  dataDirHash,
  k8sNamespace,
  kubectlGetJson,
  kubectlWithRetry,
  nodeLocalNodePath,
  runPodToCompletion,
} from '#drivers/k8s/substrate'
import { ensureBuilderImage } from '#drivers/k8s/cluster'
import { serverLog } from '#log'

/** Where the sweep pod mounts the install's node-local tree. */
export const SWEEP_POD_PATH = '/node'

/** `app` label of every sweep pod; with the hash label below, what the
 *  next run's stray delete selects. */
export const NODE_LOCAL_SWEEP_APP_LABEL = 'yaac-node-local-sweep'

/** Ties sweep pods to this install without making them visible to the
 *  worktree reaper (which filters on `yaac.worktree-id`). */
export const LABEL_SWEEP_DATA_DIR_HASH = 'yaac.sweep-data-dir-hash'

/** Label selector of this install's sweep pods. */
export function sweepPodSelector(): string {
  return `app=${NODE_LOCAL_SWEEP_APP_LABEL},${LABEL_SWEEP_DATA_DIR_HASH}=${dataDirHash()}`
}

/** How often the sweep runs per server life: leftovers accrue slowly, and
 *  every run is a pod per node. */
export const NODE_LOCAL_SWEEP_INTERVAL_MS = 60 * 60_000

/** Deadline for one node's sweep: a walk over one tree and some `rm -rf`s. */
export const NODE_LOCAL_SWEEP_TIMEOUT_MS = 5 * 60_000

/**
 * How far before the sweep's start a write still counts as "in use". Node
 * disk is local (second-granularity timestamps at worst), so this is the
 * same slack the global half uses.
 */
export const NODE_LOCAL_SWEEP_SLACK_MS = 10_000

/**
 * How long the retired shared pnpm store must have gone unwritten before
 * the sweep removes it. Only a worktree launched by an older server still
 * points pnpm at it, and one of those installing when the store vanished
 * would fail — so it goes once nothing has touched it for a day.
 */
export const LEGACY_PNPM_STORE_IDLE_MS = 24 * 60 * 60_000

function sweepLabels(): Record<string, string> {
  return { app: NODE_LOCAL_SWEEP_APP_LABEL, [LABEL_SWEEP_DATA_DIR_HASH]: dataDirHash() }
}

/**
 * The in-pod script. Argv is `<cutoff epoch seconds> <store cutoff epoch
 * seconds> <slug>=<id>,<id>…`, one keep entry per project with live
 * worktrees. Per project it first removes the retired shared pnpm store
 * when nothing under its top three levels is newer than the store cutoff:
 * pnpm 11's index database sits at the second, and pnpm 10's per-prefix
 * `files/<xx>` and `index/<xx>` dirs at the third, where every write of a
 * new package touches one. Then it walks
 * `/node/projects/<slug>/{.cached-packages/modules,opencode-data}/*` and
 * removes each entry whose basename is not in its slug's keep set and whose
 * mtime is older than the cutoff (`find -newermt` is the in-pod form of the
 * slack).
 *
 * Never through a symlink. `.cached-packages` is mounted whole and
 * read-write in every worktree pod, so a pod can replace `modules` (or an
 * entry under it) with a link to anywhere on the node; a walk that
 * followed it would `rm -rf` the target as root. Every level is tested
 * with `-L` and a link is skipped — the next pod's init container replaces
 * a linked component with a real directory.
 */
export function buildNodeLocalSweepScript(): string {
  return [
    'set -u',
    'CUTOFF="$1"; STORE_CUTOFF="$2"; shift 2',
    'keep_of() { for kv in "$@"; do case "$kv" in "$1="*) echo "${kv#*=}"; return;; esac; done; }',
    'removed=0',
    'for slugdir in /node/projects/*; do',
    '  [ -d "$slugdir" ] && [ ! -L "$slugdir" ] || continue',
    '  slug=$(basename "$slugdir")',
    '  keep=$(keep_of "$slug" "$@"); shift 0',
    '  cp="$slugdir/.cached-packages"; store="$cp/pnpm-store"',
    // Fails closed: a find that errors (an unreadable entry, EIO) keeps the
    // store rather than reading as "nothing recent".
    '  if [ -d "$store" ] && [ ! -L "$cp" ] && [ ! -L "$store" ] \\',
    '    && recent=$(find "$store" -maxdepth 3 -newermt "@$STORE_CUTOFF" -print -quit) && [ -z "$recent" ]; then',
    '    rm -rf "$store" && removed=$((removed+1)) && echo "removed $slug/.cached-packages/pnpm-store"',
    '  fi',
    '  for kind in .cached-packages/modules opencode-data; do',
    '    kinddir="$slugdir/$kind"',
    '    [ -d "$kinddir" ] && [ ! -L "$kinddir" ] || continue',
    '    for entry in "$kinddir"/*; do',
    '      [ -e "$entry" ] && [ ! -L "$entry" ] || continue',
    '      id=$(basename "$entry")',
    '      case ",$keep," in *",$id,"*) continue;; esac',
    // A directory touched since the cutoff is a create staging into it.
    '      if [ -n "$(find "$entry" -maxdepth 0 -newermt "@$CUTOFF" 2>/dev/null)" ]; then continue; fi',
    '      rm -rf "$entry" && removed=$((removed+1)) && echo "removed $slug/$kind/$id"',
    '    done',
    '  done',
    'done',
    'echo "node-local-sweep removed $removed"',
  ].join('\n')
}

/**
 * The sweep pod for one node: root, runc, pinned by `nodeName`, blanket
 * toleration (a pool taint must not keep the sweep off the very node it
 * exists to clean), infra priority, the install's node root mounted rw.
 * The builder image mirror, because busybox lacks `find -newermt`.
 */
export function buildNodeLocalSweepPodManifest(params: {
  nodeName: string
  imageRef: string
  running: Map<string, Set<string>>
  cutoffEpoch: number
  storeCutoffEpoch: number
  runId: string
  nodeIndex: number
}): Record<string, unknown> {
  const keep = [...params.running.entries()]
    .filter(([, ids]) => ids.size > 0)
    .map(([slug, ids]) => `${slug}=${[...ids].join(',')}`)
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `yaac-node-sweep-${params.nodeIndex}-${params.runId}`,
      namespace: k8sNamespace(),
      labels: sweepLabels(),
    },
    spec: {
      nodeName: params.nodeName,
      restartPolicy: 'Never',
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      priorityClassName: PRIORITY_CLASS_INFRA,
      containers: [{
        name: 'sweep',
        image: params.imageRef,
        imagePullPolicy: 'IfNotPresent',
        command: [
          'sh', '-c', `${buildNodeLocalSweepScript()}\n`, '--',
          String(params.cutoffEpoch), String(params.storeCutoffEpoch), ...keep,
        ],
        securityContext: { runAsUser: 0 },
        volumeMounts: [{ name: 'node', mountPath: SWEEP_POD_PATH }],
      }],
      volumes: [{
        name: 'node',
        hostPath: { path: nodeLocalNodePath(), type: 'DirectoryOrCreate' },
      }],
    },
  }
}

/** Last sweep this server life ran, or never. */
let lastSweepMs: number | undefined
let sweeping = false

/** Test hook: forget the throttle. */
export function _resetNodeLocalSweepForTests(): void {
  lastSweepMs = undefined
  sweeping = false
}

interface RawNodeList {
  items: Array<{ metadata: { name: string } }>
}

/**
 * See `WorktreeDriver.reapNodeLocal`. Runs one pod per node, throttled to
 * once per {@link NODE_LOCAL_SWEEP_INTERVAL_MS} per server life; every
 * failure is logged and swallowed, since an orphan costs disk and nothing
 * else.
 */
export async function reapNodeLocal(
  running: Map<string, Set<string>>,
  opts: { nowMs?: number } = {},
): Promise<void> {
  const now = opts.nowMs ?? Date.now()
  if (sweeping) return
  if (lastSweepMs !== undefined && now - lastSweepMs < NODE_LOCAL_SWEEP_INTERVAL_MS) return
  sweeping = true
  lastSweepMs = now
  try {
    // A pod a previous server life left mid-run (crash, restart) is this
    // install's stray; nothing else deletes on these labels.
    await kubectlWithRetry([
      'delete', 'pods', '-n', k8sNamespace(), '-l', sweepPodSelector(),
      '--ignore-not-found', '--wait=false',
    ], { maxAttempts: 1 }).catch((err: unknown) => {
      serverLog(`[node-local-sweep] stray pod delete failed: ${String(err)}`)
    })
    const imageRef = await ensureBuilderImage()
    const runId = crypto.randomBytes(4).toString('hex')
    const cutoffEpoch = Math.floor((now - NODE_LOCAL_SWEEP_SLACK_MS) / 1000)
    const storeCutoffEpoch = Math.floor((now - LEGACY_PNPM_STORE_IDLE_MS) / 1000)
    const nodes = await kubectlGetJson<RawNodeList>(['get', 'nodes'])
    for (const [nodeIndex, { metadata }] of (nodes?.items ?? []).entries()) {
      const manifest = buildNodeLocalSweepPodManifest({
        nodeName: metadata.name, imageRef, running, cutoffEpoch, storeCutoffEpoch, runId, nodeIndex,
      })
      const { phase, logs } = await runPodToCompletion(manifest, {
        timeoutMs: NODE_LOCAL_SWEEP_TIMEOUT_MS,
        pollMs: 1000,
      })
      const tail = logs.trim().split('\n').slice(-3).join(' | ')
      if (phase !== 'Succeeded') {
        serverLog(`[node-local-sweep] ${metadata.name}: pod ${phase}${tail ? `; ${tail}` : ''}`)
        continue
      }
      if (tail && !tail.endsWith('removed 0')) serverLog(`[node-local-sweep] ${metadata.name}: ${tail}`)
    }
  } catch (err) {
    serverLog(`[node-local-sweep] ${String(err)}`)
  } finally {
    sweeping = false
  }
}
