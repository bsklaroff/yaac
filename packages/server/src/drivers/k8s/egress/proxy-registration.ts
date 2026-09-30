import {
  LABEL_PROJECT,
  LABEL_PROXY_INPUT,
  LABEL_WORKSPACE_ID,
  PROXY_APP_NAME,
  getActiveClusterCache,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#drivers/k8s/substrate'
import { buildRegistrationConfigMapManifest, proxyRegistrationName } from '#drivers/k8s/cluster'
import { NESTED_PULL_HOSTS, resolveAllowedHosts } from '#lib/allowed-hosts'
import { notifyWorkspaceListChanged } from '#notify'
import { serverLog } from '#log'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool, SecretProxyRule, YaacConfig } from '@yaac/shared/types'
import type { PassContext, WorkspaceRegistration } from '#drivers/contract'

/**
 * A workspace's egress registration: the ConfigMap telling the proxy what
 * the workspace may reach and what credentials to inject for it
 * (docs/workspace-egress.md). Written, widened and deleted here; the proxy
 * watches it. Injection rules name secrets by `secretRef`, never by value,
 * so a plain ConfigMap is safe.
 */

export interface Injection {
  action: 'set_header' | 'replace_header' | 'remove_header' | 'replace_body_param'
  name: string
  value?: string
  /**
   * `<projectSlug>/<NAME>`, naming a value in the project's secrets Secret
   * in place of a literal `value`. The proxy resolves it at injection time,
   * so rotations apply to live workspaces immediately. The project prefix
   * stops one project's rule from injecting another project's secret.
   */
  secretRef?: string
  /** Prefix prepended to the resolved secret (e.g. "Bearer "). */
  prefix?: string
}

export interface InjectionRule {
  hostPattern: string
  pathPattern: string
  injections: Injection[]
}

/**
 * Test-only: redirect the post-MITM upstream call for `hostname` to a mock
 * reachable from the proxy pod. Credential injection and TLS termination
 * still run normally; only the final upstream hop is diverted.
 */
export interface UpstreamRedirect {
  host: string
  port: number
  tls?: boolean
}

/**
 * The registration ConfigMap's payload. `tool` and `projectSlug` are
 * required (the proxy drops a registration without them): all
 * agent-credential injection is gated on the registered tool, and
 * git-auth-failure records are keyed by the owning project.
 */
export interface ProxyRegistration {
  rules: InjectionRule[]
  allowedHosts: string[]
  repoUrl?: string
  tool: AgentTool
  projectSlug: string
  upstreamRedirects?: Record<string, UpstreamRedirect>
}

/** The key a rule's `secretRef` names, scoped to its project. */
export function proxySecretRef(projectSlug: string, name: string): string {
  return `${projectSlug}/${name}`
}

/**
 * Build proxy injection rules from a project's proxied secrets, keyed by
 * variable name. The caller passes only secrets that have a value.
 */
export function buildRulesFromSecrets(
  projectSlug: string,
  secretRules: Record<string, SecretProxyRule>,
): InjectionRule[] {
  const rules: InjectionRule[] = []
  for (const [envVar, rule] of Object.entries(secretRules)) {
    const secretRef = proxySecretRef(projectSlug, envVar)
    const pathPattern = rule.path ?? '/*'
    let injections: Injection[]
    if (rule.bodyParam) {
      injections = [{ action: 'replace_body_param', name: rule.bodyParam, secretRef }]
    } else {
      const headerName = rule.header ?? 'authorization'
      const prefix = rule.prefix ?? (rule.header ? '' : 'Bearer ')
      injections = [{
        action: 'set_header',
        name: headerName,
        secretRef,
        ...(prefix ? { prefix } : {}),
      }]
    }
    for (const host of rule.hosts) {
      rules.push({ hostPattern: host, pathPattern, injections })
    }
  }
  return rules
}

