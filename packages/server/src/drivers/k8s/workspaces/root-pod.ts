/**
 * One-shot root pods, each mounting one GLOBAL directory and nothing else:
 * the root remover, which deletes entries the server pod cannot, and runs
 * of a script on a stopped workspace's checkout. gVisor has no user
 * namespace, so what a workspace's agent writes through `sudo` lands on the
 * claim as real uid 0, and the server runs as the install uid
 * (docs/server-in-cluster.md "The uid everything runs as"). The server
 * stays unprivileged; only these pods, which see nothing but the one
 * directory, run as root.
 *
 * A pod mounts the `yaac-global` claim rather than a hostPath, so it runs
 * on any node and on either storage backing. On an NFS export that squashes
 * root (which install's storage binder refuses, unless the class's
 * `mountPermissions` gets past it), the pod's root is squashed to an
 * unprivileged uid too, so it may fail where the server did.
 *
 * Callers must only pass a directory that no running pod can write, nor
 * any ancestor of it below the global root: workspace pods mount only leaf
 * subPaths (a checkout, a tool home, a history dir), never `projects/`, a
 * project dir or its `workspaces/`, and a stopped workspace's checkout has
 * no pod. That is what keeps the `realpath` check below true until kubelet
 * mounts the subPath. kubelet only keeps a subPath inside the claim, so a
 * link swapped in meanwhile would otherwise be followed to another
 * directory of it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  GLOBAL_CLAIM_NAME,
  LABEL_INSTALL_ID,
  PRIORITY_CLASS_INFRA,
  RUNTIME_CLASS_GVISOR,
  deleteObjects,
  installId,
  k8sNamespace,
  k8sWorkspacePaths,
  runPodToCompletion,
} from '#drivers/k8s/substrate'
import { ensureBuilderImage, registryRef, resolveTrustedLayers } from '#drivers/k8s/cluster'
import { isEntryName } from '#lib/confined-fs'
import { globalRoot } from '@yaac/shared/paths'
import { workspaceDir } from '@yaac/shared/project-paths'

/** Where the root remover mounts the directory whose entries it removes. */
const TARGET_POD_PATH = '/target'

/** Deadline for one removal: a recursive `rm` over the network share. */
const ROOT_REMOVE_TIMEOUT_MS = 5 * 60_000

/** `rm` of direct children only, so no link along the way is followed. */
const ROOT_REMOVE_SCRIPT = `cd ${TARGET_POD_PATH} && rm -rf -- "$@"`

/**
 * Run `command` as root in a pod of its own that mounts `dir` at
 * `mountPath`. Refuses, before any pod runs, a `dir` that is not strictly
 * under the GLOBAL root or that reaches it through a link; rejects with the
 * pod's last words unless it succeeds.
 */
async function runRootPod(dir: string, pod: {
  /** The `app` label of every pod for this purpose, and each one's name
   *  prefix and container name. */
  app: string
  prefix: string
  container: string
  image: string
  /** Set for a pod that reads what a workspace wrote, as the builder pods
   *  do; the remover only unlinks, under runc. */
  runtimeClassName?: string
  mountPath: string
  command: string[]
  timeoutMs: number
}): Promise<void> {
  const rel = path.relative(globalRoot(), path.resolve(dir))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to run as root under ${dir}: not inside ${globalRoot()}`)
  }
  const realRel = path.relative(await fs.realpath(globalRoot()), await fs.realpath(dir))
  if (realRel !== rel) throw new Error(`refusing to run as root under ${dir}: it is reached through a link`)

  // Each call has its own pod, since calls on one `dir` (every workspace
  // delete's last step) may run at once. Only finished pods are swept: one
  // a crashed server left ends by its deadline, while a running one may be
  // another call's.
  const labels = { app: pod.app, [LABEL_INSTALL_ID]: installId() }
  await deleteObjects('v1', 'Pod', {
    namespace: k8sNamespace(),
    labelSelector: Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(','),
    fieldSelector: 'status.phase!=Pending,status.phase!=Running',
  })
  const name = `${pod.prefix}-${crypto.randomBytes(6).toString('hex')}`
  const { phase, logs } = await runPodToCompletion({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: k8sNamespace(), labels },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: pod.timeoutMs / 1000,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      priorityClassName: PRIORITY_CLASS_INFRA,
      ...(pod.runtimeClassName !== undefined ? { runtimeClassName: pod.runtimeClassName } : {}),
      containers: [{
        name: pod.container,
        image: pod.image,
        imagePullPolicy: 'IfNotPresent',
        command: pod.command,
        securityContext: { runAsUser: 0 },
        // kubelet resolves a subPath without leaving the volume.
        volumeMounts: [{ name: 'global', mountPath: pod.mountPath, subPath: rel }],
      }],
      volumes: [{ name: 'global', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } }],
    },
  }, { timeoutMs: pod.timeoutMs })
  if (phase !== 'Succeeded') {
    const tail = logs.trim().split('\n').slice(-3).join(' | ')
    throw new Error(`root pod ${name} for ${dir} ended ${phase}${tail ? `: ${tail}` : ''}`)
  }
}

/** See `WorkspaceDriver.removeAsRoot`. Refuses a name that is not one plain
 *  path component. */
export async function removeAsRoot(dir: string, names: string[]): Promise<boolean> {
  const bad = names.find((n) => !isEntryName(n))
  if (bad !== undefined) throw new Error(`refusing to remove ${JSON.stringify(bad)} as root: not an entry name`)
  if (names.length === 0) return true
  await runRootPod(dir, {
    app: 'yaac-root-remove',
    prefix: 'yaac-root-rm',
    container: 'rm',
    image: await ensureBuilderImage(),
    mountPath: TARGET_POD_PATH,
    command: ['sh', '-c', ROOT_REMOVE_SCRIPT, '--', ...names],
    timeoutMs: ROOT_REMOVE_TIMEOUT_MS,
  })
  return true
}

/**
 * See `WorkspaceDriver.runInStoppedCheckout`. The pod runs the yaac base
 * image, which has git and a shell whatever image the project builds, under
 * gVisor, since the script reads files the workspace wrote. gVisor's root
 * is real root on the claim, so it removes what the agent wrote through
 * `sudo`.
 */
export async function runInStoppedCheckout(
  target: { projectId: string; workspaceId: string },
  script: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<void> {
  const mountPath = k8sWorkspacePaths().workspaceDir
  await runRootPod(workspaceDir(target.projectId, target.workspaceId), {
    app: 'yaac-root-run',
    prefix: 'yaac-root-run',
    container: 'run',
    image: registryRef((await resolveTrustedLayers()).base.tag),
    runtimeClassName: RUNTIME_CLASS_GVISOR,
    mountPath,
    command: ['sh', '-c', script, 'sh', mountPath, ...args],
    timeoutMs: opts.timeoutMs,
  })
}
