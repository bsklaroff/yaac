import fs from 'node:fs'
import { api } from '#commands/api'
import { editJsonInEditor } from '#commands/edit-in-editor'
import {
  applyEndpointDiff,
  describeEndpointModel,
  diffEndpointModels,
  emptyDiff,
  parseEndpointModels,
  type EndpointModelsDiff,
} from '@yaac/shared/endpoint-models'
import type { EndpointModel } from '@yaac/shared/tool-providers'
import type { CustomEndpointSummary } from '@yaac/shared/types'

/**
 * `yaac auth endpoint …`: the caller's custom endpoints
 * (docs/custom-endpoints.md), which `yaac auth update` signs opencode, pi or
 * omp in with.
 */

/** The caller's endpoint of that name, or an error listing theirs. */
async function endpointNamed(name: string): Promise<CustomEndpointSummary> {
  const { customEndpoints } = await api.auth.list.$get()
  const found = customEndpoints.find((e) => e.name === name)
  if (found) return found
  const names = customEndpoints.map((e) => e.name).join(', ')
  throw new Error(`No custom endpoint named "${name}".${names ? ` Yours: ${names}.` : ' Add one with `yaac auth endpoint add`.'}`)
}

/** All of stdin, trimmed. */
function readStdin(): string {
  return fs.readFileSync(0, 'utf8').trim()
}

/** A model list from a file, or stdin for `-`, checked as the server will. */
function readModelsFile(file: string): EndpointModel[] {
  const parsed = parseEndpointModels(JSON.parse(file === '-' ? readStdin() : fs.readFileSync(file, 'utf8')))
  if (!parsed.ok) throw new Error(`${file === '-' ? 'stdin' : file}: ${parsed.errors.join('; ')}`)
  return parsed.value
}

/** Refuse two options that would both read stdin. */
function oneStdinReader(keyStdin: boolean | undefined, modelsFile: string | undefined): void {
  if (keyStdin && modelsFile === '-') throw new Error('--key-stdin and --models-file - cannot both read stdin.')
}

/** Who an endpoint change reaches, as the webapp's banner says it. */
function affects(e: CustomEndpointSummary): string {
  return e.tools.length === 0
    ? 'No tool uses it.'
    : `Updated for ${e.tools.join(', ')}; agents already running keep their list until restarted.`
}

export async function authEndpointAdd(
  name: string,
  url: string,
  opts: { keyStdin?: boolean; modelsFile?: string },
): Promise<void> {
  oneStdinReader(opts.keyStdin, opts.modelsFile)
  const apiKey = opts.keyStdin ? readStdin() : undefined
  let models: EndpointModel[]
  if (opts.modelsFile !== undefined) {
    models = readModelsFile(opts.modelsFile)
  } else {
    const found = await api.auth.endpoints.discover.$post({ json: { baseUrl: url, ...(apiKey ? { apiKey } : {}) } })
    for (const s of found.skipped) console.log(`  skipped ${s.id}: ${s.reason}`)
    if (found.models.length === 0) throw new Error(`${url} listed no usable models. Pass --models-file to list them yourself.`)
    models = found.models
  }
  await api.auth.endpoints.$post({ json: { name, baseUrl: url, ...(apiKey ? { apiKey } : {}), models } })
  console.log(`Custom endpoint "${name}" saved with ${models.length} model(s):`)
  for (const m of models) console.log(`  ${describeEndpointModel(m)}`)
  console.log('Sign a tool in with it: yaac auth update')
}

export async function authEndpointEdit(
  name: string,
  opts: { modelsFile?: string; rename?: string; url?: string; keyStdin?: boolean; clearKey?: boolean },
): Promise<void> {
  oneStdinReader(opts.keyStdin, opts.modelsFile)
  if (opts.keyStdin && opts.clearKey) throw new Error('--key-stdin and --clear-key cannot be combined.')
  const endpoint = await endpointNamed(name)
  const scripted = opts.modelsFile !== undefined || opts.rename !== undefined || opts.url !== undefined
    || opts.keyStdin === true || opts.clearKey === true
  const models = opts.modelsFile !== undefined ? readModelsFile(opts.modelsFile)
    : scripted ? undefined : editModels(endpoint, endpoint.models)
  if (!scripted && models === undefined) {
    console.log('Nothing changed.')
    return
  }
  await api.auth.endpoints[':id'].$patch({
    param: { id: endpoint.id },
    json: {
      ...(opts.rename !== undefined ? { name: opts.rename } : {}),
      ...(opts.url !== undefined ? { baseUrl: opts.url } : {}),
      ...(opts.keyStdin ? { apiKey: readStdin() } : opts.clearKey ? { apiKey: '' } : {}),
      ...(models !== undefined ? { models } : {}),
    },
  })
  console.log(`Custom endpoint "${opts.rename ?? name}" saved. ${affects(endpoint)}`)
  if (opts.url !== undefined && endpoint.keyPreview !== '' && !opts.keyStdin && !opts.clearKey
    && new URL(opts.url).hostname !== new URL(endpoint.baseUrl).hostname) {
    console.log('Its key was removed, since the host changed; set one with --key-stdin.')
  }
}

