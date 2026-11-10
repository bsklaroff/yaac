import {
  deleteCustomEndpoint,
  deleteToolCredential,
  getCustomEndpoint,
  getToolCredential,
  insertCustomEndpoint,
  updateCustomEndpoint,
  type CustomEndpointRow,
} from '#db'
import { workspaceDriver } from '#drivers/driver'
import { ServerError } from '@yaac/shared/errors'
import { env } from '@yaac/shared/env'
import { API_KEY_TOOLS, ENDPOINT_EFFORTS, type ApiKeyTool, type EndpointEffort, type EndpointModel } from '@yaac/shared/tool-providers'
import {
  endpointModelSchema,
  type CustomEndpointCreate,
  type CustomEndpointPatch,
  type EndpointDiscoverRequest,
  type EndpointDiscovery,
} from '@yaac/shared/types'
import { refreshToolKeyConfigs } from './tool-key-config'

/**
 * A user's custom endpoints (docs/custom-endpoints.md): self-hosted
 * OpenAI-compatible servers, each with a URL, an optional key and the models
 * it serves, which opencode, pi and omp sign in with as their `custom`
 * provider. Callers push the credential set to the runtime after a write,
 * since a URL or key change moves where the proxy swaps the key in.
 */

/** The owner's endpoint, or NOT_FOUND (another user's reads as missing). */
async function ownEndpoint(owner: string, id: string): Promise<CustomEndpointRow> {
  const row = await getCustomEndpoint(id)
  if (row?.owner !== owner) throw new ServerError('NOT_FOUND', 'No such custom endpoint.')
  return row
}

/** The owner's api-key tools signed in with the endpoint. */
async function attachedTools(owner: string, id: string): Promise<ApiKeyTool[]> {
  const files = await Promise.all(API_KEY_TOOLS.map((tool) => getToolCredential(owner, tool)))
  return API_KEY_TOOLS.filter((_, i) => files[i]?.endpointId === id)
}

/**
 * Refuse a key for a plain-HTTP endpoint where the proxy mediates egress: it
 * never injects a key over HTTP, so the endpoint would only see the
 * placeholder.
 */
function checkKeyTransport(baseUrl: string, apiKey: string): void {
  if (apiKey !== '' && new URL(baseUrl).protocol === 'http:' && workspaceDriver().kind === 'k8s') {
    throw new ServerError(
      'VALIDATION',
      'Cluster workspaces never send a key over plain HTTP, so this endpoint would only see a placeholder. '
        + 'Use an https:// URL, or save it without a key.',
    )
  }
}

/** Store a new endpoint for the owner. */
export async function addEndpoint(owner: string, input: CustomEndpointCreate): Promise<{ id: string }> {
  const apiKey = input.apiKey ?? ''
  checkKeyTransport(input.baseUrl, apiKey)
  const row = await insertCustomEndpoint({ owner, name: input.name, baseUrl: input.baseUrl, apiKey, models: input.models })
  return { id: row.id }
}

/**
 * Change an endpoint. A new host drops the stored key unless the patch
 * gives one, so a mistyped or moved URL is never sent the old server's key.
 * The tools signed in with it get its new model list in every project's
 * tool config at once; agents already running keep the list they started
 * with.
 */
export async function updateEndpoint(owner: string, id: string, patch: CustomEndpointPatch): Promise<void> {
  const current = await ownEndpoint(owner, id)
  const moved = patch.baseUrl !== undefined && new URL(patch.baseUrl).hostname !== new URL(current.baseUrl).hostname
  const apiKey = patch.apiKey ?? (moved ? '' : current.apiKey)
  checkKeyTransport(patch.baseUrl ?? current.baseUrl, apiKey)
  await updateCustomEndpoint(id, { ...patch, apiKey })
  if ((await attachedTools(owner, id)).length > 0) await refreshToolKeyConfigs(owner)
}

/**
 * Delete an endpoint, signing out every tool that used it. Never refused
 * for being in use, so a leaked key can be removed at once. Returns the
 * tools signed out.
 */
export async function removeEndpoint(owner: string, id: string): Promise<ApiKeyTool[]> {
  await ownEndpoint(owner, id)
  const tools = await attachedTools(owner, id)
  for (const tool of tools) await deleteToolCredential(owner, tool)
  await deleteCustomEndpoint(id)
  return tools
}

