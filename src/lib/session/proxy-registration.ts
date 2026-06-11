import { buildRulesFromConfig, collectProxySecrets } from '@/lib/container/proxy-client'
import type { InjectionRule, UpstreamRedirect } from '@/lib/container/proxy-client'
import { resolveAllowedHosts } from '@/lib/container/default-allowed-hosts'
import { writeProxySecrets } from '@/lib/project/credentials'
import type { AgentTool, YaacConfig } from '@/shared/types'

/**
 * Payload of `PUT /sessions/:id` on the proxy. Registered once by
 * session-create; the proxy write-throughs it to /data and reloads it at
 * boot, so it survives proxy pod replacements (image upgrade, crash,
 * eviction) without daemon involvement. Secret-free by construction —
 * injection rules carry secretRefs, never values.
 */
export interface SessionRegistration {
  rules: InjectionRule[]
  allowedHosts: string[]
  repoUrl?: string
  tool?: AgentTool
  upstreamRedirects?: Record<string, UpstreamRedirect>
}

/**
 * Parse the `YAAC_E2E_UPSTREAM_REDIRECTS` env var into a redirect map for the
 * proxy. Test-only — lets e2e tests rewire `api.anthropic.com` etc. to a
 * mock reachable from the proxy pod without adding user-facing config.
 * Expects a JSON object keyed by hostname with values `{host, port, tls?}`.
 * Returns undefined when the env var is unset, empty, or unparseable.
 */
export function parseUpstreamRedirectsEnv(
  raw: string | undefined,
): Record<string, UpstreamRedirect> | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const result: Record<string, UpstreamRedirect> = {}
  for (const [host, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue
    const v = val as Record<string, unknown>
    if (typeof v.host !== 'string' || typeof v.port !== 'number') continue
    result[host] = {
      host: v.host,
      port: v.port,
      tls: typeof v.tls === 'boolean' ? v.tls : undefined,
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * Assemble a session's proxy registration from already-loaded inputs.
 * Pure given (config, remoteUrl, tool, env).
 */
export function buildSessionRegistration(input: {
  config: YaacConfig
  remoteUrl: string
  tool: AgentTool
  env?: NodeJS.ProcessEnv
}): SessionRegistration {
  const env = input.env ?? process.env
  return {
    rules: input.config.envSecretProxy
      ? buildRulesFromConfig(input.config.envSecretProxy, env)
      : [],
    allowedHosts: resolveAllowedHosts(input.config),
    repoUrl: input.remoteUrl,
    tool: input.tool,
    upstreamRedirects: parseUpstreamRedirectsEnv(env.YAAC_E2E_UPSTREAM_REDIRECTS),
  }
}

/**
 * Write the config's envSecretProxy values into the proxy-secrets
 * credentials file so the proxy can resolve the registration's secretRef
 * rules. Must complete before the matching `registerSession` call —
 * otherwise the proxy would drop the injections as unresolvable until
 * the file lands.
 */
export async function syncProxySecrets(
  config: YaacConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!config.envSecretProxy) return
  await writeProxySecrets(collectProxySecrets(config.envSecretProxy, env))
}

