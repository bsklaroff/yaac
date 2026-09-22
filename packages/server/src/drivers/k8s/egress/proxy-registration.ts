import {
  LABEL_PROJECT,
  LABEL_PROXY_INPUT,
  LABEL_WORKTREE_ID,
  PROXY_APP_NAME,
  getActiveClusterCache,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#drivers/k8s/substrate'
import { buildRegistrationConfigMapManifest, proxyRegistrationName } from '#drivers/k8s/cluster'
import { NESTED_PULL_HOSTS, resolveAllowedHosts } from '#lib/allowed-hosts'
import { notifyWorktreeListChanged } from '#notify'
import { serverLog } from '#log'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool, SecretProxyRule, YaacConfig } from '@yaac/shared/types'
import type { PassContext, WorkspaceRegistration } from '#drivers/contract'

/**
 * A worktree's egress registration — what the proxy is told a worktree may
 * reach and what to inject on its behalf — as the ConfigMap that carries it
 * (docs/worktree-egress.md "What the proxy is told, and how").
 *
 * The object is written here, patched here (a live allowlist widening) and
 * deleted here; the proxy's informer applies every change within its watch
 * latency, and nothing reads the object back except the widening, which
 * has to append to it. Secret-free by construction: injection rules carry
 * `secretRef`s, never values, which is what lets a registration live in a
 * plain ConfigMap.
 */

