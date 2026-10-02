/**
 * Code-generate the api-key provider tables for the api-key-only agent tools
 * (`opencode` and `pi`) by reading each tool's own provider registry, so yaac
 * can offer every provider they support without hand-maintaining a list.
 *
 * Run with:  pnpm gen:providers
 *
 * Writes packages/shared/src/tool-providers.generated.ts: the provider rows,
 * pi's default models, and the model catalogs. The egress proxy needs only
 * a credential's provider host, which the server sends it with the key.
 *
 * Sources:
 *   - opencode: models.dev (https://models.dev/api.json), the provider/model
 *     database opencode itself uses.
 *   - pi: the installed @earendil-works/pi-ai package — its builtinProviders()
 *     (id/label/baseUrl), findEnvKeys() (env var per provider), and
 *     pi-coding-agent's defaultModelPerProvider map, read by importing pi's
 *     compiled modules.
 *
 * Only api-key providers with a single fixed https host are emitted.
 * Providers needing region/resource/OAuth config (azure, bedrock, vertex,
 * per-account gateways) can't be pinned to one host for the proxy's key
 * swap, so they are skipped and logged. OAuth-only providers are skipped too.
 *
 * Needs network access to models.dev and a global `pi` install
 * (`@earendil-works/pi-coding-agent`). Run it when bumping either tool; it
 * is not part of `pnpm build`.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')

/** One provider row in the generated file. */
interface ProviderRow {
  id: string
  label: string
  envVar: string
  apiHost: string
  /** pi only: `pi --model <provider>/<id>` default. */
  defaultModel?: string
}

// ── opencode: models.dev ────────────────────────────────────────────────

/**
 * Default hosts for dedicated-SDK providers that models.dev lists without a
 * provider-level `api` (the AI SDK hardcodes their base URL). Keyed by the
 * provider's `npm` package. The only hand-maintained data here.
 */
const OPENCODE_HOST_BY_NPM: Record<string, string> = {
  '@ai-sdk/anthropic': 'api.anthropic.com',
  '@ai-sdk/openai': 'api.openai.com',
  '@ai-sdk/google': 'generativelanguage.googleapis.com',
  '@ai-sdk/xai': 'api.x.ai',
  '@ai-sdk/mistral': 'api.mistral.ai',
  '@ai-sdk/groq': 'api.groq.com',
  '@ai-sdk/cerebras': 'api.cerebras.ai',
  '@ai-sdk/perplexity': 'api.perplexity.ai',
  '@ai-sdk/cohere': 'api.cohere.com',
  '@ai-sdk/togetherai': 'api.together.xyz',
  '@ai-sdk/deepinfra': 'api.deepinfra.com',
  '@ai-sdk/vercel': 'ai-gateway.vercel.sh',
}

/**
 * Providers that need per-account/region/OAuth config beyond a bare api key
 * and so can't be pinned to a single host for the proxy swap. Excluded even
 * when models.dev gives them an `api` host.
 */
const OPENCODE_EXCLUDE = new Set([
  'amazon-bedrock',
  'azure',
  'azure-cognitive-services',
  'google-vertex',
  'google-vertex-anthropic',
  'sap-ai-core',
  'gitlab',
  'cloudflare-ai-gateway',
])

interface ModelsDevModel {
  name?: string
  tool_call?: boolean
  release_date?: string
}

/** Per-provider model ids (in picker order) and their display names. */
interface ModelsCatalog {
  ids: Record<string, string[]>
  names: Record<string, Record<string, string>>
}

interface ModelsDevProvider {
  id: string
  name?: string
  env?: string[]
  npm?: string
  api?: string
  models?: Record<string, unknown>
}

