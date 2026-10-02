/**
 * Node-local orphan sweep: one root pod per node removes what no live
 * project or workspace owns from this install's node-local directory
 * (package caches, opencode working copies and nested image stores; see
 * docs/server-in-cluster.md). That data lives on whichever node the
 * workspace ran on, so the sweep runs there.
 *
 * - A `projects/<x>` or `shared-images/<x>` is removed when `x` is not a
 *   live project id and no live pod mounts it.
 * - Inside a live project, an opencode working copy is removed when its
 *   workspace is not live (the global checkpoint is newer).
 *
 * Anything modified since the cutoff is kept, since a create may be
 * staging into it before its pod appears.
 */
import path from 'node:path'
import {
  dataDirHash,
  k8sNamespace,
  kubectlGetJson,
  nodeLocalNodePath,
  runOnEachNode,
  workspacePodSelector,
} from '#drivers/k8s/substrate'
import { ensureBuilderImage } from '#drivers/k8s/cluster'
import { serverLog } from '#log'
import type { NodeLocalLiveSet } from '#drivers/contract'

/** Where the sweep pod mounts the install's node-local tree. */
const SWEEP_POD_PATH = '/node'

/** `app` label of every sweep pod, used to delete strays. */
const NODE_LOCAL_SWEEP_APP_LABEL = 'yaac-node-local-sweep'

/** Ties sweep pods to this install without making them visible to the
 *  workspace reaper (which filters on `yaac.workspace-id`). */
export const LABEL_SWEEP_DATA_DIR_HASH = 'yaac.sweep-data-dir-hash'

/** Min interval between sweeps; each one runs a pod per node. */
export const NODE_LOCAL_SWEEP_INTERVAL_MS = 60 * 60_000

/** Deadline for one node's sweep: a walk over one tree and some `rm -rf`s. */
const NODE_LOCAL_SWEEP_TIMEOUT_MS = 5 * 60_000

/** How far before the sweep's start a write still counts as in use. */
const NODE_LOCAL_SWEEP_SLACK_MS = 10_000

function sweepLabels(): Record<string, string> {
  return { app: NODE_LOCAL_SWEEP_APP_LABEL, [LABEL_SWEEP_DATA_DIR_HASH]: dataDirHash() }
}

/**
 * The in-pod script. Argv is `<cutoff epoch seconds> <kept names>
 * <live workspace ids>` (lists comma-separated). Removes each unkept
 * `/node/{projects,shared-images}/<x>` and each
 * `/node/projects/<x>/opencode-data/<id>` of a non-live workspace, when
 * older than the cutoff.
 *
 * Symlinks are always skipped: workspace pods can write this tree, so a
 * link could point anywhere on the node and this runs as root.
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
    '    fresh "$entry" && continue',
    '    rm -rf "$entry" && removed=$((removed+1)) && echo "removed $(basename "$projdir")/opencode-data/$id"',
    '  done',
    'done',
    'echo "node-local-sweep removed $removed"',
  ].join('\n')
}

interface RawPodList {
  items: Array<{ spec?: { volumes?: Array<{ hostPath?: { path?: string } }> } }>
}

/**
 * The `<x>` of every `projects/<x>` and `shared-images/<x>` a workspace pod
 * of this install mounts. Throws if pods cannot be listed, rather than
 * returning an empty set.
 */
async function mountedProjectNames(): Promise<Set<string>> {
  const pods = await kubectlGetJson<RawPodList>([
    'get', 'pods', '-n', k8sNamespace(), '-l', workspacePodSelector(),
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

/**
 * See `WorkspaceDriver.reapNodeLocal`. Runs one pod per node, at most once
 * per {@link NODE_LOCAL_SWEEP_INTERVAL_MS}. Failures are only logged.
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
    const imageRef = await ensureBuilderImage()
    const cutoffEpoch = Math.floor((now - NODE_LOCAL_SWEEP_SLACK_MS) / 1000)
    const kept = new Set([...live.projectIds, ...await mountedProjectNames()])
    // Root, with the install's node directory mounted read-write. The
    // builder image, because busybox lacks `find -newermt`.
    const runs = await runOnEachNode({
      name: 'yaac-node-sweep',
      labels: sweepLabels(),
      timeoutMs: NODE_LOCAL_SWEEP_TIMEOUT_MS,
      pod: () => ({
        image: imageRef,
        command: [
          'sh', '-c', `${buildNodeLocalSweepScript()}\n`, '--',
          String(cutoffEpoch), [...kept].join(','), [...live.workspaceIds].join(','),
        ],
        container: {
          securityContext: { runAsUser: 0 },
          volumeMounts: [{ name: 'node', mountPath: SWEEP_POD_PATH }],
        },
        spec: {
          volumes: [{
            name: 'node',
            hostPath: { path: nodeLocalNodePath(), type: 'DirectoryOrCreate' },
          }],
        },
      }),
    })
    for (const { node, phase, logs } of runs) {
      const tail = logs.trim().split('\n').slice(-3).join(' | ')
      if (phase !== 'Succeeded') {
        serverLog(`[node-local-sweep] ${node}: pod ${phase}${tail ? `; ${tail}` : ''}`)
      } else if (tail && !tail.endsWith('removed 0')) {
        serverLog(`[node-local-sweep] ${node}: ${tail}`)
      }
    }
  } catch (err) {
    serverLog(`[node-local-sweep] ${String(err)}`)
  } finally {
    sweeping = false
  }
}
