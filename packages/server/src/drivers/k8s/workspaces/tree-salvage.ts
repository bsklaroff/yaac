import { createHash } from 'node:crypto'
import type { WorkspaceMount, WorkspaceTree } from '#drivers/contract'
import {
  LABEL_INSTALL_ID,
  PRIORITY_CLASS_INFRA,
  RUNTIME_CLASS_GVISOR,
  installId,
  installSecurityContext,
  k8sNamespace,
  readObject,
  resolveMountSource,
  runPodToCompletion,
} from '#drivers/k8s/substrate'
import { TREE_RESOURCES } from './pod-job'
import { treeImage, treeMounts } from './tree-mounts'

/**
 * The salvage pod (docs/node-local-workspaces.md "Life cycle"): the
 * tree container's final pass, for a life whose pod ended with no warning
 * and left its tree on its node. One gVisor pod pinned to that node, with
 * the tree container's mounts and capabilities, no service account token,
 * and no egress: it carries neither the workspace label nor the builder
 * role, so the namespace's `yaac-egress-world-deny` covers it.
 */

/** A salvage or import that stages a large repository takes minutes. */
const TREE_POD_TIMEOUT_MS = 30 * 60_000

export async function salvageTree(target: {
  projectId: string
  workspaceId: string
  node: string
  tree: WorkspaceTree
}): Promise<'saved' | 'node-gone'> {
  const node = await readObject<{ status?: { conditions?: Array<{ type?: string; status?: string }> } }>(
    { apiVersion: 'v1', kind: 'Node', name: target.node },
  )
  if (!node) return 'node-gone'
  if (node.status?.conditions?.find((c) => c.type === 'Ready')?.status !== 'True') {
    throw new Error(`node ${target.node} is not ready`)
  }
  await runTreePod('salvage', target.workspaceId, target.tree, treeMounts(target.tree).container, target.node)
  return 'saved'
}

/**
 * Take a checkpoint of a workspace whose files are still on the shared
 * tier, leaving them as they are (docs/node-local-workspaces.md
 * "Workspaces from before"): the same pod, on any node, with the shared
 * directory as its tree and a scratch repository of its own.
 */
export async function importTree(target: {
  projectId: string
  workspaceId: string
  sharedDir: string
  tree: WorkspaceTree
}): Promise<void> {
  const mounts: WorkspaceMount[] = treeMounts(target.tree).container.flatMap((m): WorkspaceMount[] => {
    if (m.mountPath === '/tree') return [{ source: { kind: 'hostPath', path: target.sharedDir }, mountPath: '/tree', readOnly: true }]
    if (m.mountPath === '/scratch') return [{ source: { kind: 'emptyDir' }, mountPath: '/scratch' }]
    return [m]
  })
  await runTreePod('import', target.workspaceId, target.tree, mounts)
}

/** Run `yaac-tree <command>` for a life's tree in a one-shot pod, pinned to
 *  `node` when given. Rejects unless it succeeds. The pod is named for the
 *  workspace and life, so starting one first removes any earlier pod still
 *  working on that tree (one a restarted server left), and two never run
 *  on it at once. */
async function runTreePod(
  command: 'salvage' | 'import', workspaceId: string, tree: WorkspaceTree, declared: WorkspaceMount[], node?: string,
): Promise<void> {
  const mounts = declared.map(resolveMountSource)
  const volumes = mounts.map((m, i) => ({
    name: `tree-${String(i)}`,
    ...(m.source.kind === 'pvc'
      ? { persistentVolumeClaim: { claimName: m.source.claimName } }
      : m.source.kind === 'hostPath'
        ? { hostPath: { path: m.source.path, type: m.source.type ?? 'Directory' } }
        : { emptyDir: {} }),
  }))
  const volumeMounts = mounts.map((m, i) => ({
    name: `tree-${String(i)}`,
    mountPath: m.mountPath,
    ...(m.source.kind === 'pvc' && m.source.subPath ? { subPath: m.source.subPath } : {}),
    ...(m.readOnly ? { readOnly: true } : {}),
  }))
  const { runAsUser, runAsGroup } = installSecurityContext()
  const name = `yaac-tree-${command}-${createHash('sha256').update(`${workspaceId}/${tree.life}`).digest('hex').slice(0, 16)}`
  const { phase, logs } = await runPodToCompletion({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: k8sNamespace(), labels: { app: `yaac-tree-${command}`, [LABEL_INSTALL_ID]: installId() } },
    spec: {
      ...(node !== undefined ? { nodeName: node } : {}),
      restartPolicy: 'Never',
      activeDeadlineSeconds: TREE_POD_TIMEOUT_MS / 1000,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      priorityClassName: PRIORITY_CLASS_INFRA,
      runtimeClassName: RUNTIME_CLASS_GVISOR,
      tolerations: [{ operator: 'Exists' }],
      securityContext: { runAsUser, runAsGroup },
      containers: [{
        name: command,
        image: await treeImage(),
        imagePullPolicy: 'IfNotPresent',
        command: ['yaac-tree', command, '--tree', '/tree', '--scratch', '/scratch', '--ckpt', '/ckpt', '--life', tree.life],
        securityContext: {
          runAsUser: 0,
          runAsGroup: 0,
          capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] },
        },
        resources: TREE_RESOURCES,
        volumeMounts,
      }],
      volumes,
    },
  }, { timeoutMs: TREE_POD_TIMEOUT_MS })
  if (phase !== 'Succeeded') {
    const tail = logs.trim().split('\n').slice(-3).join(' | ')
    throw new Error(`${command} pod ${name} ended ${phase}${tail ? `: ${tail}` : ''}`)
  }
}