async function fetchModelsDev(): Promise<Record<string, ModelsDevProvider>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch('https://models.dev/api.json', { signal: ctrl.signal })
    if (!res.ok) throw new Error(`models.dev returned ${res.status}`)
    return await res.json() as Record<string, ModelsDevProvider>
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pick the api-key env var for a provider, preferring an `*_API_KEY`-shaped
 * candidate over a bearer-token one.
 *
 * The chosen var gets the placeholder key in a workspace pod that carries
 * every credentialed tool's placeholders at once. Bearer-token vars can
 * shadow another tool's login: Claude Code ranks ANTHROPIC_AUTH_TOKEN above
 * its OAuth credential, so seeding it for pi's anthropic credential would
 * break a claude login in the same pod. The tool reads whichever var is set,
 * so preferring the api-key var costs nothing. Falls back to the first
 * non-OAuth candidate when no `_API_KEY` var exists.
 */
function pickEnvVar(env: string[]): string | undefined {
  const apiKeyOnly = env.filter((v) => !/OAUTH/i.test(v))
  return apiKeyOnly.find((v) => /_API_KEY$/i.test(v)) ?? apiKeyOnly[0] ?? env[0]
}

/**
 * Bare hostname from a base-URL string, or null if unparseable or not a fixed
 * base URL.
 *
 * Any templated part rejects the URL, including one in the path
 * (cloudflare-workers-ai puts `${CLOUDFLARE_ACCOUNT_ID}` there): such a
 * provider needs per-account config beyond a bare key. Loopback hosts are
 * rejected too: they name a server on the user's machine, which a workspace
 * pod cannot reach and the egress proxy never sees.
 */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost'
    || host === '0.0.0.0'
    || host.endsWith('.localhost')
    || /^127\.\d+\.\d+\.\d+$/.test(host)
}

function hostFromUrl(url: string): string | null {
  if (url.includes('${')) return null
  try {
    const host = new URL(url).hostname
    if (!/^[a-z0-9.-]+$/i.test(host)) return null
    return isLoopbackHost(host) ? null : host
  } catch {
    return null
  }
}

/**
 * @param catalog tool-calling model ids per provider (from buildModelsCatalog).
 *   A provider absent from it has no model an agent can drive, so it is
 *   dropped. Some have a usable sibling under the same key and host
 *   (models.dev splits perplexity into perplexity / perplexity-agent).
 */
function buildOpencodeRows(
  db: Record<string, ModelsDevProvider>,
  catalog: Record<string, string[]>,
): ProviderRow[] {
  const rows: ProviderRow[] = []
  const skipped: string[] = []
  for (const [id, p] of Object.entries(db)) {
    if (OPENCODE_EXCLUDE.has(id)) { skipped.push(`${id} (multi-config)`); continue }
    const env = Array.isArray(p.env) ? p.env : []
    const envVar = pickEnvVar(env)
    if (!envVar) { skipped.push(`${id} (no env var)`); continue }
    const host = (p.api && hostFromUrl(p.api)) || (p.npm ? OPENCODE_HOST_BY_NPM[p.npm] : undefined)
    if (!host) { skipped.push(`${id} (no stable host)`); continue }
    if (!catalog[id]?.length) { skipped.push(`${id} (no tool-calling models)`); continue }
    rows.push({ id, label: p.name ?? id, envVar, apiHost: host })
  }
  console.log(`  opencode: ${rows.length} providers, ${skipped.length} skipped`)
  if (skipped.length) console.log(`    skipped: ${skipped.join(', ')}`)
  return sortRows(rows)
}

/**
 * Each models.dev provider's tool-calling model ids, keyed by provider id,
 * so `yaac-mama models` can report `--model` values without a fetch.
 * Agents drive models through tool calls, so embedding/image/tts models are
 * left out. pi uses its own registry (PI_MODELS_BY_PROVIDER) instead.
 */
