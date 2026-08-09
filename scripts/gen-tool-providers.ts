/**
 * Code-generate the api-key provider tables for the api-key-only agent tools
 * (`opencode` and `pi`) by reading each tool's own provider registry, so yaac
 * can offer every provider they support without hand-maintaining a list.
 *
 * Run with:  pnpm gen:providers
 *
 * Emits ONE provider-table artifact, written byte-identically to two committed
 * locations:
 *   - packages/shared/src/tool-providers.generated.ts  (server/frontend/CLI)
 *   - k8s/proxy/tool-providers.generated.ts            (egress proxy)
 * It carries the provider rows, the proxy's host/default-model lookups, and the
 * full models.dev model catalog (MODELS_BY_PROVIDER). The proxy can't import
 * from packages/shared (it bundles self-only, npm-installed in its image
 * build), so it gets its own copy of the same content in its build context —
 * one source of truth, no drift.
 *
 * Also emits the raw models.dev response to:
 *   - dockerfiles/opencode-models.json
 * Dockerfile.tools bakes it into the worktree image as opencode's models.dev
 * cache file (~/.cache/opencode/models.json), so the TUI's model list is as
 * fresh as the last regen instead of the catalog compiled into the pinned
 * opencode binary at its release. Kept byte-exact as fetched — it must remain
 * a valid models.dev api.json for opencode to parse.
 *
 * Sources:
 *   - opencode: models.dev (https://models.dev/api.json), the provider/model
 *     database opencode itself uses. Fetched fresh; falls back to opencode's
 *     local cache (~/.cache/opencode/models.json) when offline.
 *   - pi: the installed @earendil-works/pi-ai package — its builtinProviders()
 *     (id/label/baseUrl), findEnvKeys() (env var per provider), and
 *     pi-coding-agent's defaultModelPerProvider map. No source parsing: we
 *     import pi's own compiled modules and read their exported values.
 *
 * Scope: api-key providers with a single stable https host only. Multi-config
 * backends (azure, bedrock, vertex, per-account gateways) need region/resource/
 * OAuth config beyond a bare key and can't be pinned to one host for the proxy
 * swap, so they're skipped-and-logged, not silently dropped. OAuth-only
 * providers are skipped too (this repo is api-key-only for opencode/pi).
 *
 * Requirements to run: network access to models.dev (or a warm opencode cache)
 * and a global `pi` install (`@earendil-works/pi-coding-agent`). This is a
 * dev-time step run when bumping either tool — not part of `pnpm build`.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')

/** One provider row shared by both generated artifacts. */
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
 * Default hosts for the well-known dedicated-SDK providers that models.dev
 * lists without a provider-level `api` (the AI SDK hardcodes their base URL).
 * Keyed by the provider's `npm` package — the one small, stable bit of
 * hand-maintained data here, and it lives only in this generator. These are
 * AI-SDK default base-URL hosts; they effectively never change.
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

interface ModelsDevProvider {
  id: string
  name?: string
  env?: string[]
  npm?: string
  api?: string
  models?: Record<string, unknown>
}

/** The parsed models.dev database plus the raw response text — the raw form
 *  is committed verbatim as dockerfiles/opencode-models.json. */