/** How long an endpoint has to answer `/models`, and how much it may send. */
const DISCOVER_TIMEOUT_MS = 10_000
const DISCOVER_MAX_BYTES = 2 * 1024 * 1024

/**
 * Ask an endpoint which models it serves: `GET <baseUrl>/models`, the
 * OpenAI list shape. Nothing is stored. A stored endpoint is asked with its
 * own URL and key.
 */
export async function discoverEndpointModels(owner: string, request: EndpointDiscoverRequest): Promise<EndpointDiscovery> {
  const { baseUrl, apiKey } = 'endpointId' in request
    ? await ownEndpoint(owner, request.endpointId)
    : { baseUrl: request.baseUrl, apiKey: request.apiKey ?? '' }
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  let body: string
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...(apiKey !== '' ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
    body = await readCapped(res, DISCOVER_MAX_BYTES)
  } catch (err) {
    const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
    throw new ServerError('VALIDATION', `${url} did not list its models: ${reason}${timeoutHint(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new ServerError('VALIDATION', `${url} did not answer with JSON.`)
  }
  return parseModelList(url, parsed)
}

/**
 * Why a fetch timed out, when the in-cluster server made it. Its egress
 * policy drops dials to non-public addresses silently, so an endpoint at
 * one fails only by timing out (docs/server-in-cluster.md "The server's own
 * egress").
 */
function timeoutHint(err: unknown): string {
  if (!env.inCluster || !(err instanceof Error) || err.name !== 'TimeoutError') return ''
  return ' (the in-cluster yaac server reaches only public addresses; open a private endpoint to it, '
    + 'docs/server-in-cluster.md "The server\'s own egress", or list its models by hand with --models-file '
    + 'or the JSON in Settings)'
}

/** A response's body as text, refusing one larger than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      throw new Error(`the answer is larger than ${max / 1024 / 1024} MiB`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The models in an OpenAI-style `{ data: [...] }` list. Embedding and
 * reranking models (llama-swap's capability flags) are left out, as are
 * ids yaac cannot launch. Reasoning levels are read from Codex's catalog
 * fields, on the entry itself or under llama-swap's `meta.llamaswap`.
 */
function parseModelList(url: string, list: unknown): EndpointDiscovery {
  const data = isObject(list) ? list.data : undefined
  if (!Array.isArray(data)) throw new ServerError('VALIDATION', `${url} did not answer with a model list.`)
  const models: EndpointModel[] = []
  const skipped: EndpointDiscovery['skipped'] = []
  for (const entry of data) {
    if (!isObject(entry) || typeof entry.id !== 'string') continue
    const capabilities = isObject(entry.capabilities) ? entry.capabilities : {}
    if (capabilities.embeddings === true || capabilities.reranker === true) {
      skipped.push({ id: entry.id, reason: 'not a chat model' })
      continue
    }
    if (models.some((m) => m.id === entry.id)) continue
    const meta = isObject(entry.meta) && isObject(entry.meta.llamaswap) ? entry.meta.llamaswap : {}
    const efforts = reasoningLevels(entry) ?? reasoningLevels(meta)
    const candidate = {
      id: entry.id,
      ...(typeof entry.name === 'string' && entry.name.trim() !== '' ? { name: entry.name.trim().slice(0, 200) } : {}),
      ...(efforts !== undefined ? { efforts } : {}),
    }
    const checked = endpointModelSchema.safeParse(candidate)
    if (checked.success) models.push(checked.data)
    else skipped.push({ id: entry.id, reason: checked.error.issues[0]?.message ?? 'not a usable model id' })
  }
  return { models, skipped }
}

/**
 * Codex's `supported_reasoning_levels` (`{ effort }` objects, or plain
 * strings) and `default_reasoning_level`, kept to the levels yaac knows.
 * The default falls back to `medium`, else the least level.
 */
function reasoningLevels(source: Json): EndpointModel['efforts'] | undefined {
  const raw = source.supported_reasoning_levels
  if (!Array.isArray(raw)) return undefined
  const named = raw.map((l: unknown) => (isObject(l) ? l.effort : l))
  const levels = ENDPOINT_EFFORTS.filter((l) => named.includes(l))
  if (levels.length === 0) return undefined
  const wanted = source.default_reasoning_level
  const fallback: EndpointEffort = levels.includes('medium') ? 'medium' : levels[0]
  return { levels, default: levels.find((l) => l === wanted) ?? fallback }
}