function buildModelsCatalog(db: Record<string, ModelsDevProvider>): ModelsCatalog {
  const catalog: ModelsCatalog = { ids: {}, names: {} }
  let modelCount = 0
  for (const [id, p] of Object.entries(db)) {
    const models = (p.models && typeof p.models === 'object' ? p.models : {}) as Record<string, ModelsDevModel>
    const toolCalling = Object.entries(models).filter(([, m]) => m.tool_call === true)
    const present = new Set(toolCalling.map(([mid]) => mid))
    // Newest first, so a picker (and the opencode fallback, which takes the
    // head of the list) leads with current models. A dated snapshot whose
    // alias is also listed is the same model twice, so only the alias stays.
    const ids = toolCalling
      .filter(([mid]) => !isDatedSnapshotOf(mid, present))
      .sort(([aId, a], [bId, b]) =>
        (b.release_date ?? '').localeCompare(a.release_date ?? '') || aId.localeCompare(bId))
      .map(([mid]) => mid)
    if (ids.length) {
      catalog.ids[id] = ids
      catalog.names[id] = Object.fromEntries(ids.flatMap((mid) => {
        const name = displayName(models[mid]?.name)
        return name !== undefined ? [[mid, name]] : []
      }))
      modelCount += ids.length
    }
  }
  console.log(`  models (models.dev, tool-calling): ${modelCount} ids across ${Object.keys(catalog.ids).length} providers`)
  return catalog
}

/** A registry's name for a model, as a picker shows it: models.dev marks an
 *  alias "(latest)", which says nothing once the dated snapshot beside it is
 *  dropped. */
function displayName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  const trimmed = name.replace(/ \(latest\)/, '').trim()
  return trimmed !== '' ? trimmed : undefined
}

/** `claude-haiku-4-5-20251001` when `claude-haiku-4-5` is also listed. */
function isDatedSnapshotOf(id: string, present: Set<string>): boolean {
  const alias = /^(.+)-\d{8}$/.exec(id)?.[1]
  return alias !== undefined && present.has(alias)
}

// ── pi: installed @earendil-works/pi-ai ─────────────────────────────────

interface PiProviderObj {
  id: string
  name?: string
  baseUrl?: string
  auth?: { apiKey?: unknown; oauth?: unknown }
}

function piPackageRoot(): string {
  const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
  const root = path.join(npmRoot, '@earendil-works', 'pi-coding-agent')
  if (!fs.existsSync(root)) {
    throw new Error(
      `pi is not installed globally (looked in ${root}). Install it with ` +
      '`npm i -g @earendil-works/pi-coding-agent` before regenerating.',
    )
  }
  return root
}

async function importPi(file: string): Promise<Record<string, unknown>> {
  // pi's modules live in a global install found by absolute path at
  // codegen time, so they can't be imported statically.
  // eslint-disable-next-line no-restricted-syntax
  return import(pathToFileURL(file).href) as Promise<Record<string, unknown>>
}

async function buildPiRows(): Promise<ProviderRow[]> {
  const root = piPackageRoot()
  const piAi = path.join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist')
  const all = await importPi(path.join(piAi, 'providers', 'all.js'))
  const envMod = await importPi(path.join(piAi, 'env-api-keys.js'))
  const resolver = await importPi(path.join(root, 'dist', 'core', 'model-resolver.js'))

  const builtinProviders = all.builtinProviders as () => PiProviderObj[]
  const findEnvKeys = envMod.findEnvKeys as (id: string, env: unknown) => string[] | undefined
  const defaultModelPerProvider = resolver.defaultModelPerProvider as Record<string, string>

  // findEnvKeys returns only the vars set in the env it is given; a Proxy
  // reporting every key as set makes it return all candidates.
  const allSet = new Proxy({}, { get: () => 'x', has: () => true })

  const rows: ProviderRow[] = []
  const skipped: string[] = []
  for (const p of builtinProviders()) {
    if (!p.auth?.apiKey) { skipped.push(`${p.id} (oauth-only)`); continue }
    if (!p.baseUrl) { skipped.push(`${p.id} (no baseUrl)`); continue }
    const host = hostFromUrl(p.baseUrl)
    if (!host) { skipped.push(`${p.id} (bad baseUrl)`); continue }
    const envVars = findEnvKeys(p.id, allSet)
    const envVar = envVars && pickEnvVar(envVars)
    if (!envVar) { skipped.push(`${p.id} (no env var)`); continue }
    const modelId = defaultModelPerProvider[p.id]
    rows.push({
      id: p.id,
      label: p.name ?? p.id,
      envVar,
      apiHost: host,
      defaultModel: modelId ? `${p.id}/${modelId}` : undefined,
    })
  }
  console.log(`  pi: ${rows.length} providers, ${skipped.length} skipped`)
  if (skipped.length) console.log(`    skipped: ${skipped.join(', ')}`)
  return sortRows(rows)
}

