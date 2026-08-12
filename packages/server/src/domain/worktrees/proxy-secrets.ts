import type { YaacConfig } from '@yaac/shared/types'

/**
 * Resolve the values behind a project's `envSecretProxy` names — the
 * secrets the egress proxy injects on the workspace's behalf.
 *
 * WHERE a secret's value comes from is a decision, so it is answered above
 * the runtime and handed down (`SubstrateIntent.proxySecrets`, and the
 * names alone on `WorkspaceRegistration`). Today the answer is the server's
 * own environment; when these move into the database this is the one
 * function that changes, and nothing under `src/runtime` moves at all.
 *
 * A name with nothing behind it is dropped rather than passed through
 * empty: the proxy would inject a blank header, which fails the upstream
 * call in a way that looks like a bad credential rather than a missing one.
 */
export function resolveProxySecrets(config: YaacConfig): Record<string, string> {
  if (!config.envSecretProxy) return {}
  const secrets: Record<string, string> = {}
  for (const name of Object.keys(config.envSecretProxy)) {
    // eslint-disable-next-line no-process-env -- user-configured secret proxy; name comes from project config, not a fixed yaac var
    const value = process.env[name]
    if (value) secrets[name] = value
  }
  return secrets
}
