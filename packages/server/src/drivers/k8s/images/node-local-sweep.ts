/**
 * The node-local orphan sweep: one root pod per node, walking this
 * install's node-local tree and removing what no live project or worktree
 * owns.
 *
 * The NODE-LOCAL tier holds, per project id, package-manager caches, each
 * opencode worktree's working copy and the nested image store
 * (docs/server-in-cluster.md "Storage is two claims"). None of it is on the
 * server's own filesystem on a multi-node cluster — it is on whichever node
 * the worktree ran on — so nothing about it is read or written from the
 * server; the sweep runs where the bytes are, on the node-write-pod shape
 * the image store's writer uses (store-writer.ts).
 *
 * Two keep-lists, both handed in by the caller from its own records:
 *  - **project ids.** A `projects/<x>` or `shared-images/<x>` whose `x` no
 *    live project holds goes whole. That covers every removal whose own
 *    cleanup pod failed or never reached the node, and every tree named
 *    before projects had ids — except a tree a live pod still mounts, read
 *    off this install's pod specs, which is what spares a pod created
 *    under the old naming until it stops.
 *  - **worktree ids.** Inside a live project, an opencode working copy
 *    whose worktree is not live goes: a stopped worktree's copy is either
 *    already deleted by its own `preStop` checkpoint or a stale copy the
 *    global checkpoint outranks on the next start.
 * Either way, what was written since the cutoff stays: a create staging
 * into a directory its pod has not appeared with yet (the same slack
 * `inUseBySweep` gives the global half).
 */
import crypto from 'node:crypto'
import path from 'node:path'
import {
  PRIORITY_CLASS_INFRA,
  dataDirHash,
  k8sNamespace,
  kubectlGetJson,
  kubectlWithRetry,
  nodeLocalNodePath,
  runPodToCompletion,
  worktreePodSelector,
} from '#drivers/k8s/substrate'
import { ensureBuilderImage } from '#drivers/k8s/cluster'
import { serverLog } from '#log'
import type { NodeLocalLiveSet } from '#drivers/contract'

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

function sweepLabels(): Record<string, string> {
  return { app: NODE_LOCAL_SWEEP_APP_LABEL, [LABEL_SWEEP_DATA_DIR_HASH]: dataDirHash() }
}

/**
 * The in-pod script. Argv is `<cutoff epoch seconds> <kept names>
 * <live worktree ids>`, both lists comma-separated. It removes each
 * `/node/{projects,shared-images}/<x>` whose `x` is not a kept name, then
 * each `/node/projects/<x>/opencode-data/<id>` whose `id` is not a live
 * worktree — in both cases only when its mtime is older than the cutoff
 * (`find -newermt` is the in-pod form of the slack).
 *
 * Never through a symlink. The tree is mounted read-write into worktree
 * pods, so a pod can replace a directory (or an entry under it) with a link
 * to anywhere on the node; a walk that followed it would `rm -rf` the
 * target as root. Every level is tested with `-L` and a link is skipped.
 */
export function buildNodeLocalSweepScript(): string {
  return [
    'set -u',
    'CUTOFF="$1"; KEPT=",$2,"; LIVE=",$3,"',
    'fresh() { [ -n "$(find "$1" -maxdepth 0 -newermt "@$CUTOFF" 2>/dev/null)" ]; }',
    'removed=0',
    'for root in /node/projects /node/shared-images; do',
    '  [ -d "$root" ] && [ ! -L "$root" ] || continue',
    '  for dir in "$root"/*; do',
    '    [ -d "$dir" ] && [ ! -L "$dir" ] || continue',
    '    x=$(basename "$dir")',
    '    case "$KEPT" in *",$x,"*) continue;; esac',
    '    fresh "$dir" && continue',
    '    rm -rf "$dir" && removed=$((removed+1)) && echo "removed ${root#/node/}/$x"',
    '  done',
    'done',
    'for projdir in /node/projects/*; do',
    '  [ -d "$projdir" ] && [ ! -L "$projdir" ] || continue',
    '  kinddir="$projdir/opencode-data"',
    '  [ -d "$kinddir" ] && [ ! -L "$kinddir" ] || continue',
    '  for entry in "$kinddir"/*; do',
    '    [ -e "$entry" ] && [ ! -L "$entry" ] || continue',
    '    id=$(basename "$entry")',
    '    case "$LIVE" in *",$id,"*) continue;; esac',
    // A directory touched since the cutoff is a create staging into it.
    '    fresh "$entry" && continue',
    '    rm -rf "$entry" && removed=$((removed+1)) && echo "removed $(basename "$projdir")/opencode-data/$id"',
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
  /** Live project ids plus every name a live pod mounts. */
  kept: ReadonlySet<string>
  liveWorktreeIds: ReadonlySet<string>
  cutoffEpoch: number
  runId: string
  nodeIndex: number
}): Record<string, unknown> {
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
          String(params.cutoffEpoch), [...params.kept].join(','), [...params.liveWorktreeIds].join(','),
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

interface RawPodList {
  items: Array<{ spec?: { volumes?: Array<{ hostPath?: { path?: string } }> } }>
}

/**
 * The `<x>` of every `projects/<x>` and `shared-images/<x>` a pod of this
 * install mounts, read off the pod specs the server wrote. Rejects rather
 * than resolving empty: an unreadable list must not read as "nothing is
 * mounted".
 */
async function mountedProjectNames(): Promise<Set<string>> {
  const pods = await kubectlGetJson<RawPodList>([
    'get', 'pods', '-n', k8sNamespace(), '-l', worktreePodSelector(),
  ])
  const names = new Set<string>()
  for (const pod of pods?.items ?? []) {
    for (const vol of pod.spec?.volumes ?? []) {
      const p = vol.hostPath?.path
      if (!p) continue
      const [tier, name] = path.posix.relative(nodeLocalNodePath(), p).split('/')
      if ((tier === 'projects' || tier === 'shared-images') && name) names.add(name)
    }
  }
  return names
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
  live: NodeLocalLiveSet,
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
    const kept = new Set([...live.projectIds, ...await mountedProjectNames()])
    const nodes = await kubectlGetJson<RawNodeList>(['get', 'nodes'])
    for (const [nodeIndex, { metadata }] of (nodes?.items ?? []).entries()) {
      const manifest = buildNodeLocalSweepPodManifest({
        nodeName: metadata.name,
        imageRef,
        kept,
        liveWorktreeIds: live.worktreeIds,
        cutoffEpoch,
        runId,
        nodeIndex,
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
