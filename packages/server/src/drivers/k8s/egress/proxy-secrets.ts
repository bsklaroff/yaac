import { proxyClient } from './proxy-client'
import { proxySecretRef } from './secret-refs'
import { proxySecretValues } from './credential-providers'

/**
 * Getting a project's secret VALUES to the proxy, which is the only place
 * they are ever resolved.
 *
 * Delivery, not storage. WHICH secrets a project has and what each is worth
 * are decided above the runtime and arrive already resolved
 * (`SubstrateIntent.proxySecrets`); all that happens here is handing them to
 * the process that injects them.
 *
 * Pushed over the control API and held in the proxy's memory rather than
 * written to a file in the mounted credentials dir. A file would be a
 * plaintext copy of every secret the install proxies, durable on disk, in a
 * directory the pod mounts — which is exactly what storing them encrypted in
 * the database is meant to avoid. The ssh-agent identities already work this
 * way, and the cost is the same one: a replaced proxy pod comes back with
 * none, so the server re-pushes (see `reconcileProxySecrets`).
 */

/**
 * Push a project's secret values. Must complete before the registration that
 * references them — otherwise the proxy drops those injections as
 * unresolvable until they land.
 */
export async function pushProxySecrets(
  projectSlug: string,
  secrets: Record<string, string>,
): Promise<void> {
  if (Object.keys(secrets).length === 0) return
  await proxyClient.putSecrets(Object.fromEntries(
    Object.entries(secrets).map(([name, value]) => [proxySecretRef(projectSlug, name), value]),
  ))
}

/**
 * Bring the proxy's values for one project in line with what the server
 * holds — fired when a user adds, changes or deletes one.
 *
 * Deletes as well as pushes: a secret removed here has to be forgotten
 * there, or a running worktree goes on injecting a credential nobody can see
 * any more. Which refs to forget is read from what the proxy says it holds
 * rather than tracked here, so a restart between two edits strands nothing.
 *
 * THROWS when the proxy cannot be reached. The row is already written either
 * way, so the temptation is to swallow it — but the two directions are not
 * alike. A push that fails leaves a secret that will be injected once the
 * reconcile catches up; a DELETE that fails leaves the proxy injecting a
 * credential the user has just revoked, and telling them it is gone. The
 * caller turns this into a 502-shaped answer that says the row changed and
 * the running worktrees have not caught up yet.
 *
 * A runtime with no proxy attached at all is not a failure: there is nothing
 * live to update, and the next create pushes from scratch.
 */
export async function syncProjectProxySecrets(projectSlug: string): Promise<void> {
  const projects = await proxySecretValues(projectSlug)
  if (projects === undefined) return
  if (!(await proxyClient.attachIfRunning())) return
  const current = projects.find((p) => p.projectSlug === projectSlug)?.secrets ?? {}
  await pushProxySecrets(projectSlug, current)
  const prefix = `${projectSlug}/`
  const held = (await proxyClient.listSecretNames()).filter((ref) => ref.startsWith(prefix))
  for (const ref of held) {
    if (current[ref.slice(prefix.length)] === undefined) {
      await proxyClient.deleteSecret(ref)
    }
  }
}
