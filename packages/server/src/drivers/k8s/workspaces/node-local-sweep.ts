/**
 * Node-local orphan sweep: one root pod per node removes what no live
 * project or workspace owns from this install's node-local directory
 * (package caches and opencode working copies; see
 * docs/server-in-cluster.md). That data lives on whichever node the
 * workspace ran on, so the sweep runs there.
 *
 * - A `projects/<x>` is removed when `x` is not a live project id and no
 *   live pod mounts it.
 * - Inside a live project, an opencode working copy is removed when its
 *   workspace is not live (the global checkpoint is newer).
 * - A `shared-images/<x>`, an image store of a retired nested-container
 *   workspace, is removed unless a live pod mounts it
 *   (docs/legacy-compat-shims.md "Node-local image stores").
 *
 * Anything modified since the cutoff is kept, since a create may be
 * staging into it before its pod appears.
 */
import path from 'node:path'
import {
  LABEL_INSTALL_ID,
  installId,
  k8sNamespace,
  listObjects,
  nodeLocalNodePath,
  runOnEachNode,
  workspacePodSelector,
} from '#drivers/k8s/substrate'
import { ensureBuilderImage } from '#drivers/k8s/cluster'
import { serverLog } from '#lib/log'
import type { NodeLocalLiveSet } from '#drivers/contract'

/** Where the sweep pod mounts the install's node-local tree. */
const SWEEP_POD_PATH = '/node'

/** `app` label of every sweep pod, used to delete strays. */
const NODE_LOCAL_SWEEP_APP_LABEL = 'yaac-node-local-sweep'

/** Deadline for one node's sweep: a walk over one tree and some `rm -rf`s. */
const NODE_LOCAL_SWEEP_TIMEOUT_MS = 5 * 60_000

/** How far before the sweep's start a write still counts as in use. */
const NODE_LOCAL_SWEEP_SLACK_MS = 10_000

function sweepLabels(): Record<string, string> {
  return { app: NODE_LOCAL_SWEEP_APP_LABEL, [LABEL_INSTALL_ID]: installId() }
}

/**
 * The in-pod script. Argv is `<cutoff epoch seconds> <kept names>
 * <live workspace ids> <mounted image stores>` (lists comma-separated).
 * Removes each unkept `/node/projects/<x>` and each
 * `/node/projects/<x>/opencode-data/<id>` of a non-live workspace, when
 * older than the cutoff, and each unmounted `/node/shared-images/<x>`.
 *
 * Symlinks are always skipped: workspace pods can write this tree, so a
 * link could point anywhere on the node and this runs as root.
 */
export function buildNodeLocalSweepScript(): string {
  return [
    'set -u',
    'CUTOFF="$1"; KEPT=",$2,"; LIVE=",$3,"; STORES=",$4,"',
    'fresh() { [ -n "$(find "$1" -maxdepth 0 -newermt "@$CUTOFF" 2>/dev/null)" ]; }',
    'removed=0',
    'for dir in /node/projects/*; do',
    '  [ -d "$dir" ] && [ ! -L "$dir" ] || continue',
    '  x=$(basename "$dir")',
    '  case "$KEPT" in *",$x,"*) continue;; esac',
    '  fresh "$dir" && continue',
    '  rm -rf "$dir" && removed=$((removed+1)) && echo "removed projects/$x"',
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
    'if [ -d /node/shared-images ] && [ ! -L /node/shared-images ]; then',
    '  for dir in /node/shared-images/*; do',
    '    [ -d "$dir" ] && [ ! -L "$dir" ] || continue',
    '    x=$(basename "$dir")',
    '    case "$STORES" in *",$x,"*) continue;; esac',
    '    rm -rf "$dir" && removed=$((removed+1)) && echo "removed shared-images/$x"',
    '  done',
    '  rmdir /node/shared-images 2>/dev/null || true',
    'fi',
    'echo "node-local-sweep removed $removed"',
  ].join('\n')
}

interface RawPod {
  spec?: { volumes?: Array<{ hostPath?: { path?: string } }> }
}

/**
 * The `<x>` of every `projects/<x>` and of every `shared-images/<x>` a
 * workspace pod of this install mounts. Throws if pods cannot be listed,
 * rather than returning empty sets.
 */
async function mountedNames(): Promise<{ projects: Set<string>; stores: Set<string> }> {
  const pods = await listObjects<RawPod>('v1', 'Pod', {
    namespace: k8sNamespace(), labelSelector: workspacePodSelector(),
  })
  const mounted = { projects: new Set<string>(), stores: new Set<string>() }
  for (const pod of pods) {
    for (const vol of pod.spec?.volumes ?? []) {
      const p = vol.hostPath?.path
      if (!p) continue
      const [tier, name] = path.posix.relative(nodeLocalNodePath(), p).split('/')
      if (!name) continue
      if (tier === 'projects') mounted.projects.add(name)
      else if (tier === 'shared-images') mounted.stores.add(name)
    }
  }
  return mounted
}

/**
 * See `WorkspaceDriver.reapNodeLocal`. Runs one pod per node. Failures are
 * only logged.
 */
export async function reapNodeLocal(live: NodeLocalLiveSet): Promise<void> {
  const now = Date.now()
  try {
    const imageRef = await ensureBuilderImage()
    const cutoffEpoch = Math.floor((now - NODE_LOCAL_SWEEP_SLACK_MS) / 1000)
    const mounted = await mountedNames()
    const kept = new Set([...live.projectIds, ...mounted.projects])
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
          [...mounted.stores].join(','),
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
  }
}