/**
 * pi's own per-provider model ids (bare, e.g. `claude-opus-4-8`), from its
 * installed registry (`getBuiltinModels`). It differs from models.dev, so
 * `yaac-mama models` reports this list for pi. pi still accepts any
 * `provider/model` at runtime.
 */
async function buildPiModelsCatalog(): Promise<ModelsCatalog> {
  const root = piPackageRoot()
  const piAi = path.join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist')
  const all = await importPi(path.join(piAi, 'providers', 'all.js'))
  const getBuiltinProviders = all.getBuiltinProviders as () => string[]
  const getBuiltinModels = all.getBuiltinModels as (provider: string) => { id: string; name?: unknown }[]

  const catalog: ModelsCatalog = { ids: {}, names: {} }
  let modelCount = 0
  for (const provider of getBuiltinProviders()) {
    const models = getBuiltinModels(provider)
    const ids = models.map((m) => m.id).sort()
    if (ids.length) {
      catalog.ids[provider] = ids
      catalog.names[provider] = Object.fromEntries(models.flatMap((m) => {
        const name = displayName(m.name)
        return name !== undefined ? [[m.id, name]] : []
      }))
      modelCount += ids.length
    }
  }
  console.log(`  models (pi registry): ${modelCount} ids across ${Object.keys(catalog.ids).length} providers`)
  return catalog
}

// ── emit ────────────────────────────────────────────────────────────────

function sortRows(rows: ProviderRow[]): ProviderRow[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id))
}

function pkgVersion(dir: string): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? '?'
  } catch {
    return '?'
  }
}

function rowLiteral(r: ProviderRow): string {
  const parts = [
    `id: ${JSON.stringify(r.id)}`,
    `label: ${JSON.stringify(r.label)}`,
    `envVar: ${JSON.stringify(r.envVar)}`,
    `apiHost: ${JSON.stringify(r.apiHost)}`,
  ]
  if (r.defaultModel) parts.push(`defaultModel: ${JSON.stringify(r.defaultModel)}`)
  return `  { ${parts.join(', ')} },`
}

/** Emit the provider rows and the id union type derived from them. */
function providerRows(constName: string, typeName: string, rows: ProviderRow[]): string {
  return `export const ${constName} = [\n${rows.map(rowLiteral).join('\n')}\n] as const satisfies readonly ToolProviderInfo[]\n`
    + `export type ${typeName} = (typeof ${constName})[number]['id']`
}

/** pi provider id → default `provider/model` launch string (pi rows only). */
function piDefaultModelsMap(rows: ProviderRow[]): string {
  const entries = rows
    .filter((r) => r.defaultModel)
    .map((r) => `  ${JSON.stringify(r.id)}: ${JSON.stringify(r.defaultModel)},`)
    .join('\n')
  return `export const PI_PROVIDER_DEFAULT_MODELS: Record<string, string> = {\n${entries}\n}`
}