/**
 * Test-only: parse `YAAC_E2E_UPSTREAM_REDIRECTS`, a JSON object mapping
 * hostname to `{host, port, tls?}`, so e2e tests can point hosts like
 * `api.anthropic.com` at a mock. Returns undefined when unset, empty or
 * unparseable.
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
 * Assemble a workspace's proxy registration from already-loaded inputs.
 * `secretRules` says which hosts and headers each proxied secret applies
 * to; secret values never pass through here. `env` is read only for the
 * e2e upstream redirects.
 */
export function buildProxyRegistration(input: {
  config: YaacConfig
  remoteUrl: string
  tool: AgentTool
  projectSlug: string
  secretRules: Record<string, SecretProxyRule>
  env?: NodeJS.ProcessEnv
}): ProxyRegistration {
  // eslint-disable-next-line no-process-env -- DI seam: tests pass input.env.
  const env = input.env ?? process.env
  // Copy: resolveAllowedHosts may return the shared default array.
  const allowedHosts = [...resolveAllowedHosts(input.config)]
  // Nested workspaces need the registry pull hosts, unless the user pinned
  // an exact allowlist with setAllowedUrls.
  if (input.config.nestedContainers && !input.config.setAllowedUrls) {
    allowedHosts.push(...NESTED_PULL_HOSTS.filter((h) => !allowedHosts.includes(h)))
  }
  return {
    rules: buildRulesFromSecrets(input.projectSlug, input.secretRules),
    allowedHosts,
    repoUrl: input.remoteUrl,
    tool: input.tool,
    projectSlug: input.projectSlug,
    upstreamRedirects: parseUpstreamRedirectsEnv(env.YAAC_E2E_UPSTREAM_REDIRECTS),
  }
}

/** Write (or rewrite) one workspace's registration object. */
export async function applyProxyRegistration(
  workspaceId: string,
  registration: ProxyRegistration,
): Promise<void> {
  await kubectlApply(
    buildRegistrationConfigMapManifest(workspaceId, registration.projectSlug, registration),
  )
}

/**
 * Write a workspace's full registration from the config, tool and remote
 * the caller resolved, and return it. Idempotent; a claimed prewarmed
 * workspace calls it again under its new tool, since the proxy gates all
 * credential injection on the registered tool.
 */
export async function registerWorkspaceEgress(
  reg: WorkspaceRegistration,
): Promise<ProxyRegistration> {
  const registration = buildProxyRegistration({
    config: reg.config,
    remoteUrl: reg.remoteUrl,
    tool: reg.tool,
    projectSlug: reg.projectSlug,
    secretRules: reg.proxySecretRules,
  })
  await applyProxyRegistration(reg.workspaceId, registration)
  return registration
}

/**
 * Drop a workspace's registration. Failures are logged, not thrown, so they
 * never block a teardown; `reconcileRegistrationGc` collects leftovers.
 */
export async function deregisterWorkspaceEgress(workspaceId: string): Promise<void> {
  try {
    await kubectlWithRetry([
      'delete', 'configmap', proxyRegistrationName(workspaceId),
      '-n', k8sNamespace(), '--ignore-not-found',
    ])
  } catch (err) {
    serverLog(`[server] failed to deregister ${workspaceId} from the egress proxy: ${String(err)}`)
  }
}

interface RegistrationObject {
  metadata: { name: string; labels?: Record<string, string>; creationTimestamp?: string }
  data?: Record<string, string>
}

function registrationSelector(projectSlug?: string): string {
  return [
    `app=${PROXY_APP_NAME}`,
    `${LABEL_PROXY_INPUT}=registration`,
    ...(projectSlug !== undefined ? [`${LABEL_PROJECT}=${projectSlug}`] : []),
  ].join(',')
}

async function listRegistrations(projectSlug?: string): Promise<RegistrationObject[]> {
  const list = await kubectlGetJson<{ items?: RegistrationObject[] }>([
    'get', 'configmap', '-n', k8sNamespace(), '-l', registrationSelector(projectSlug),
  ])
  return list?.items ?? []
}

