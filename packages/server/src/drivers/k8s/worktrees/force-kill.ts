import {
  FORCE_KILL_PREFIX,
  GVISOR_INSTALLER_APP_NAME,
  k8sNamespace,
  kubectlGetJson,
  kubectlWithRetry,
  listWorktreePods,
  sandboxForceKillScript,
} from '#drivers/k8s/substrate'
import type { ForceKillOutcome, TeardownTarget } from '#drivers/contract'

/**
 * How the k8s runtime forces a wedged workspace down: SIGKILL its gVisor
 * sandbox process on the node, through the installer DaemonSet pod that
 * already runs there privileged in the host PID namespace
 * (docs/stuck-sandbox-recovery.md).
 *
 * Nothing in the cluster's own vocabulary can do this. The kubelet's stop
 * goes through runsc, whose kill and state RPCs need the sentry's task-set
 * lock — the very lock a deadlocked sentry is holding — so every attempt
 * times out and the pod sits terminating for good. A signal to the host
 * process needs nothing from the sentry. Once it lands, containerd sees the
 * task exit and the ordinary teardown, re-issued, completes.
 */

/** Budget for the whole exec: the stack dump's own 20s deadline plus a
 *  pass over the node's process table. */
const FORCE_KILL_EXEC_TIMEOUT_MS = 60_000

/** The installer pod on the workspace's node, own namespace first — an e2e
 *  namespace has none of its own and borrows the install's. */
async function findInstallerPod(nodeName: string | undefined): Promise<
  { name: string; namespace: string } | undefined
> {
  const selectors = ['status.phase=Running', ...(nodeName ? [`spec.nodeName=${nodeName}`] : [])]
  const list = await kubectlGetJson<{
    items?: Array<{ metadata: { name: string; namespace: string } }>
  }>(['get', 'pods', '-A', '-l', `app=${GVISOR_INSTALLER_APP_NAME}`, '--field-selector', selectors.join(',')])
  const own = k8sNamespace()
  const pods = (list?.items ?? []).map((i) => i.metadata)
  return pods.find((p) => p.namespace === own) ?? pods[0]
}

export async function forceKillWorkspace(target: TeardownTarget): Promise<ForceKillOutcome> {
  try {
    const pod = (await listWorktreePods()).find((p) => p.jobName === target.unitName)
    if (!pod) return { forced: false, reason: 'no pod for the unit' }
    // The whole safety of a force: only a delete already issued gets one.
    if (!pod.terminating) return { forced: false, reason: 'pod is not terminating' }
    if (!pod.uid) return { forced: false, reason: 'pod carries no uid' }
    const installer = await findInstallerPod(pod.nodeName)
    if (!installer) {
      return { forced: false, reason: `no ${GVISOR_INSTALLER_APP_NAME} pod on node ${pod.nodeName ?? '?'}` }
    }
    const { stdout } = await kubectlWithRetry(
      ['exec', '-n', installer.namespace, installer.name, '--', 'sh', '-c', sandboxForceKillScript(pod.uid)],
      { timeout: FORCE_KILL_EXEC_TIMEOUT_MS, maxAttempts: 1 },
    )
    const forced = stdout.includes(`${FORCE_KILL_PREFIX} killed pid=`)
    return {
      forced,
      diagnostics: stdout,
      ...(forced ? {} : { reason: stdout.split('\n').find((l) => l.startsWith(FORCE_KILL_PREFIX)) ?? 'kill not confirmed' }),
    }
  } catch (err) {
    return { forced: false, reason: (err as Error).message }
  }
}
