/**
 * Code-generate the api-key provider tables for the api-key-only agent tools
 * (`opencode` and `pi`) by reading each tool's own provider registry, so yaac
 * can offer every provider they support without hand-maintaining a list.
 *
 * Run with:  pnpm gen:providers
 *
 * Writes packages/shared/src/tool-providers.generated.ts: the provider rows,
 * pi's default models, the model catalogs, and each model's effort levels
 * (docs/effort-levels.md). The egress proxy needs only a credential's
 * provider host, which the server sends it with the key.
 *
 * Sources:
 *   - opencode: models.dev (https://models.dev/api.json), the provider/model
 *     database opencode itself uses.
 *   - pi: the installed @earendil-works/pi-ai package — its builtinProviders()
 *     (id/label/baseUrl), findEnvKeys() (env var per provider), and
 *     pi-coding-agent's defaultModelPerProvider map, read by importing pi's
 *     compiled modules.
 *   - effort levels: each tool's own catalog. claude's model table is read
 *     from its binary, codex's from `codex debug models --bundled`, pi's from
 *     pi-ai, and opencode's variants from a private `opencode serve`. The
 *     claude catalog also drops models the pinned claude does not know.
 *
 * Only api-key providers with a single fixed https host are emitted.
 * Providers needing region/resource/OAuth config (azure, bedrock, vertex,
 * per-account gateways) can't be pinned to one host for the proxy's key
 * swap, so they are skipped and logged. OAuth-only providers are skipped too.
 *
 * Needs network access to models.dev and the pinned claude, codex, opencode
 * and pi on PATH (`AGENT_CLIS`; a mismatch stops the run). Run it when
 * bumping any of them; it is not part of `pnpm build`. A source whose
 * output can't be trusted (claude's table changed layout, an empty codex
 * catalog) stops the run without writing.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import { AGENT_CLIS } from '@yaac/shared/types'

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

// ── effort levels: each tool's own catalog ──────────────────────────────

/** One model's effort levels, in the tool's own words, and its default. */
interface ModelEfforts {
  levels: string[]
  default: string
}

/** The claude catalog and every tool's per-model effort table. */
interface EffortTables {
  claudeModels: string[]
  efforts: Record<'claude' | 'codex' | 'opencode' | 'pi', Record<string, ModelEfforts>>
}

/** Stop the run: an effort source changed shape, so its output can't be
 *  trusted and nothing is written. */
function fail(message: string): never {
  console.error(`gen-tool-providers: ${message}`)
  process.exit(1)
}

/**
 * Check the installed CLI is the pinned one, since its catalog is read from
 * it. `reported` is the CLI's own version output.
 */
function requirePinned(tool: keyof typeof AGENT_CLIS, reported: string): void {
  const pinned = AGENT_CLIS[tool].version
  if (!reported.includes(pinned)) {
    fail(`${tool} reports "${reported.trim()}", but AGENT_CLIS pins ${pinned}; install the pinned version`)
  }
}

const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
/** Every capability word in claude's table that mentions effort. A new one
 *  may change what the levels are, so it stops the run. */
const CLAUDE_EFFORT_CAPABILITIES = new Set([
  'effort', 'xhigh_effort', 'max_effort', 'per_turn_effort', 'thinking_disabled_effort_cap',
])

/**
 * Claude Code's built-in model table, read from the pinned binary: each
 * model's levels (from its `effort`, `xhigh_effort` and `max_effort`
 * capabilities) and its `default_effort`. No public source has Claude
 * Code's own defaults (docs/effort-levels.md). An entry without a
 * `default_effort` runs at `high`, claude's own fallback. A model with no
 * `effort` capability is in the table with no levels.
 */
