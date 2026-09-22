import { shellQuote } from '#lib/shell'

/**
 * Node tuning: the kernel and systemd settings every node that runs
 * worktree pods needs, applied by the gVisor installer DaemonSet
 * (gvisor.ts composes `nodeTuningScript` into its per-node pass).
 *
 * These are real-node concerns as much as kind-node ones — subagent
 * fan-out and netd's Envoy die the same way on any node without them —
 * which is why they ride the one mechanism that reaches every node,
 * re-runs on every node that appears, and re-runs on a timer: a node that
 * restarts (a podman machine restart, a host reboot, a recycled cloud
 * node) gets its sysctls back from the installer pod kubelet restarts on
 * it, with no `yaac cluster install` re-run. What stays host-side in
 * install is only what a kind node CONTAINER has and a real node does not:
 * the container's pids ceiling and kubeadm's kubelet flags file.
 */

/** systemd drop-in directory the TasksMax override is written into. */
export const NODE_SYSTEMD_CONF_DIR = '/etc/systemd/system.conf.d'

/**
 * `DefaultTasksMax=infinity`: systemd's per-unit task ceiling defaults to
 * 15% of the pid max, which a worktree's subagent fan-out exhausts
 * (`fork: resource temporarily unavailable`). Applies to units started
 * after the reexec — the pod scopes of every worktree that lands on the
 * node afterwards.
 */
export const NODE_TASKSMAX_CONF = `${NODE_SYSTEMD_CONF_DIR}/10-yaac-tasksmax.conf`
export const NODE_TASKSMAX_CONTENT = '[Manager]\nDefaultTasksMax=infinity\n'

export const NODE_MIN_FREE_KBYTES = 262144
/**
 * inotify ceilings. On kind these are host-global rather than per-node —
 * the kind nodes are containers in the host's init user namespace, so all
 * of them draw on the ONE root-uid pool, and every node multiplies the
 * demand against a fixed budget; on a real node the pool is the node's
 * own. The stock 128 instances is not enough for a multi-node cluster:
 * netd's Envoy asserts on `inotify_fd_ >= 0` and dies with SIGSEGV, which
 * presents as every worktree losing its egress redirect rather than as
 * anything mentioning inotify.
 */
export const NODE_INOTIFY_MAX_USER_INSTANCES = 1024
export const NODE_INOTIFY_MAX_USER_WATCHES = 524288

/**
 * One sysctl the installer applies. `raise` writes only when the live
 * value is below the target — a ceiling an operator set higher must never
 * be lowered by yaac; `set` writes whenever the value differs.
 */
export interface NodeTuningSysctl {
  /** Path under /proc/sys. */
  path: string
  value: number
  mode: 'raise' | 'set'
  /** What breaks without it, for the check's warn detail. */
  why: string
}

/**
 * The sysctls, as the one table the script, the check and the tests read.
 * `vm.min_free_kbytes` and `compaction_proactiveness` keep virtiofs
 * allocations (the podman machine's shared filesystem) from failing under
 * memory pressure; the inotify pair is netd's.
 */
export const NODE_TUNING_SYSCTLS: readonly NodeTuningSysctl[] = [
  { path: 'vm/min_free_kbytes', value: NODE_MIN_FREE_KBYTES, mode: 'raise', why: 'virtiofs I/O' },
  { path: 'vm/compaction_proactiveness', value: 40, mode: 'set', why: 'virtiofs I/O' },
  {
    path: 'fs/inotify/max_user_instances',
    value: NODE_INOTIFY_MAX_USER_INSTANCES,
    mode: 'raise',
    why: 'netd Envoy startup',
  },
  {
    path: 'fs/inotify/max_user_watches',
    value: NODE_INOTIFY_MAX_USER_WATCHES,
    mode: 'raise',
    why: 'netd Envoy startup',
  },
]

/** `vm.min_free_kbytes` spelling of a `vm/min_free_kbytes` path. */
export function sysctlName(s: NodeTuningSysctl): string {
  return s.path.replaceAll('/', '.')
}

/**
 * The `tune_pass` shell function the installer runs on every pass, before
 * the runtime install. Expects the installer script's `write_if_changed`
 * helper and its `/host` prefix.
 *
 * Writes go to the pod's own `/proc/sys`: none of these sysctls is
 * namespaced, and a privileged container mounts `/proc/sys` read-write,
 * so the pod's view is the kernel's. The TasksMax drop-in is written on
 * the node's filesystem through the hostPath mount and systemd told to
 * reexec only when the file changed — under its own flag, never the one
 * that restarts containerd. Every write logs, so `kubectl logs` shows
 * what a pass changed on a node.
 *
 * Under `set -eu`, a write that fails ends the pass, and with it the
 * node's readiness and its runtime label: a node yaac cannot tune is a
 * node whose worktrees would die late, so it is a node yaac does not
 * schedule onto.
 */
export function nodeTuningScript(): string {
  const q = shellQuote
  const lines = [
    '# Node tuning. Ceilings are raised, never lowered: an operator who set',
    '# more than yaac needs keeps it.',
    'tune_sysctl() {',
    '  cur=$(cat "/proc/sys/$1")',
    '  if [ "$3" = raise ] && [ "$cur" -ge "$2" ]; then return 0; fi',
    '  if [ "$3" = set ] && [ "$cur" = "$2" ]; then return 0; fi',
    '  echo "yaac-gvisor: sysctl $1: $cur -> $2"',
    '  echo "$2" > "/proc/sys/$1"',
    '}',
    '',
    'tune_pass() {',
    '  reexec=0',
  ]
  for (const s of NODE_TUNING_SYSCTLS) {
    lines.push(`  tune_sysctl ${q(s.path)} ${String(s.value)} ${s.mode}`)
  }
  lines.push(
    `  if write_if_changed ${q(`/host${NODE_TASKSMAX_CONF}`)} ${q(NODE_TASKSMAX_CONTENT)}; then`,
    '    reexec=1',
    '  fi',
    '  if [ "$reexec" = 1 ]; then',
    '    echo "yaac-gvisor: DefaultTasksMax drop-in written; reexecing the node\'s systemd"',
    '    nsenter -t 1 -m -- systemctl daemon-reexec',
    '  fi',
    '}',
  )
  return lines.join('\n')
}