/** The models list after an editor session opened on `initial`, or
 *  undefined if cancelled: emptied, or saved equal to the stored list. */
function editModels(endpoint: CustomEndpointSummary, initial: EndpointModel[]): EndpointModel[] | undefined {
  return editJsonInEditor(initial, [
    `The models of the custom endpoint "${endpoint.name}" (${endpoint.baseUrl}).`,
    endpoint.tools.length === 0 ? 'No tool uses it yet.' : `Saving updates them for ${endpoint.tools.join(', ')}.`,
    'Each entry: { "id": "<model id>", "name": "<optional label>",',
    '  "efforts": { "levels": ["low", "medium", "high"], "default": "medium" } }',
    'Levels: none minimal low medium high xhigh max. Save unchanged or empty to cancel.',
  ], parseEndpointModels, endpoint.models)
}

export async function authEndpointModels(name: string): Promise<void> {
  console.log(JSON.stringify((await endpointNamed(name)).models, null, 2))
}

const DIFF_PARTS = ['new', 'changed', 'gone'] as const

export async function authEndpointRefresh(name: string, opts: { apply?: string; edit?: boolean }): Promise<void> {
  const parts = opts.apply === undefined ? undefined
    : opts.apply === 'all' ? [...DIFF_PARTS] : opts.apply.split(',').map((p) => p.trim())
  const unknown = parts?.filter((p) => !(DIFF_PARTS as readonly string[]).includes(p)) ?? []
  if (unknown.length > 0) throw new Error(`--apply takes all, or a list of ${DIFF_PARTS.join(', ')}; not ${unknown.join(', ')}.`)
  const endpoint = await endpointNamed(name)
  const found = await api.auth.endpoints.discover.$post({ json: { endpointId: endpoint.id } })
  const diff = diffEndpointModels(endpoint.models, found.models)
  printDiff(diff)
  if (emptyDiff(diff)) {
    console.log('The endpoint\'s list matches yours.')
    if (!opts.edit) return
  }
  const picked = new Set(parts ?? (opts.edit ? ['new', 'changed'] : []))
  const ids = (on: boolean, models: EndpointModel[]): Set<string> => new Set(on ? models.map((m) => m.id) : [])
  const merged = applyEndpointDiff(endpoint.models, diff, {
    added: ids(picked.has('new'), diff.added),
    changed: ids(picked.has('changed'), diff.changed.map((c) => c.after)),
    removed: ids(picked.has('gone'), diff.removed),
  })
  const models = opts.edit ? editModels(endpoint, merged) : parts !== undefined ? merged : undefined
  if (models === undefined) {
    if (!opts.edit) console.log('Apply with --apply all, or --apply new,changed,gone (any of them).')
    else console.log('Nothing changed.')
    return
  }
  await api.auth.endpoints[':id'].$patch({ param: { id: endpoint.id }, json: { models } })
  console.log(`Custom endpoint "${name}" saved with ${models.length} model(s). ${affects(endpoint)}`)
}

function printDiff(diff: EndpointModelsDiff): void {
  for (const m of diff.added) console.log(`  new      ${describeEndpointModel(m)}`)
  for (const { before, after } of diff.changed) {
    console.log(`  changed  ${describeEndpointModel(before)} -> ${describeEndpointModel(after)}`)
  }
  for (const m of diff.removed) console.log(`  gone     ${describeEndpointModel(m)}`)
}

export async function authEndpointRemove(name: string): Promise<void> {
  const endpoint = await endpointNamed(name)
  await api.auth.endpoints[':id'].$delete({ param: { id: endpoint.id } })
  console.log(`Custom endpoint "${name}" deleted.${endpoint.tools.length > 0 ? ` Signed out: ${endpoint.tools.join(', ')}.` : ''}`)
}
