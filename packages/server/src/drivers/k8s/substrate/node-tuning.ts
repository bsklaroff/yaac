import { shellQuote } from '#lib/shell'

/**
 * Kernel and systemd settings every node running workspace pods needs.
 * The gVisor installer DaemonSet applies them (gvisor.ts includes
 * `nodeTuningScript` in its per-node pass), so they reach every node,
 * including new or restarted ones, and are re-applied on a timer without
 * rerunning `yaac cluster install`. Settings specific to kind node
 * containers stay in install.
 */

/** systemd drop-in directory the TasksMax override is written into. */
export const NODE_SYSTEMD_CONF_DIR = '/etc/systemd/system.conf.d'

/**
 * `DefaultTasksMax=infinity`. systemd's per-unit task limit defaults to 15%
 * of the pid max, which a workspace's subagent fan-out can exhaust
 * (`fork: resource temporarily unavailable`). The drop-in survives reboots;
 * the reexec applies it to pods started afterwards.
 */
export const NODE_TASKSMAX_CONF = `${NODE_SYSTEMD_CONF_DIR}/10-yaac-tasksmax.conf`
export const NODE_TASKSMAX_CONTENT = '[Manager]\nDefaultTasksMax=infinity\n'
/** What `systemctl show -p DefaultTasksMax --value` answers once applied. */
export const NODE_TASKSMAX_LIVE = 'infinity'

export const NODE_MIN_FREE_KBYTES = 262144
/**
 * inotify limits. On kind all nodes share the host's pool, and the default
 * 128 instances is too few for a multi-node cluster: netd's Envoy then
 * crashes (SIGSEGV on `inotify_fd_ >= 0`) and workspaces lose egress.
 */
export const NODE_INOTIFY_MAX_USER_INSTANCES = 1024
export const NODE_INOTIFY_MAX_USER_WATCHES = 524288

/**
 * One sysctl the installer applies. `raise` writes only when the live value
 * is lower (an operator's higher value is kept); `set` writes whenever it
 * differs. A sysctl the kernel lacks (e.g. `compaction_proactiveness`
 * before 5.9) is logged and skipped.
 */
interface NodeTuningSysctl {
  /** Path under /proc/sys. */
  path: string
  value: number
  mode: 'raise' | 'set'
  /** What breaks without it, for the check's warn detail. */
  why: string
}

/**
 * The sysctls, read by the script, the check and the tests.
 * `min_free_kbytes` and `compaction_proactiveness` keep virtiofs (the
 * podman machine's shared filesystem) from failing under memory pressure.
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

/**
 * The `tune_pass` shell function the installer runs each pass, before the
 * runtime install. Needs the installer's `write_if_changed` helper and its
 * `/host` prefix.
 *
 * These sysctls are not namespaced, so writing the privileged pod's
 * `/proc/sys` sets them for the node. systemd is reexeced only when its
 * live `DefaultTasksMax` is wrong, and at most once per pod life so an
 * overriding drop-in is logged rather than reexeced forever. A failed write
 * exits the pass (`set -e` does not apply inside `if`), so the node never
 * gets its runtime label and yaac does not schedule onto it.
 */
export function nodeTuningScript(): string {
  const q = shellQuote
  const lines = [
    '# Node tuning. Ceilings are raised, never lowered: an operator who set',
    '# more than yaac needs keeps it.',
    'tasksmax_reexeced=0',
    '',
    'tune_sysctl() {',
    '  if [ ! -e "/proc/sys/$1" ]; then',
    '    echo "yaac-gvisor: sysctl $1 is not on this kernel; skipped"',
    '    return 0',
    '  fi',
    '  cur=$(cat "/proc/sys/$1")',
    '  if [ "$3" = raise ] && [ "$cur" -ge "$2" ]; then return 0; fi',
    '  if [ "$3" = set ] && [ "$cur" = "$2" ]; then return 0; fi',
    '  echo "yaac-gvisor: sysctl $1: $cur -> $2"',
    '  echo "$2" > "/proc/sys/$1" || exit 1',
    '}',
    '',
    'tune_pass() {',
  ]
  for (const s of NODE_TUNING_SYSCTLS) {
    lines.push(`  tune_sysctl ${q(s.path)} ${String(s.value)} ${s.mode}`)
  }
  lines.push(
    // Check the live value, not the file, so an interrupted pass retries.
    `  if write_if_changed ${q(`/host${NODE_TASKSMAX_CONF}`)} ${q(NODE_TASKSMAX_CONTENT)}; then tasksmax_reexeced=0; fi`,
    `  if [ "$(nsenter -t 1 -m -- systemctl show -p DefaultTasksMax --value)" != ${q(NODE_TASKSMAX_LIVE)} ]; then`,
    '    if [ "$tasksmax_reexeced" = 1 ]; then',
    '      echo "yaac-gvisor: DefaultTasksMax is still not infinity after a reexec — another drop-in overrides it?" >&2',
    '    else',
    '      echo "yaac-gvisor: DefaultTasksMax drop-in in place; reexecing the node\'s systemd"',
    '      nsenter -t 1 -m -- systemctl daemon-reexec',
    '      tasksmax_reexeced=1',
    '    fi',
    '  fi',
    '}',
  )
  return lines.join('\n')
}