export interface Injection {
  action: 'set_header' | 'replace_header' | 'remove_header' | 'replace_body_param'
  name: string
  value?: string
  /**
   * `<projectSlug>/<NAME>`, naming one of the values in the project's
   * secrets Secret, instead of a literal `value`. The proxy resolves it at
   * injection time from the map it holds, which keeps registrations
   * secret-free and means a rotation applies to live worktrees immediately.
   *
   * Scoped by project because the proxy's map is shared: an unscoped name
   * would let one project's rule have another project's secret injected
   * into requests to a host of its choosing.
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
export interface WorktreeRegistration {
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
 * Build proxy injection rules from a project's proxied secrets. Each entry
 * maps a variable name to the rule describing how the secret is injected
 * (as a header or a body parameter). Only secrets with a value behind them
 * are passed in; the caller is the one that can tell, since it holds the
 * rows.
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
 * Pure given (config, remoteUrl, tool, secretRules, env).
 *
 * `secretRules` is the project's proxied secrets — which hosts and headers
 * each name applies to — and only the caller can supply it, since a secret
 * is a row it owns and it is the one that knows which have a value behind
 * them. The values themselves never come through here. `env` is left only
 * for the e2e redirect wiring, which is the driver's own test seam rather
 * than anything about a secret.
 */
export function buildWorktreeRegistration(input: {
  config: YaacConfig
  remoteUrl: string
  tool: AgentTool
  projectSlug: string
  secretRules: Record<string, SecretProxyRule>
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
    rules: buildRulesFromSecrets(input.projectSlug, input.secretRules),
    allowedHosts,
    repoUrl: input.remoteUrl,
    tool: input.tool,
    projectSlug: input.projectSlug,
    upstreamRedirects: parseUpstreamRedirectsEnv(env.YAAC_E2E_UPSTREAM_REDIRECTS),
  }
}

/** Write (or rewrite) one worktree's registration object. */
export async function applyWorktreeRegistration(
  worktreeId: string,
  registration: WorktreeRegistration,
): Promise<void> {
  await kubectlApply(
    buildRegistrationConfigMapManifest(worktreeId, registration.projectSlug, registration),
  )
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
  await applyWorktreeRegistration(
    reg.workspaceId,
    buildWorktreeRegistration({
      config: reg.config,
      remoteUrl: reg.remoteUrl,
      tool: reg.tool,
      projectSlug: reg.projectSlug,
      secretRules: reg.proxySecretRules,
    }),
  )
}

/**
 * Drop a workspace's registration. Failures are swallowed: a datapath
 * hiccup must never hold up a teardown, and a registration with no
 * workspace behind it reaches nothing anyway — the sweep below collects
 * it.
 */
export async function deregisterWorkspaceEgress(worktreeId: string): Promise<void> {
  try {
    await kubectlWithRetry([
      'delete', 'configmap', proxyRegistrationName(worktreeId),
      '-n', k8sNamespace(), '--ignore-not-found',
    ])
  } catch (err) {
    serverLog(`[server] failed to deregister ${worktreeId} from the egress proxy: ${String(err)}`)
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

function decode(obj: RegistrationObject): WorktreeRegistration | null {
  const raw = obj.data?.['registration.json']
  if (raw === undefined) return null
  try {
    return JSON.parse(raw) as WorktreeRegistration
  } catch {
    return null
  }
}

/** Widen one registration object in place; false when it holds none. */
async function widen(obj: RegistrationObject, host: string): Promise<boolean> {
  const worktreeId = obj.metadata.labels?.[LABEL_WORKTREE_ID]
  const registration = decode(obj)
  if (!worktreeId || !registration) return false
  if (!registration.allowedHosts.includes(host)) {
    await applyWorktreeRegistration(worktreeId, {
      ...registration,
      allowedHosts: [...registration.allowedHosts, host],
    })
  }
  return true
}

/**
 * Widen a running workspace's egress to reach `host`, live (the webapp's
 * click-to-allow action).
 *
 * Live is all this is: the host enters the registration for this one
 * workspace and is gone when the workspace is recreated. Making it stick is
 * the mediator's half — it writes the project config first, then asks for the
 * fan-out, which widens every one of the project's registered workspaces so
 * a persisted host takes effect without waiting for each to be recreated.
 *
 * The two shapes differ in how a miss reads. Widening one named workspace,
 * a missing registration is an error the user should see — they clicked on
 * that badge. Across a fan-out there is no miss: the project's registered
 * set IS the set. The proxy prunes its blocked record for the host as the
 * widened registration lands, which clears the badge.
 */
export async function allowWorktreeHost(
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
  // The proxy's own record update follows within its watch latency; pushing
  // here keeps the click instant regardless. The hub diffs, so the overlap
  // costs a rebuild rather than a duplicate push.
  notifyWorktreeListChanged()
}

/** How long a registration may stand without a workspace before the sweep
 *  takes it. A registration is written right before its Job, so anything
 *  this old with no workspace behind it is a teardown that never ran. */
const ORPHAN_REGISTRATION_GRACE_MS = 60 * 60_000
const REGISTRATION_GC_INTERVAL_MS = 10 * 60_000
let lastRegistrationGcAt = 0

/** Test-only: forget the throttle. */
export function _resetRegistrationGcForTests(): void {
  lastRegistrationGcAt = 0
}

/**
 * Collect registrations whose workspace is gone — the leavings of a
 * teardown that never ran (a server that died between deleting the Job and
 * the object). A leaked registration reaches nothing, since worktree ids
 * are never reused; the sweep keeps the namespace from accumulating them.
 * Throttled, and reads the pass's own view of the workspace set.
 */
export async function reconcileRegistrationGc(ctx: PassContext): Promise<void> {
  if (Date.now() - lastRegistrationGcAt < REGISTRATION_GC_INTERVAL_MS) return
  // Only against a trusted view: an empty cache that is merely unseeded
  // must not read as "every worktree is gone".
  const cache = getActiveClusterCache()
  if (!cache?.healthy('worktree-jobs')) return
  lastRegistrationGcAt = Date.now()
  const live = new Set((await ctx.snapshot().workspaces()).map((w) => w.workspaceId))
  for (const job of cache.worktreeJobs()) live.add(job.worktreeId)
  const cutoff = Date.now() - ORPHAN_REGISTRATION_GRACE_MS
  for (const obj of await listRegistrations()) {
    const worktreeId = obj.metadata.labels?.[LABEL_WORKTREE_ID]
    if (!worktreeId || live.has(worktreeId) || ctx.terminating(worktreeId)) continue
    const createdAt = Date.parse(obj.metadata.creationTimestamp ?? '')
    if (!Number.isFinite(createdAt) || createdAt > cutoff) continue
    serverLog(`[server] collecting the orphaned egress registration of ${worktreeId}`)
    await deregisterWorkspaceEgress(worktreeId)
  }
}
