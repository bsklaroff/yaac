/**
 * The root remover: a one-shot root pod that deletes entries of a GLOBAL
 * directory the server pod cannot. gVisor has no user namespace, so what a
 * workspace's agent writes through `sudo` lands on the claim as real uid 0,
 * and the server runs as the install uid (docs/server-in-cluster.md "The
 * uid everything runs as"). The server stays unprivileged; only this pod,
 * which sees nothing but the one directory, runs as root.
 *
 * The pod mounts the `yaac-global` claim rather than a hostPath, so it runs
 * on any node and on either storage backing. On an NFS export that squashes
 * root (which install's storage binder refuses, unless the class's
 * `mountPermissions` gets past it), this pod's root is squashed to an
 * unprivileged uid too, so it may fail where the server did.
 *
 * Callers must only pass a `dir` that no pod can write, nor any ancestor of
 * it below the global root: today workspace pods mount only leaf subPaths
 * (a checkout, a tool home, a history dir), never `projects/`, a project
 * dir or its `workspaces/`. That is what keeps the `realpath` check below
 * true until kubelet mounts the subPath. kubelet only keeps a subPath inside
 * the claim, so a link swapped in meanwhile would otherwise be followed to
 * another directory of it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  GLOBAL_CLAIM_NAME,
  LABEL_INSTALL_ID,
  PRIORITY_CLASS_INFRA,
  deleteObjects,
  installId,
  k8sNamespace,
  runPodToCompletion,
} from '#drivers/k8s/substrate'
import { ensureBuilderImage } from '#drivers/k8s/cluster'
import { isEntryName } from '#lib/confined-fs'
import { globalRoot } from '@yaac/shared/paths'

/** Where the pod mounts the directory whose entries it removes. */
const TARGET_POD_PATH = '/target'

/** Deadline for one removal: a recursive `rm` over the network share. */
const ROOT_REMOVE_TIMEOUT_MS = 5 * 60_000

/** `rm` of direct children only, so no link along the way is followed. */
const ROOT_REMOVE_SCRIPT = `cd ${TARGET_POD_PATH} && rm -rf -- "$@"`

/**
 * See `WorkspaceDriver.removeAsRoot`. Refuses, before any pod runs, a
 * `dir` that is not strictly under the GLOBAL root or that reaches it
 * through a link, and a name that is not one plain path component.
 */
export async function removeAsRoot(dir: string, names: string[]): Promise<boolean> {
  const rel = path.relative(globalRoot(), path.resolve(dir))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to remove as root under ${dir}: not inside ${globalRoot()}`)
  }
  const realRel = path.relative(await fs.realpath(globalRoot()), await fs.realpath(dir))
  if (realRel !== rel) throw new Error(`refusing to remove as root under ${dir}: it is reached through a link`)
  const bad = names.find((n) => !isEntryName(n))
  if (bad !== undefined) throw new Error(`refusing to remove ${JSON.stringify(bad)} as root: not an entry name`)
  if (names.length === 0) return true

  // Each call has its own pod, since removals under one `dir` (every
  // workspace delete's last step) may run at once. Only finished pods are
  // swept: one a crashed server left ends by its deadline, while a running
  // one may be another call's.
  const labels = { app: 'yaac-root-remove', [LABEL_INSTALL_ID]: installId() }
  await deleteObjects('v1', 'Pod', {
    namespace: k8sNamespace(),
    labelSelector: Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(','),
    fieldSelector: 'status.phase!=Pending,status.phase!=Running',
  })
  const name = `yaac-root-rm-${crypto.randomBytes(6).toString('hex')}`
  const { phase, logs } = await runPodToCompletion({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: k8sNamespace(), labels },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: ROOT_REMOVE_TIMEOUT_MS / 1000,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      priorityClassName: PRIORITY_CLASS_INFRA,
      containers: [{
        name: 'rm',
        image: await ensureBuilderImage(),
        imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-c', ROOT_REMOVE_SCRIPT, '--', ...names],
        securityContext: { runAsUser: 0 },
        // kubelet resolves a subPath without leaving the volume.
        volumeMounts: [{ name: 'global', mountPath: TARGET_POD_PATH, subPath: rel }],
      }],
      volumes: [{ name: 'global', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } }],
    },
  }, { timeoutMs: ROOT_REMOVE_TIMEOUT_MS })
  if (phase !== 'Succeeded') {
    const tail = logs.trim().split('\n').slice(-3).join(' | ')
    throw new Error(`root removal pod ${name} for ${dir} ended ${phase}${tail ? `: ${tail}` : ''}`)
  }
  return true
}
