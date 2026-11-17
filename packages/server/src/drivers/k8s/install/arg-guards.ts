
/**
 * `cluster install` flag checks that need no cluster, binaries or
 * kubeconfig. The CLI runs them before it moves any data dir, so a typo
 * changes nothing; install.ts runs them again itself.
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
  /** `--tailnet`, or `--tailnet <host>` for this machine's `tailscale serve`. */
  tailnet?: boolean | string
  /** `--admin`: the logins that are to be the install's admins. */
  admin?: readonly string[]
  /** `--yes`: revoke admin from the logins `--admin` leaves out without asking. */
  yes?: boolean
  nodes?: number | string
  /** `--site-domain`: the zone whose names are tailnet sites'. */
  siteDomain?: string
  /** `--server-name`: the server's own name under the site domain;
   *  `--no-server-name` (false) drops a recorded one. */
  serverName?: string | false
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
 * The MagicDNS name `--tailnet <host>` gives, lowercased, or undefined for
 * a bare `--tailnet` or none. Only a kind install has the loopback port
 * `tailscale serve` forwards to, so `--byo` refuses a host.
 */
export function tailnetServeHost(opts: ClusterInstallArgs): string | undefined {
  if (typeof opts.tailnet !== 'string') return undefined
  if (opts.byo) {
    throw new ClusterInstallError(
      '--tailnet <host> publishes a kind install through this machine\'s own `tailscale serve`; '
      + 'a --byo install is published through the Tailscale operator, so give --tailnet no host.',
    )
  }
  const host = opts.tailnet.trim().toLowerCase()
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
    throw new ClusterInstallError(
      '--tailnet takes the bare MagicDNS name tailscale serve fronts this machine at, '
      + `e.g. srv.<tailnet>.ts.net (got "${opts.tailnet}").`,
    )
  }
  return host
}

/**
 * The site domain `--site-domain` gives, lowercased, or undefined for none
 * (docs/public-sites.md "Tailnet sites"). Its sites stamp each request
 * with the caller's tailnet login, so it needs a tailnet install.
 */
export function siteDomainArg(opts: ClusterInstallArgs): string | undefined {
  if (opts.siteDomain === undefined) return undefined
  const domain = opts.siteDomain.trim().toLowerCase()
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(domain)) {
    throw new ClusterInstallError(`--site-domain takes a DNS zone you own, e.g. apps.example.com (got "${opts.siteDomain}").`)
  }
  if (!opts.tailnet && !opts.byo) {
    throw new ClusterInstallError(
      '--site-domain gives sites seen only on the tailnet, with each caller\'s tailnet login, so it '
      + 'needs --tailnet: a local install has no logins to give them.',
    )
  }
  return domain
}

/**
 * The server name `--server-name` gives, lowercased; null for
 * `--no-server-name`, which drops a recorded one; undefined for neither
 * (docs/remote-hosting.md "A name of your own"). The tailnet tunnel serves
 * it, stamping each caller's login, so it needs a tailnet install, and it
 * must be one label under the site domain, which is what the tunnel's
 * wildcard certificate covers. A site domain this run does not name is
 * checked against the recorded one by install.
 */
export function serverNameArg(opts: ClusterInstallArgs): string | null | undefined {
  if (opts.serverName === undefined) return undefined
  if (!opts.tailnet && !opts.byo) {
    throw new ClusterInstallError(
      '--server-name publishes the server to tailnet users under the site domain, so it (and '
      + '--no-server-name) needs --tailnet: a local install is reached only at loopback.',
    )
  }
  if (opts.serverName === false) return null
  const name = opts.serverName.trim().toLowerCase()
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(name)) {
    throw new ClusterInstallError(`--server-name takes a hostname, e.g. yaac.apps.example.com (got "${opts.serverName}").`)
  }
  const domain = siteDomainArg(opts)
  if (domain !== undefined) checkServerName(name, domain)
  return name
}

/** Refuse a server name that is not one label under the site domain. */
export function checkServerName(name: string, siteDomain: string): void {
  if (!name.endsWith(`.${siteDomain}`) || name.slice(0, -siteDomain.length - 1).includes('.')) {
    throw new ClusterInstallError(
      `--server-name must be one label under the site domain ${siteDomain}, like yaac.${siteDomain}: `
      + 'the tailnet tunnel serves it with the domain\'s wildcard certificate (got "' + name + '").',
    )
  }
}

/**
 * Validate `--nodes` (and the `--byo`, `--tailnet`, `--admin`, `--site-domain` and `--server-name` flags)
 * and return the node count to build. The count applies only to a cluster this
 * run creates; install never recreates one, so an existing cluster ignores
 * it with a note.
 */
export function resolveNodeCount(opts: ClusterInstallArgs): number {
  checkByoFlags(opts)
  tailnetServeHost(opts)
  siteDomainArg(opts)
  serverNameArg(opts)
  if (opts.admin?.length && !opts.tailnet && !opts.byo) {
    throw new ClusterInstallError(
      '--admin names tailnet logins, so it needs --tailnet: a local install\'s one user is '
      + 'its admin already (docs/multi-user.md "Roles").',
    )
  }
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

/** The macOS install of everything `yaac cluster install` runs: podman, krunkit, kind and kubectl. */
export const YAAC_CLUSTER_INSTALL = '  brew install bsklaroff/yaac/yaac-cluster'
