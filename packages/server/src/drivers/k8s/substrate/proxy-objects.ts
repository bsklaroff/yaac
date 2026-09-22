import {
  LABEL_PROXY_OUTPUT,
  PROXY_APP_NAME,
} from './proxy-constants'
import type { GitAuthFailure, RefreshedToolCredentials } from '@yaac/shared/types'
import { claudeOAuthBundleSchema, codexOAuthBundleSchema } from '@yaac/shared/types'

/**
 * The server's read side of the objects the proxy writes: the state
 * ConfigMap (blocked hosts, git-auth failures) and the refreshed-bundles
 * Secret. Both are watched by the `ClusterCache` and mapped here; the
 * decoders are the validation boundary — a malformed entry is dropped,
 * never guessed at, exactly as the file readers they replaced did.
 */

/** Everything the proxy records about what it denied or saw rejected. */
export interface ProxyState {
  /** worktreeId -> blocked hostnames */
  blockedHosts: Record<string, string[]>
  /** projectSlug -> failures */
  gitAuthFailures: Record<string, GitAuthFailure[]>
}

export const EMPTY_PROXY_STATE: ProxyState = { blockedHosts: {}, gitAuthFailures: {} }

/** Label selector for one of the proxy's output objects. */
export function proxyOutputSelector(kind: 'state' | 'refreshed'): string {
  return `app=${PROXY_APP_NAME},${LABEL_PROXY_OUTPUT}=${kind}`
}

interface RawObject {
  metadata?: { name?: string; labels?: Record<string, string> }
  data?: Record<string, string>
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** The state ConfigMap, or null when the object is not one. */
export function mapProxyStateObject(obj: unknown): ProxyState | null {
  const raw = obj as RawObject
  if (raw.metadata?.labels?.[LABEL_PROXY_OUTPUT] !== 'state') return null
  const state: ProxyState = { blockedHosts: {}, gitAuthFailures: {} }
  const blocked = parseJson(raw.data?.['blocked-hosts.json'])
  if (blocked) {
    for (const [sid, hosts] of Object.entries(blocked)) {
      if (!Array.isArray(hosts)) continue
      const valid = hosts.filter((h): h is string => typeof h === 'string')
      if (valid.length > 0) state.blockedHosts[sid] = valid
    }
  }
  const failures = parseJson(raw.data?.['git-auth-failures.json'])
  if (failures) {
    for (const [slug, entries] of Object.entries(failures)) {
      if (!Array.isArray(entries)) continue
      const valid = entries.filter((e): e is GitAuthFailure => {
        if (!e || typeof e !== 'object') return false
        const { host, status, atMs } = e as Record<string, unknown>
        return typeof host === 'string' && typeof status === 'number' && typeof atMs === 'number'
      })
      if (valid.length > 0) state.gitAuthFailures[slug] = valid
    }
  }
  return state
}

function secretJson(raw: RawObject, key: string): Record<string, unknown> | null {
  const encoded = raw.data?.[key]
  if (encoded === undefined) return null
  return parseJson(Buffer.from(encoded, 'base64').toString('utf8'))
}

/** The refreshed-bundles Secret, or null when the object is not it. Each
 *  key is a credentials file in the host store's own shape. */
export function mapProxyRefreshedObject(obj: unknown): RefreshedToolCredentials | null {
  const raw = obj as RawObject
  if (raw.metadata?.labels?.[LABEL_PROXY_OUTPUT] !== 'refreshed') return null
  const out: RefreshedToolCredentials = {}
  const claude = secretJson(raw, 'claude.json')
  if (claude?.kind === 'oauth') {
    const parsed = claudeOAuthBundleSchema.safeParse(claude.claudeAiOauth)
    if (parsed.success) out.claude = parsed.data
  }
  const codex = secretJson(raw, 'codex.json')
  if (codex?.kind === 'oauth') {
    const parsed = codexOAuthBundleSchema.safeParse(codex.codexOauth)
    if (parsed.success) out.codex = parsed.data
  }
  return out
}
