
/**
 * The `cluster install`/`cluster delete` checks that can be answered from
 * the flags and the environment alone — no cluster, no binaries, no
 * kubeconfig.
 *
 * They live apart from install.ts and delete.ts for import cost, not
 * tidiness. Reaching either of those modules pulls
 * `@kubernetes/client-node` (~2.8s to evaluate; see the note in
 * packages/cli/src/cli.ts), and every one of these answers is already known
 * before a single k8s type is needed. `yaac cluster install --nodes three`
 * should cost the ~0.6s a CLI start costs, not ~3.7s to be told a number
 * was mistyped.
 *
 * So this module imports nothing but `env`, and the CLI calls
 * `clusterArgError` *before* it dynamically imports the command. install.ts
 * and delete.ts still run the same guards themselves — they are the entry
 * points the server and the tests use — so the CLI's early call is a
 * fast path, never the only enforcement.
 */

/** An install step failed in a way the user must resolve; message is the fix. */
export class ClusterInstallError extends Error {}

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

/** The flags these guards read — a structural subset of ClusterInstallOptions. */
export interface ClusterInstallArgs {
  adoptCni?: boolean
  nodes?: number | string
}

/**
 * Validate `--nodes` and return the node count to build. Runs before any
 * binary probe or podman call so a bad value costs nothing.
 *
 * The count only ever applies to a cluster this run CREATES — install never
 * recreates an existing one — which is why an existing cluster ignores the
 * flag with a note rather than failing here: re-running the command with
 * the flags you first typed has to stay the ordinary thing to do.
 */
export function resolveNodeCount(opts: ClusterInstallArgs): number {
  if (opts.nodes === undefined) return 1
  if (opts.adoptCni) {
    throw new ClusterInstallError(
      '--nodes cannot be combined with --adopt-cni: adopt mode creates no cluster, so '
      + 'there are no nodes for it to render. The adopted cluster brings its own.',
    )
  }
  const count = typeof opts.nodes === 'string' ? Number(opts.nodes) : opts.nodes
  if (!Number.isInteger(count) || count < 1 || count > MAX_KIND_NODES) {
    throw new ClusterInstallError(
      `--nodes must be an integer between 1 and ${MAX_KIND_NODES} (got `
      + `"${String(opts.nodes)}"). Every node is a full node container on this one `
      + 'host; 2–3 is the multi-node rehearsal topology.',
    )
  }
  return count
}

/**
 * Run the guards a command can answer from its flags alone and return the
 * message to print, or null when nothing objects. Message-valued rather
 * than throwing so the CLI can reject without importing the error classes
 * (or anything else) from the command it is about to skip loading.
 */
export function clusterArgError(
  command: 'install' | 'delete',
  opts: ClusterInstallArgs = {},
): string | null {
  try {
    if (command === 'install') resolveNodeCount(opts)
    return null
  } catch (err) {
    if (err instanceof ClusterInstallError || err instanceof ClusterDeleteError) {
      return err.message
    }
    throw err
  }
}