async function fetchModelsDev(): Promise<{ db: Record<string, ModelsDevProvider>; raw: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch('https://models.dev/api.json', { signal: ctrl.signal })
    if (!res.ok) throw new Error(`models.dev returned ${res.status}`)
    console.log('  source: models.dev/api.json (live)')
    const raw = await res.text()
    return { db: JSON.parse(raw) as Record<string, ModelsDevProvider>, raw }
  } catch (err) {
    const cache = path.join(os.homedir(), '.cache', 'opencode', 'models.json')
    if (fs.existsSync(cache)) {
      console.log(`  source: ${cache} (models.dev fetch failed: ${err instanceof Error ? err.message : String(err)})`)
      const raw = fs.readFileSync(cache, 'utf8')
      return { db: JSON.parse(raw) as Record<string, ModelsDevProvider>, raw }
    }
    throw new Error(
      `Could not load models.dev (${err instanceof Error ? err.message : String(err)}) ` +
      'and no opencode cache found. Run `opencode models --refresh` or connect to the network.',
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pick the api-key env var for a provider, preferring an `*_API_KEY`-shaped
 * candidate over a bearer-token one.
 *
 * The chosen var is seeded with the api-key *placeholder* into a worktree pod
 * that carries every credentialed tool's placeholders at once (the pod spec is
 * immutable, so a prewarmed spare can be retooled). Bearer-token vars are read
 * by other tools with a different precedence: Claude Code ranks
 * ANTHROPIC_AUTH_TOKEN above its OAuth credential, so seeding it for a pi
 * anthropic credential would shadow the login of a claude worktree sharing the
 * pod. Providers list both shapes (pi's anthropic registry offers
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_API_KEY) and the tool
 * reads whichever is set, so preferring the api-key var costs nothing.
 * Falls back to the first non-OAuth candidate when no `_API_KEY` var exists.
 */
function pickEnvVar(env: string[]): string | undefined {
  const apiKeyOnly = env.filter((v) => !/OAUTH/i.test(v))
  return apiKeyOnly.find((v) => /_API_KEY$/i.test(v)) ?? apiKeyOnly[0] ?? env[0]
}

/**
 * Bare hostname from a base-URL string, or null if unparseable or not a fixed
 * base URL. Rejects templated/placeholder URLs like models.dev's databricks
 * `https://${databricks_host}/...` — a per-workspace value the proxy can't
 * match on, so the provider is skipped rather than emitted with a bogus host.
 *
 * The check covers the whole URL, not just the host: cloudflare-workers-ai
 * templates the account id into the *path* behind a fixed host
 * (`api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1`).
 * Matching on the host alone would emit it with a usable-looking host and a
 * path segment the worktree can never fill in, so every request would fail —
 * it needs per-account config beyond a bare key, like the multi-config
 * providers excluded above.
 *
 * Loopback hosts are rejected for a related reason: they name a server on the
 * *user's own machine* (models.dev lists several local-inference providers
 * this way), which a worktree pod's localhost is not. The transparent proxy
 * only intercepts egress, so it never sees loopback traffic and could not swap
 * the placeholder key there anyway — the provider is unusable from a worktree
 * either way, so it is skipped rather than offered in the credential picker.
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
 *   A provider absent from it has no model an agent can drive, so selecting it
 *   is a dead end: the credential picker would offer it, the pod would get its
 *   env var, and `yaac-spawn --models` would then report no ids for it. Some
 *   have a usable sibling carrying the tool-calling ids under the same key and
 *   host (models.dev splits perplexity into perplexity / perplexity-agent), so
 *   dropping the empty one steers the picker at the entry that works.
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
 * Each models.dev provider's TOOL-CALLING model ids, keyed by provider id.
 * Baked in so `yaac-spawn --models` can report usable `--model` values with no
 * worktree-time fetch: claude → `anthropic`, codex → `openai`, opencode → its
 * configured provider. Filtered to `tool_call` models because every agent tool
 * drives models via tool calls — this drops embedding/image/tts/realtime
 * entries (e.g. text-embedding-3-large) that an agent can't run, so the list is
 * a set of candidate agent models, not the vendor's full catalog. pi has its
 * own registry (see PI_MODELS_BY_PROVIDER); it does not use this map.
 */
function buildModelsCatalog(db: Record<string, ModelsDevProvider>): Record<string, string[]> {
  const catalog: Record<string, string[]> = {}
  let modelCount = 0
  for (const [id, p] of Object.entries(db)) {
    const models = p.models && typeof p.models === 'object' ? p.models : {}
    const ids = Object.entries(models)
      .filter(([, m]) => (m as { tool_call?: unknown }).tool_call === true)
      .map(([mid]) => mid)
      .sort()
    if (ids.length) {
      catalog[id] = ids
      modelCount += ids.length
    }
  }
  console.log(`  models (models.dev, tool-calling): ${modelCount} ids across ${Object.keys(catalog).length} providers`)
  return catalog
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
  // Dynamic import is required: pi's compiled ESM modules live in a globally
  // installed package resolved by absolute path at codegen time, so they can't
  // be statically imported. This is a dev-only script, not shipped src.
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

  // findEnvKeys returns only the env vars that are *set* in the passed env; a
  // Proxy that reports every key as present makes it return the full candidate
  // list for the provider — pi's own map, extracted without parsing source.
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
 * installed registry (`getBuiltinModels`). pi's catalog differs from models.dev
 * — it is pi's curated per-provider list — so `yaac-spawn --models` reports it
 * for pi rather than reusing the models.dev map. (pi still accepts any
 * `provider/model` at runtime; this is the convenience list.)
 */
async function buildPiModelsCatalog(): Promise<Record<string, string[]>> {
  const root = piPackageRoot()
  const piAi = path.join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist')
  const all = await importPi(path.join(piAi, 'providers', 'all.js'))
  const getBuiltinProviders = all.getBuiltinProviders as () => string[]
  const getBuiltinModels = all.getBuiltinModels as (provider: string) => { id: string }[]

  const catalog: Record<string, string[]> = {}
  let modelCount = 0
  for (const provider of getBuiltinProviders()) {
    const ids = getBuiltinModels(provider).map((m) => m.id).sort()
    if (ids.length) { catalog[provider] = ids; modelCount += ids.length }
  }
  console.log(`  models (pi registry): ${modelCount} ids across ${Object.keys(catalog).length} providers`)
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

/** Emit the id tuple + the string-literal union type derived from it. */
function idTupleAndType(constName: string, typeName: string, rows: ProviderRow[]): string {
  const tuple = `export const ${constName} = [\n${rows.map((r) => `  ${JSON.stringify(r.id)},`).join('\n')}\n] as const`
  return `${tuple}\nexport type ${typeName} = (typeof ${constName})[number]`
}

function hostMap(name: string, rows: ProviderRow[]): string {
  const entries = rows.map((r) => `  ${JSON.stringify(r.id)}: ${JSON.stringify(r.apiHost)},`).join('\n')
  return `export const ${name}: Record<string, string> = {\n${entries}\n}`
}

/** pi provider id → default `provider/model` launch string (pi rows only). */
function piDefaultModelsMap(rows: ProviderRow[]): string {
  const entries = rows
    .filter((r) => r.defaultModel)
    .map((r) => `  ${JSON.stringify(r.id)}: ${JSON.stringify(r.defaultModel)},`)
    .join('\n')
  return `export const PI_PROVIDER_DEFAULT_MODELS: Record<string, string> = {\n${entries}\n}`
}

function modelsCatalogMap(name: string, catalog: Record<string, string[]>): string {
  const entries = Object.keys(catalog)
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: [${catalog[id].map((m) => JSON.stringify(m)).join(', ')}],`)
    .join('\n')
  return `export const ${name}: Record<string, string[]> = {\n${entries}\n}`
}

/**
 * The single generated artifact, emitted byte-identically to both
 * packages/shared/src/ and k8s/proxy/. The proxy bundles self-only (npm-
 * installed in its image build) and can't import from packages/shared, so it
 * carries its own copy — kept in sync by writing the exact same content to both.
 */
function generatedFile(
  opencode: ProviderRow[],
  pi: ProviderRow[],
  catalog: Record<string, string[]>,
  piModels: Record<string, string[]>,
  header: string,
): string {
  return `/* eslint-disable */
// AUTO-GENERATED by scripts/gen-tool-providers.ts — DO NOT EDIT BY HAND.
// Regenerate with: pnpm gen:providers (from the repo root).
${header}
//
// Emitted byte-identically to packages/shared/src/tool-providers.generated.ts
// and k8s/proxy/tool-providers.generated.ts. The proxy can't import from
// packages/shared (self-only bundle), so it carries its own copy of this same
// content.

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

${idTupleAndType('OPENCODE_PROVIDER_IDS', 'OpencodeProviderId', opencode)}

export const OPENCODE_PROVIDERS: readonly ToolProviderInfo[] = [
${opencode.map(rowLiteral).join('\n')}
]

${idTupleAndType('PI_PROVIDER_IDS', 'PiProviderId', pi)}

export const PI_PROVIDERS: readonly ToolProviderInfo[] = [
${pi.map(rowLiteral).join('\n')}
]

// ── Provider host lookups (derived from the rows above) ──────────────────
// The host each provider's api key authenticates against; the proxy swaps the
// placeholder key only on this host for a worktree registered as that tool.

${hostMap('OPENCODE_PROVIDER_HOSTS', opencode)}

${hostMap('PI_PROVIDER_HOSTS', pi)}

${piDefaultModelsMap(pi)}

// ── Model catalogs: candidate --model values per provider ────────────────
// Served by \`GET yaac.internal/tools?models=1\` (yaac-spawn --models) so a
// worktree can discover valid \`--model\` values without a network fetch; also
// available to the app (e.g. a model picker). MODELS_BY_PROVIDER is models.dev's
// tool-calling models (claude → anthropic, codex → openai, opencode → provider);
// PI_MODELS_BY_PROVIDER is pi's own registry, which differs from models.dev.

${modelsCatalogMap('MODELS_BY_PROVIDER', catalog)}

${modelsCatalogMap('PI_MODELS_BY_PROVIDER', piModels)}
`
}

async function main(): Promise<void> {
  console.log('Generating tool provider tables…')
  const { db, raw } = await fetchModelsDev()
  const [pi, piModels] = await Promise.all([buildPiRows(), buildPiModelsCatalog()])
  const catalog = buildModelsCatalog(db)
  const opencode = buildOpencodeRows(db, catalog)

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
  const header = `// Sources: opencode → models.dev (opencode-ai ${opencodeVer}); ` +
    `pi → @earendil-works/pi-coding-agent ${pkgVersion(piRoot)}.`

  const content = generatedFile(opencode, pi, catalog, piModels, header)
  const sharedPath = path.join(REPO_ROOT, 'packages', 'shared', 'src', 'tool-providers.generated.ts')
  const proxyPath = path.join(REPO_ROOT, 'k8s', 'proxy', 'tool-providers.generated.ts')
  // Raw catalog for the worktree image: Dockerfile.tools COPYs it in as
  // opencode's models.dev cache file. Byte-exact as fetched (no reformat) so
  // it stays a valid api.json; JSON carries no comment, so its provenance is
  // documented where it's consumed (Dockerfile.tools) and here.
  const modelsPath = path.join(REPO_ROOT, 'dockerfiles', 'opencode-models.json')
  fs.writeFileSync(sharedPath, content)
  fs.writeFileSync(proxyPath, content)
  fs.writeFileSync(modelsPath, raw)
  console.log(`Wrote ${path.relative(REPO_ROOT, sharedPath)}`)
  console.log(`Wrote ${path.relative(REPO_ROOT, proxyPath)}`)
  console.log(`Wrote ${path.relative(REPO_ROOT, modelsPath)}`)
}

await main()