function scanClaudeModelTable(): Map<string, ModelEfforts | undefined> {
  const which = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim()
  if (!which) fail('claude is not on PATH')
  requirePinned('claude', execFileSync('claude', ['--version'], { encoding: 'utf8' }))
  const bin = fs.realpathSync(which)
  const text = fs.readFileSync(bin, 'latin1')
  const where = `in ${bin}`
  const entry = /provider_ids:\{first_party:"(claude-[a-z0-9.-]+)"([^]{0,800}?)capabilities:\[([^\]]*)\](?:,default_effort:"([a-z]+)")?/g
  const table = new Map<string, ModelEfforts | undefined>()
  for (const m of text.matchAll(entry)) {
    const [, id, gap, capList, declared] = m
    if (gap.includes('provider_ids:')) fail(`claude model ${id} has no capability list ${where}`)
    // The default is read only right after the capabilities, so an entry
    // that names one elsewhere would silently fall back to `high`.
    const next = text.indexOf('provider_ids:{first_party:', m.index + 1)
    const entryText = text.slice(m.index, next < 0 ? undefined : next)
    if (declared === undefined && entryText.includes('default_effort:')) {
      fail(`claude model ${id} names a default_effort where the parser does not read it ${where}`)
    }
    const caps = capList.replaceAll('"', '').split(',')
    const unknown = caps.filter((c) => c.includes('effort') && !CLAUDE_EFFORT_CAPABILITIES.has(c))
    if (unknown.length) fail(`claude model ${id} has unknown effort capabilities ${unknown.join(', ')} ${where}`)
    const levels = caps.includes('effort')
      ? CLAUDE_LEVELS.filter((l) => !['xhigh', 'max'].includes(l) || caps.includes(`${l}_effort`))
      : []
    const fallback = levels.length ? 'high' : undefined
    const def = declared ?? fallback
    if (def !== undefined && !levels.includes(def)) {
      fail(`claude model ${id} defaults to "${def}", outside its levels [${levels.join(', ')}] ${where}`)
    }
    table.set(id, def !== undefined ? { levels, default: def } : undefined)
  }
  const declaredEntries = text.split('provider_ids:{first_party:').length - 1
  if (table.size === 0) fail(`found no model-config entries ${where}; its layout changed`)
  if (table.size !== declaredEntries) {
    fail(`parsed ${table.size} of ${declaredEntries} model-config entries ${where}; its layout changed`)
  }
  console.log(`  claude model table: ${table.size} entries`)
  return table
}

/**
 * The claude catalog: models.dev's anthropic list, minus models the pinned
 * claude has no table entry for (newer than it), with their efforts. A
 * table id may carry the `-YYYYMMDD` snapshot suffix the catalog drops.
 */
function buildClaudeCatalog(anthropic: string[]): { models: string[]; efforts: Record<string, ModelEfforts> } {
  const table = scanClaudeModelTable()
  const byAlias = new Map([...table].map(([id, e]) => [id.replace(/-\d{8}$/, ''), e]))
  const models: string[] = []
  const dropped: string[] = []
  const efforts: Record<string, ModelEfforts> = {}
  for (const id of anthropic) {
    if (!table.has(id) && !byAlias.has(id)) { dropped.push(id); continue }
    models.push(id)
    const e = table.has(id) ? table.get(id) : byAlias.get(id)
    if (e) efforts[id] = e
  }
  if (dropped.length) console.log(`    claude catalog drops (unknown to the pinned claude): ${dropped.join(', ')}`)
  if (!models.includes(FALLBACK_MODELS.claude)) {
    fail(`the claude catalog lacks FALLBACK_MODELS.claude (${FALLBACK_MODELS.claude})`)
  }
  return { models, efforts }
}

/**
 * codex's levels and defaults from its bundled catalog (`codex debug models
 * --bundled`, offline), which differs from models.dev (`ultra`, no
 * `none`). A catalog model codex doesn't bundle takes models.dev's levels
 * and `medium`, codex's own assumption for an unknown model.
 */
