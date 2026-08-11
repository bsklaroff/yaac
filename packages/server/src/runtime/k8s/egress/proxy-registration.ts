import { buildRulesFromConfig, collectProxySecrets, proxyClient } from './proxy-client'
import type { InjectionRule, UpstreamRedirect } from './proxy-client'
import { NESTED_PULL_HOSTS, resolveAllowedHosts } from './default-allowed-hosts'
import { writeProxySecrets } from '#store/projects'
import type { AgentTool, YaacConfig } from '@yaac/shared/types'
import type { WorkspaceRegistration } from '#runtime/contract'

/**
 * Payload of `PUT /worktrees/:id` on the proxy. Registered by worktree-create
 * (and re-registered when a prewarmed spare is retooled at claim time); the
 * proxy write-throughs it to /data and reloads it at boot, so it survives
 * proxy pod replacements (image upgrade, crash, eviction) without server
 * involvement. Secret-free by construction — injection rules carry
 * secretRefs, never values.
 *
 * `tool` and `projectSlug` are required (the proxy rejects a registration
 * without them): all agent-credential injection is gated on the registered
 * tool, and git-auth-failure records are keyed by the owning project.
 */
export interface WorktreeRegistration {
  rules: InjectionRule[]
  allowedHosts: string[]
  repoUrl?: string
  tool: AgentTool
  /** Owning project — the proxy keys its git-auth-failure records by it. */
  projectSlug: string
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
 * Assemble a worktree's proxy registration from already-loaded inputs.
 * Pure given (config, remoteUrl, tool, env).
 */
export function buildWorktreeRegistration(input: {
  config: YaacConfig
  remoteUrl: string
  tool: AgentTool
  projectSlug: string
  env?: NodeJS.ProcessEnv
}): WorktreeRegistration {
  // eslint-disable-next-line no-process-env -- DI seam: tests pass input.env.
  const env = input.env ?? process.env
  // Copy: resolveAllowedHosts may return the shared DEFAULT_ALLOWED_HOSTS
  // array itself, which must never be mutated.
  const allowedHosts = [...resolveAllowedHosts(input.config)]
  // Auto-append the registry pull hosts for nested worktrees — unless the
  // user pinned an exact allowlist with setAllowedUrls, which is a full
  // override the user owns completely (addAllowedUrls and the default list
  // still get them).
  if (input.config.nestedContainers && !input.config.setAllowedUrls) {
    allowedHosts.push(...NESTED_PULL_HOSTS.filter((h) => !allowedHosts.includes(h)))
  }
  return {
    rules: input.config.envSecretProxy
      ? buildRulesFromConfig(input.config.envSecretProxy, env)
      : [],
    allowedHosts,
    repoUrl: input.remoteUrl,
    tool: input.tool,
    projectSlug: input.projectSlug,
    upstreamRedirects: parseUpstreamRedirectsEnv(env.YAAC_E2E_UPSTREAM_REDIRECTS),
  }
}

/**
 * Write the config's envSecretProxy values into the proxy-secrets
 * credentials file so the proxy can resolve the registration's secretRef
 * rules. Must complete before the matching `registerWorktree` call —
 * otherwise the proxy would drop the injections as unresolvable until
 * the file lands.
 */
export async function syncProxySecrets(
  config: YaacConfig,
  // eslint-disable-next-line no-process-env -- DI seam: tests pass a fake env.
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!config.envSecretProxy) return
  await writeProxySecrets(collectProxySecrets(config.envSecretProxy, env))
}

/**
 * Tell the egress path what a workspace may reach — the whole of it, in one
 * call, from decisions the caller already resolved.
 *
 * The seam a mediator registers through: it supplies WHICH config, tool and
 * remote apply (rows and disk answer those); everything about how they
 * become an allowlist and a set of injection rules is assembled here.
 *
 * Idempotent, and re-called rather than patched — a spare retooled at claim
 * time registers again under its new tool, because the proxy gates all
 * credential injection on the registered one.
 */
export async function registerWorkspace(reg: WorkspaceRegistration): Promise<void> {
  await proxyClient.registerWorktree(
    reg.workspaceId,
    buildWorktreeRegistration({
      config: reg.config,
      remoteUrl: reg.remoteUrl,
      tool: reg.tool,
      projectSlug: reg.projectSlug,
    }),
  )
}

