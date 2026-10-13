/**
 * `yaac cluster check|install|delete|start|stop|restart|logs`: administer
 * the kubernetes cluster an install runs workspaces on, and its server
 * Deployment (docs/server-in-cluster.md). This module loads the kubernetes
 * client, which takes seconds, so cli.ts imports it only for these
 * commands. `yaac cluster status` reads only the lock, so it lives in
 * server-lifecycle.ts.
 */
import { formatCheckResult } from '@yaac/shared/checks'
import { clusterDataDir, readInstallRecord, recordedDriver } from '@yaac/shared/install-record'
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- names the data dir in refusals; builds no path
import { clientDataDir, getDataDir, useInstallDataDir } from '@yaac/shared/paths'
import { isLoopbackOrigin, resolveServerTarget } from '@yaac/shared/server-api'
import { registerServer } from '@yaac/shared/server-config'
import { moveLegacyClusterDataDir, moveLegacyHostDataDir } from '@yaac/shared/legacy-data-dir'
import {
  bindInstall,
  clusterArgError,
  clusterServerLogs,
  foreignClusterRefusal,
  kindClusterExists,
  restartClusterServer,
  runClusterCheck,
  runClusterDelete,
  runClusterInstall,
  serverDeploymentExists,
  startClusterServer,
  stopClusterServer,
  type ClusterInstallArgs,
} from '@yaac/server/drivers/k8s/install'
import { tailServerLog, type ServerLogsOptions } from '#commands/server-lifecycle'

/**
 * `yaac cluster check`: verify the k8s driver's prerequisites (kubectl,
 * cluster, registry, namespace, hostPath/registry wiring) and print a fix
 * for anything broken. Exits 1 on hard failures.
 */
export async function clusterCheck(): Promise<void> {
  await refuseClusterOnContainerless()
  await bindRecordedInstall()
  // Refuse a kubeconfig context other than the cluster this install was
  // recorded in, or every call would go there (see cluster-identity.ts).
  // `install` checks for itself, after a kind install has had the chance
  // to create its cluster.
  await refuseForeignCluster()
  const { ok, results } = await runClusterCheck()
  for (const r of results) console.log(formatCheckResult(r))
  if (!ok) throw new Error('\nCluster is not ready for yaac workspaces. Fix the failures above and re-run.')
  console.log('\nCluster is ready for yaac workspaces.')
}

/**
 * `yaac cluster install`: converge the machine and cluster, then verify with
 * a cluster check. A step that cannot proceed throws (ClusterInstallError
 * carries the fix); a failed check exits 1. The install binds its own
 * install id.
 */
export async function clusterInstall(options: ClusterInstallArgs): Promise<void> {
  await refuseClusterOnContainerless()
  // runClusterInstall checks the flags too; checking first means a typo
  // moves no data dir.
  const argError = clusterArgError(options)
  if (argError !== null) throw new Error(argError)
  if (!options.byo && await moveLegacyClusterDataDir((name) => kindClusterExists(name))) {
    useInstallDataDir(await clusterDataDir())
  }
  await moveLegacyHostDataDir()
  await runClusterInstall(options)

  console.log('\nVerifying with cluster check...')
  const { ok, results } = await runClusterCheck()
  for (const r of results) console.log(formatCheckResult(r))
  if (ok) {
    console.log('\nCluster is ready for yaac sessions.')
    return
  }
  process.exitCode = 1
  console.log('\nCluster is not ready — fix the failures above and re-run `yaac cluster install`.')
  // The layers are already applied, so the cluster looks usable. A failed
  // `egress` gate means NetworkPolicy is not enforced: workspaces still
  // work, but the proxy allowlist covers only redirected ports. Warn
  // loudly, since nothing else would show it.
  if (results.some((r) => r.name === 'egress' && r.status === 'fail')) {
    console.log(
      '\nThe egress gate FAILED, and the install is already in place. Do not start '
      + 'sessions until a re-run passes: this cluster is not enforcing the session '
      + 'NetworkPolicy, so their egress lockdown is advisory and the proxy allowlist '
      + 'covers only the ports the redirect steers.',
    )
  }
}