function buildCodexEfforts(db: Record<string, ModelsDevProvider>, openai: string[]): Record<string, ModelEfforts> {
  requirePinned('codex', execFileSync('codex', ['--version'], { encoding: 'utf8' }))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-gen-codex-'))
  let raw: string
  try {
    raw = execFileSync('codex', ['debug', 'models', '--bundled'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (err) {
    fail(`\`codex debug models --bundled\` failed: ${String(err)}`)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
  const bundled = (JSON.parse(raw) as {
    models?: { slug: string; default_reasoning_level?: string; supported_reasoning_levels?: { effort: string }[] }[]
  }).models ?? []
  const efforts: Record<string, ModelEfforts> = {}
  for (const m of bundled) {
    const levels = (m.supported_reasoning_levels ?? []).map((l) => l.effort)
    if (levels.length && m.default_reasoning_level && levels.includes(m.default_reasoning_level)) {
      efforts[m.slug] = { levels, default: m.default_reasoning_level }
    }
  }
  if (Object.keys(efforts).length === 0) fail('`codex debug models --bundled` listed no models with effort levels')
  const unbundled: string[] = []
  for (const id of openai) {
    if (efforts[id]) continue
    const model = (db.openai?.models?.[id] ?? {}) as { reasoning_options?: { type: string; values?: unknown[] }[] }
    const levels = (model.reasoning_options?.find((o) => o.type === 'effort')?.values ?? [])
      .filter((v): v is string => typeof v === 'string' && /^[a-z]+$/.test(v) && v !== 'default')
    if (!levels.length) continue
    efforts[id] = { levels, default: levels.includes('medium') ? 'medium' : levels[0] }
    unbundled.push(id)
  }
  if (unbundled.length) console.log(`    codex: not in its bundled catalog, models.dev levels: ${unbundled.join(', ')}`)
  console.log(`  codex efforts: ${Object.keys(efforts).length} models`)
  return efforts
}

/**
 * pi's thinking levels per registry model (`getSupportedThinkingLevels`) and
 * the level a launch without one runs (`DEFAULT_THINKING_LEVEL`, clamped to
 * the model). Models without reasoning have only `off`, so no entry.
 */
async function buildPiEfforts(): Promise<Record<string, ModelEfforts>> {
  const root = piPackageRoot()
  const piAi = path.join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist')
  const all = await importPi(path.join(piAi, 'providers', 'all.js'))
  const models = await importPi(path.join(piAi, 'models.js'))
  const defaults = await importPi(path.join(root, 'dist', 'core', 'defaults.js'))
  const getBuiltinProviders = all.getBuiltinProviders as () => string[]
  const getBuiltinModels = all.getBuiltinModels as (provider: string) => { id: string; reasoning?: boolean }[]
  const supported = models.getSupportedThinkingLevels as ((m: unknown) => string[]) | undefined
  const clamp = models.clampThinkingLevel as ((m: unknown, level: string) => string) | undefined
  const fallback = defaults.DEFAULT_THINKING_LEVEL as string | undefined
  if (!supported || !clamp || !fallback) fail('pi-ai no longer exports its thinking-level helpers')
  const efforts: Record<string, ModelEfforts> = {}
  for (const provider of getBuiltinProviders()) {
    for (const m of getBuiltinModels(provider)) {
      if (!m.reasoning) continue
      efforts[`${provider}/${m.id}`] = { levels: supported(m), default: clamp(m, fallback) }
    }
  }
  if (Object.keys(efforts).length === 0) fail('pi lists no reasoning models')
  console.log(`  pi efforts: ${Object.keys(efforts).length} models`)
  return efforts
}

/**
 * opencode's variants per model, asked of opencode itself: a private
 * `opencode serve` with every provider given a placeholder key lists each
 * model's computed `variants` on `/api/model`, which no key-less call does.
 * Levels lead with `default` (no variant), which is also the default.
 *
 * The server answers before it has loaded models.dev, at first with only
 * its built-in provider, so it is polled until two answers agree and enough
 * of the providers models.dev gives reasoning options have variants. Half
 * is the floor: opencode adds none for some providers' packages.
 */
async function buildOpencodeEfforts(
  db: Record<string, ModelsDevProvider>,
  providers: string[],
): Promise<Record<string, ModelEfforts>> {
  const reasoning = providers.filter((id) => Object.values(db[id]?.models ?? {})
    .some((m) => Array.isArray((m as { reasoning_options?: unknown }).reasoning_options)))
  const floor = Math.ceil(reasoning.length / 2)
  requirePinned('opencode', execFileSync('opencode', ['--version'], { encoding: 'utf8' }))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-gen-opencode-'))
  const port = 40000 + Math.floor(Math.random() * 20000)
  const password = 'gen-tool-providers'
  const child = spawn('opencode', ['serve', '--port', String(port)], {
    cwd: home,
    stdio: 'ignore',
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_DATA_HOME: path.join(home, 'data'),
      XDG_CACHE_HOME: path.join(home, 'cache'),
      XDG_STATE_HOME: path.join(home, 'state'),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: Object.fromEntries(providers.map((id) => [id, { options: { apiKey: 'placeholder' } }])),
      }),
    },
  })
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  type Listed = { providerID: string; modelID: string; variants?: { id: string }[] }
  const covered = (models: Listed[]): number =>
    new Set(models.filter((m) => (m.variants ?? []).length > 0).map((m) => m.providerID)).size
  let listed: Listed[] = []
  try {
    let previous = -1
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/model`, { headers: { Authorization: auth } })
        if (res.ok) listed = ((await res.json()) as { data?: Listed[] }).data ?? []
      } catch {
        // Not listening yet.
      }
      if (listed.length > 0 && listed.length === previous && covered(listed) >= floor) break
      previous = listed.length
    }
  } finally {
    child.kill()
    fs.rmSync(home, { recursive: true, force: true })
  }
  const efforts: Record<string, ModelEfforts> = {}
  for (const m of listed) {
    const variants = (m.variants ?? []).map((v) => v.id).filter((v) => /^[a-z]+$/.test(v) && v !== 'default')
    if (variants.length) efforts[`${m.providerID}/${m.modelID}`] = { levels: ['default', ...variants], default: 'default' }
  }
  if (covered(listed) < floor) {
    fail(`\`opencode serve\` gave variants for ${String(covered(listed))} providers on /api/model;`
      + ` expected at least ${String(floor)} of the ${String(reasoning.length)} with reasoning options`)
  }
  console.log(`  opencode efforts: ${Object.keys(efforts).length} models across ${String(covered(listed))} providers`)
  return efforts
}

