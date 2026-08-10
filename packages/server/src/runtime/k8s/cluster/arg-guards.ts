import { env } from '@yaac/shared/env'

/**
 * The `cluster setup`/`cluster delete` checks that can be answered from the
 * flags and the environment alone — no cluster, no binaries, no kubeconfig.
 *
 * They live apart from setup.ts and delete.ts for import cost, not tidiness.
 * Reaching either of those modules pulls `@kubernetes/client-node` (~2.8s to
 * evaluate; see the note in packages/cli/src/cli.ts), and every one of these
 * answers is already known before a single k8s type is needed. `yaac cluster
 * setup --nodes three` should cost the ~0.6s a CLI start costs, not ~3.7s to
 * be told a number was mistyped.
 *
 * So this module imports nothing but `env`, and the CLI calls
 * `clusterArgError` *before* it dynamically imports the command. setup.ts
 * and delete.ts still run the same guards themselves — they are the entry
 * points the server and the tests use — so the CLI's early call is a
 * fast path, never the only enforcement.
 */

/** A setup step failed in a way the user must resolve; message is the fix. */
export class ClusterSetupError extends Error {}

/** A delete step failed in a way the user must resolve; message is the fix. */
export class ClusterDeleteError extends Error {}

/**
 * Node-count ceiling for `--nodes`. Every kind node is a full node
 * container (kubelet, containerd, calico-node, netd, a runsc install) on
 * ONE host, so this is a rehearsal knob, not a capacity knob: 2–3 is what
 * shakes out scheduling assumptions, and anything past this is a way to
 * wedge a laptop rather than a supported topology.
 */
export const MAX_KIND_NODES = 5

/** The flags these guards read — a structural subset of ClusterSetupOptions. */
export interface ClusterSetupArgs {
  repair?: boolean
  adoptCni?: boolean
  nodes?: number | string
}

/**
 * Validate `--nodes` and return the node count to build. Runs before any
 * binary probe or podman call so a bad value costs nothing, and rejects
 * the combination that cannot mean anything: a node count is decided when
 * the cluster is created, so `--repair --nodes N` is a request `--repair`
 * has no way to honor (it fixes up the nodes that exist).
 */
export function resolveNodeCount(opts: ClusterSetupArgs): number {
  if (opts.repair && opts.adoptCni) {
    throw new ClusterSetupError(
      '--adopt-cni cannot be combined with --repair: --repair fixes up a kind cluster '
      + 'yaac built, and --adopt-cni installs into a cluster it did not. Re-run '
      + '--adopt-cni on its own — it is idempotent, and converges the same in-cluster '
      + 'layers --repair does.',
    )
  }
  if (opts.nodes === undefined) return 1
  if (opts.adoptCni) {
    throw new ClusterSetupError(
      '--nodes cannot be combined with --adopt-cni: adopt mode creates no cluster, so '
      + 'there are no nodes for it to render. The adopted cluster brings its own.',
    )
  }
  const count = typeof opts.nodes === 'string' ? Number(opts.nodes) : opts.nodes
  if (!Number.isInteger(count) || count < 1 || count > MAX_KIND_NODES) {
    throw new ClusterSetupError(
      `--nodes must be an integer between 1 and ${MAX_KIND_NODES} (got `
      + `"${String(opts.nodes)}"). Every node is a full node container on this one `
      + 'host; 2–3 is the multi-node rehearsal topology.',
    )
  }
  if (opts.repair) {
    throw new ClusterSetupError(
      '--nodes cannot be combined with --repair: the node count is fixed when '
      + 'the cluster is created, and --repair fixes up the nodes that exist. '
      + `Recreate the cluster instead:\n  yaac cluster setup --nodes ${count}`,
    )
  }
  return count
}

/**
 * The nested-worktree guard both commands share: inside a yaac worktree the
 * cluster is the outer install's infrastructure, so neither creating nor
 * deleting it is this worktree's call.
 */
export function assertNotNested(command: 'setup' | 'delete'): void {
  if (!env.nested) return
  const Err = command === 'setup' ? ClusterSetupError : ClusterDeleteError
  throw new Err(
    `yaac cluster ${command} cannot run inside a nested yaac session — the `
    + 'cluster is external infrastructure managed by the outer yaac.',
  )
}

/**
 * Run the guards a command can answer from its flags alone and return the
 * message to print, or null when nothing objects. Message-valued rather
 * than throwing so the CLI can reject without importing the error classes
 * (or anything else) from the command it is about to skip loading.
 *
 * Guard order matches the command entry points: nested first, then the flag
 * combinations, so an invocation inside a worktree reports the worktree
 * rather than a flag it was never going to reach.
 */
export function clusterArgError(
  command: 'setup' | 'delete',
  opts: ClusterSetupArgs = {},
): string | null {
  try {
    assertNotNested(command)
    if (command === 'setup') resolveNodeCount(opts)
    return null
  } catch (err) {
    if (err instanceof ClusterSetupError || err instanceof ClusterDeleteError) {
      return err.message
    }
    throw err
  }
}