/**
 * `yaac cluster delete`. No foreign-cluster guard: kind deletes its
 * cluster by name, not via the current context, and byo refuses delete
 * outright.
 */
export async function clusterDelete(options: { yes?: boolean }): Promise<void> {
  await refuseClusterOnContainerless()
  await bindRecordedInstall()
  await runClusterDelete(options)
}

/**
 * Run `yaac cluster start|stop|restart|logs` against this install's server
 * Deployment. A kind install's log is a file in its data dir; a byo
 * install's is on a volume this machine cannot see, so it is read through
 * the cluster. A start selects the server, as a host `yaac server start`
 * does; a restart leaves a selection of another server alone.
 */
export async function clusterServerVerb(
  verb: 'start' | 'stop' | 'restart' | 'logs',
  opts: ServerLogsOptions = {},
): Promise<void> {
  const record = await readInstallRecord()
  if (record?.driver !== 'k8s') {
    throw new Error(`There is no cluster install at ${getDataDir()}. Create one with \`yaac cluster install\`.`)
  }
  if (verb === 'logs' && !record.byo) {
    await tailServerLog(opts)
    return
  }
  await bindRecordedInstall()
  // Checked first, or another cluster would answer "no Deployment".
  await refuseForeignCluster()
  if (!await serverDeploymentExists()) {
    throw new Error('This install has no server Deployment yet. Deploy it with `yaac cluster install`.')
  }
  if (verb === 'logs') {
    await clusterServerLogs(opts)
    return
  }
  if (verb === 'stop') {
    await stopClusterServer()
    console.error('[yaac] server stopped (Deployment scaled to 0)')
    return
  }
  const origin = verb === 'start' ? await startClusterServer() : await restartClusterServer()
  await registerServer(origin, 'k8s', { keepSelection: verb === 'restart' })
  console.error(`[yaac] server ${verb === 'start' ? 'started' : 'restarted'} at ${origin}`)
}

/** Act for the install this data dir records. */
async function bindRecordedInstall(): Promise<void> {
  const record = await readInstallRecord()
  if (record?.installId) {
    bindInstall(record.installId, { hash: record.legacyDataDirHash, names: record.legacyNames })
  }
}

async function refuseForeignCluster(): Promise<void> {
  const refusal = await foreignClusterRefusal()
  if (refusal !== null) throw new Error(refusal)
}

/**
 * Refuse a `yaac cluster …` command on a containerless install. The recorded
 * driver decides: it is this install's, whatever server is selected, and a
 * loopback origin can still be a tunnel to another machine. Only with
 * nothing recorded on a data dir clients share (a bare `yaac server run`
 * registers nothing) is a local running server asked.
 */
async function refuseClusterOnContainerless(): Promise<void> {
  const recorded = await recordedDriver()
  const running = recorded === undefined && getDataDir() === clientDataDir()
    ? await runningServerDriver()
    : undefined
  if ((recorded ?? running) !== 'containerless') return
  const where = running !== undefined
    ? 'The running server uses the containerless driver'
    : 'This install runs the containerless driver'
  throw new Error(
    `${where}: workspaces run on this host and there is no cluster to manage.`
    + '\n    Run `yaac host check` to verify this machine instead.',
  )
}

/**
 * Which substrate this machine's running server uses, from its auth-exempt
 * `/health`, or undefined when none answers. The origin comes from
 * `server.json` like every other command, not from the lock's port, which
 * for an in-cluster server is the port inside its pod. A selected server at
 * a non-loopback origin is another machine's, so it is not asked.
 */
async function runningServerDriver(): Promise<string | undefined> {
  try {
    const target = await resolveServerTarget()
    if (!isLoopbackOrigin(target.baseUrl)) return undefined
    const res = await fetch(`${target.baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) })
    if (!res.ok) return undefined
    const body = await res.json() as { driver?: string | null }
    return body.driver ?? undefined
  } catch {
    return undefined
  }
}