/** Keep only the entries a catalog offers, so the table stays the catalog's size. */
function pickCatalog(efforts: Record<string, ModelEfforts>, ids: Iterable<string>): Record<string, ModelEfforts> {
  return Object.fromEntries([...ids].flatMap((id) => (efforts[id] ? [[id, efforts[id]]] : [])))
}

async function buildEffortTables(
  db: Record<string, ModelsDevProvider>,
  catalog: ModelsCatalog,
  opencode: ProviderRow[],
  piModels: ModelsCatalog,
): Promise<EffortTables> {
  const claude = buildClaudeCatalog(catalog.ids.anthropic ?? [])
  const codex = buildCodexEfforts(db, catalog.ids.openai ?? [])
  const pi = await buildPiEfforts()
  const opencodeEfforts = await buildOpencodeEfforts(db, opencode.map((r) => r.id))
  const qualified = (ids: Record<string, string[]>, providers: string[]): string[] =>
    providers.flatMap((p) => (ids[p] ?? []).map((m) => `${p}/${m}`))
  return {
    claudeModels: claude.models,
    efforts: {
      claude: claude.efforts,
      codex,
      opencode: pickCatalog(opencodeEfforts, qualified(catalog.ids, opencode.map((r) => r.id))),
      pi: pickCatalog(pi, qualified(piModels.ids, Object.keys(piModels.ids))),
    },
  }
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

/**
 * The per-model effort table. Many models share one set of levels, so each
 * distinct set is emitted once (`EFFORT_SETS`) and models refer to it.
 */
function effortTablesSource(tables: EffortTables): string {
  const sets: string[] = []
  const index = new Map<string, number>()
  const ref = (e: ModelEfforts): string => {
    const literal = `{ levels: [${e.levels.map((l) => JSON.stringify(l)).join(', ')}], default: ${JSON.stringify(e.default)} }`
    if (!index.has(literal)) {
      index.set(literal, sets.length)
      sets.push(literal)
    }
    return `EFFORT_SETS[${index.get(literal)}]`
  }
  const tools = (['claude', 'codex', 'opencode', 'pi'] as const).map((tool) => {
    const efforts = tables.efforts[tool]
    const rows = Object.keys(efforts).sort().map((id) => `    ${JSON.stringify(id)}: ${ref(efforts[id])},`)
    return `  ${tool}: {\n${rows.join('\n')}\n  },`
  })
  return `export const CLAUDE_MODELS: string[] = [${tables.claudeModels.map((m) => JSON.stringify(m)).join(', ')}]

const EFFORT_SETS: readonly ModelEfforts[] = [
${sets.map((s) => `  ${s},`).join('\n')}
]

export const EFFORTS: Record<'claude' | 'codex' | 'opencode' | 'pi', Record<string, ModelEfforts>> = {
${tools.join('\n')}
}`
}

/** The generated file's content. */
function generatedFile(
  opencode: ProviderRow[],
  pi: ProviderRow[],
  catalog: ModelsCatalog,
  piModels: ModelsCatalog,
  efforts: EffortTables,
  header: string,
): string {
  return `/* eslint-disable */
// AUTO-GENERATED by scripts/gen-tool-providers.ts — DO NOT EDIT BY HAND.
// Regenerate with: pnpm gen:providers (from the repo root).
${header}

/**
 * One api-key provider row for an api-key-only agent tool (opencode / pi).
 * Drives the credential picker (label), pi's key fallback (envVar), the
 * proxy key swap (apiHost), and — pi only — the launch model (defaultModel).
 */
export interface ToolProviderInfo {
  id: string
  label: string
  /** Env var the tool reads the api key from when its config names none. */
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

// ── Effort levels: each tool's own per-model levels and default ─────────
// docs/effort-levels.md. CLAUDE_MODELS is the claude catalog: models.dev's
// anthropic list, minus models the pinned claude's model table lacks. EFFORTS
// is keyed like the catalogs (bare ids for claude and codex, provider/model
// for opencode and pi); a model with no entry has no effort setting.

/** One model's effort levels, in the tool's own words, and its default. */
export interface ModelEfforts {
  levels: readonly string[]
  default: string
}

${effortTablesSource(efforts)}
`
}

async function main(): Promise<void> {
  console.log('Generating tool provider tables…')
  const db = await fetchModelsDev()
  const [pi, piModels] = await Promise.all([buildPiRows(), buildPiModelsCatalog()])
  const catalog = buildModelsCatalog(db)
  const opencode = buildOpencodeRows(db, catalog.ids)
  const efforts = await buildEffortTables(db, catalog, opencode, piModels)

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
    `pi → @earendil-works/pi-coding-agent ${pkgVersion(piRoot)}; ` +
    `efforts → claude ${AGENT_CLIS.claude.version}, codex ${AGENT_CLIS.codex.version} and the above.`

  const content = generatedFile(opencode, pi, catalog, piModels, efforts, header)
  const sharedPath = path.join(REPO_ROOT, 'packages', 'shared', 'src', 'tool-providers.generated.ts')
  fs.writeFileSync(sharedPath, content)
  console.log(`Wrote ${path.relative(REPO_ROOT, sharedPath)}`)
}

await main()