function decode(obj: RegistrationObject): ProxyRegistration | null {
  const raw = obj.data?.['registration.json']
  if (raw === undefined) return null
  try {
    return JSON.parse(raw) as ProxyRegistration
  } catch {
    return null
  }
}

/** Widen one registration object in place; false when it holds none. */
async function widen(obj: RegistrationObject, host: string): Promise<boolean> {
  const workspaceId = obj.metadata.labels?.[LABEL_WORKSPACE_ID]
  const registration = decode(obj)
  if (!workspaceId || !registration) return false
  if (!registration.allowedHosts.includes(host)) {
    await applyProxyRegistration(workspaceId, {
      ...registration,
      allowedHosts: [...registration.allowedHosts, host],
    })
  }
  return true
}

/**
 * Let a running workspace reach `host` (the webapp's click-to-allow
 * action). The change lives only in the registration. Persisting it is the
 * caller's job: `#domain/workspaces` writes the project config, then asks
 * for `fanOutToProject`, which widens every registered workspace of the
 * project. For a single workspace, a missing registration is an error.
 * The proxy clears its blocked-host record once the widened registration
 * lands.
 */
export async function allowWorkspaceHost(
  target: { workspaceId: string; projectSlug: string },
  host: string,
  opts: { fanOutToProject: boolean },
): Promise<void> {
  if (!opts.fanOutToProject) {
    const obj = await kubectlGetJson<RegistrationObject>([
      'get', 'configmap', proxyRegistrationName(target.workspaceId), '-n', k8sNamespace(),
    ])
    if (!obj || !await widen(obj, host)) {
      throw new ServerError(
        'CONFLICT',
        `session ${target.workspaceId} is not registered with the egress proxy`,
      )
    }
  } else {
    for (const obj of await listRegistrations(target.projectSlug)) await widen(obj, host)
  }
  // Push now rather than wait for the proxy's record update.
  notifyWorkspaceListChanged()
}

/** How long a registration may exist without a workspace before the
 *  sweep deletes it. It is written just before its Job, so one this old
 *  with no workspace is left over from a teardown that never ran. */
const ORPHAN_REGISTRATION_GRACE_MS = 60 * 60_000
const REGISTRATION_GC_INTERVAL_MS = 10 * 60_000
let lastRegistrationGcAt = 0

/** Test-only: forget the throttle. */
export function _resetRegistrationGcForTests(): void {
  lastRegistrationGcAt = 0
}

/**
 * Delete registrations whose workspace is gone, e.g. when the server died
 * between deleting the Job and the ConfigMap. Workspace ids are never
 * reused, so a leaked one is harmless; this just keeps the namespace
 * clean. Throttled, and skipped until the workspace-job cache is healthy
 * so an unseeded cache isn't read as "no workspaces".
 */
export async function reconcileRegistrationGc(ctx: PassContext): Promise<void> {
  if (Date.now() - lastRegistrationGcAt < REGISTRATION_GC_INTERVAL_MS) return
  const cache = getActiveClusterCache()
  if (!cache?.healthy('workspace-jobs')) return
  lastRegistrationGcAt = Date.now()
  const live = new Set((await ctx.snapshot().workspaces()).map((w) => w.workspaceId))
  for (const job of cache.workspaceJobs()) live.add(job.workspaceId)
  const cutoff = Date.now() - ORPHAN_REGISTRATION_GRACE_MS
  for (const obj of await listRegistrations()) {
    const workspaceId = obj.metadata.labels?.[LABEL_WORKSPACE_ID]
    if (!workspaceId || live.has(workspaceId) || ctx.terminating(workspaceId)) continue
    const createdAt = Date.parse(obj.metadata.creationTimestamp ?? '')
    if (!Number.isFinite(createdAt) || createdAt > cutoff) continue
    serverLog(`[server] collecting the orphaned egress registration of ${workspaceId}`)
    await deregisterWorkspaceEgress(workspaceId)
  }
}