function modelNamesMap(name: string, names: Record<string, Record<string, string>>): string {
  const entries = Object.keys(names)
    .sort()
    .map((id) => {
      const pairs = Object.keys(names[id]).sort()
        .map((m) => `${JSON.stringify(m)}: ${JSON.stringify(names[id][m])}`)
      return `  ${JSON.stringify(id)}: { ${pairs.join(', ')} },`
    })
    .join('\n')
  return `export const ${name}: Record<string, Record<string, string>> = {\n${entries}\n}`
}

function modelsCatalogMap(name: string, catalog: Record<string, string[]>): string {
  const entries = Object.keys(catalog)
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: [${catalog[id].map((m) => JSON.stringify(m)).join(', ')}],`)
    .join('\n')
  return `export const ${name}: Record<string, string[]> = {\n${entries}\n}`
}

/** The generated file's content. */
function generatedFile(
  opencode: ProviderRow[],
  pi: ProviderRow[],
  catalog: ModelsCatalog,
  piModels: ModelsCatalog,
  header: string,
): string {
  return `/* eslint-disable */
// AUTO-GENERATED by scripts/gen-tool-providers.ts — DO NOT EDIT BY HAND.
// Regenerate with: pnpm gen:providers (from the repo root).
${header}

/**
 * One api-key provider row for an api-key-only agent tool (opencode / pi).
 * Drives the credential picker (label), the pod env placeholder (envVar), the
 * proxy key swap (apiHost), and — pi only — the launch model (defaultModel).
 */
export interface ToolProviderInfo {
  id: string
  label: string
  /** Env var the tool reads the api key from; seeded with the placeholder. */
  envVar: string
  /** Bare hostname the egress proxy swaps the placeholder key on. */
  apiHost: string
  /** pi only: default \`pi --model <provider>/<id>\` value. */
  defaultModel?: string
}

${providerRows('OPENCODE_PROVIDERS', 'OpencodeProviderId', opencode)}

${providerRows('PI_PROVIDERS', 'PiProviderId', pi)}

${piDefaultModelsMap(pi)}

// ── Model catalogs: candidate --model values per provider ────────────────
// Served to a workspace asking \`yaac-mama models\` so a
// workspace can discover valid \`--model\` values without a network fetch; also
// available to the app (e.g. a model picker). MODELS_BY_PROVIDER is models.dev's
// tool-calling models (claude → anthropic, codex → openai, opencode → provider),
// newest first with dated snapshots of a listed alias dropped;
// PI_MODELS_BY_PROVIDER is pi's own registry, which differs from models.dev.
// The *_NAMES maps carry each registry's display name for an id.

${modelsCatalogMap('MODELS_BY_PROVIDER', catalog.ids)}

${modelsCatalogMap('PI_MODELS_BY_PROVIDER', piModels.ids)}

${modelNamesMap('MODEL_NAMES', catalog.names)}

${modelNamesMap('PI_MODEL_NAMES', piModels.names)}
`
}

async function main(): Promise<void> {
  console.log('Generating tool provider tables…')
  const db = await fetchModelsDev()
  const [pi, piModels] = await Promise.all([buildPiRows(), buildPiModelsCatalog()])
  const catalog = buildModelsCatalog(db)
  const opencode = buildOpencodeRows(db, catalog.ids)

  const piRoot = piPackageRoot()
  const opencodeVer = (() => {
    try {
      // opencode ships as a single compiled binary (not a resolvable package),
      // so read the version off the CLI itself; header-only, best-effort.
      return execFileSync('opencode', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || '?'
    } catch {
      return '?'
    }
  })()
  const header = `// Sources: opencode → models.dev (@opencode/cli ${opencodeVer}); ` +
    `pi → @earendil-works/pi-coding-agent ${pkgVersion(piRoot)}.`

  const content = generatedFile(opencode, pi, catalog, piModels, header)
  const sharedPath = path.join(REPO_ROOT, 'packages', 'shared', 'src', 'tool-providers.generated.ts')
  fs.writeFileSync(sharedPath, content)
  console.log(`Wrote ${path.relative(REPO_ROOT, sharedPath)}`)
}

await main()
