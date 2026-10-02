
/**
 * `cluster install` flag checks that need no cluster, binaries or
 * kubeconfig.
 *
 * Kept apart from install.ts because it loads
 * `@kubernetes/client-node`, which takes seconds (see
 * packages/cli/src/cli.ts). This module has no imports, so the CLI can
 * call `clusterArgError` before loading the command and reject a typo
 * quickly. install.ts runs the same checks itself, so the CLI's call is
 * only a fast path.
 */

/** An install step failed in a way the user must resolve; message is the fix. */
export class ClusterInstallError extends Error {}

/**
 * Max `--nodes`. Every kind node is a full node container on one host, so
 * multiple nodes are for testing multi-node behavior, not for capacity.
 */
const MAX_KIND_NODES = 5

/** The flags these guards read — a structural subset of ClusterInstallOptions. */
export interface ClusterInstallArgs {
  byo?: boolean
  rwxStorageClass?: string
  rwoStorageClass?: string
  tailnet?: boolean
  nodes?: number | string
}

/**
 * Storage-class flags are only valid with `--byo`, and `--byo` requires
 * `--rwx-storage-class` (there is no default NFS-family class).
 */
function checkByoFlags(opts: ClusterInstallArgs): void {
  if (!opts.byo) {
    const stray = [
      opts.rwxStorageClass !== undefined && '--rwx-storage-class',
      opts.rwoStorageClass !== undefined && '--rwo-storage-class',
    ].filter(Boolean)
    if (stray.length > 0) {
      throw new ClusterInstallError(
        `${stray.join(' and ')} ${stray.length > 1 ? 'are' : 'is'} for --byo only: a kind install's `
        + 'claims are static volumes into this machine\'s data dir, provisioned from no class.',
      )
    }
    return
  }
  if (!opts.rwxStorageClass) {
    throw new ClusterInstallError(
      '--byo needs --rwx-storage-class <name>: the NFS-family StorageClass the shared '
      + '`yaac-global` claim is provisioned from (csi-driver-nfs, EFS, or Azure Files over NFS). '
      + 'A cluster\'s default class is a block class, which cannot be shared between nodes.',
    )
  }
}

/**
 * Validate `--nodes` (and the `--byo` flags) and return the node count to
 * build. The count applies only to a cluster this run creates; install
 * never recreates one, so an existing cluster ignores it with a note.
 */
export function resolveNodeCount(opts: ClusterInstallArgs): number {
  checkByoFlags(opts)
  if (opts.nodes === undefined) return 1
  if (opts.byo) {
    throw new ClusterInstallError(
      '--nodes cannot be combined with --byo: a byo install creates no cluster, so '
      + 'there are no nodes for it to render. The cluster brings its own.',
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
 * Run the flag-only install checks and return the error message, or null
 * when the flags are fine.
 */
export function clusterArgError(opts: ClusterInstallArgs): string | null {
  try {
    resolveNodeCount(opts)
    return null
  } catch (err) {
    if (err instanceof ClusterInstallError) return err.message
    throw err
  }
}
