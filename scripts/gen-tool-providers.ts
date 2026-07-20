/**
 * Code-generate the api-key provider tables for the api-key-only agent tools
 * (`opencode` and `pi`) by reading each tool's own provider registry, so yaac
 * can offer every provider they support without hand-maintaining a list.
 *
 * Run with:  pnpm gen:providers
 *
 * Emits two committed artifacts from a single computed table:
 *   - packages/shared/src/tool-providers.generated.ts  (server/frontend/CLI)
 *   - k8s/proxy/tool-providers.generated.ts            (proxy host lookup)
 * The proxy can't import from packages/shared (it bundles self-only, npm-
 * installed in its image build), so it gets its own generated copy in its
 * build context. Both derive from the same data here — no drift, no parallel
 * hand-maintained table.
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
}

async function fetchModelsDev(): Promise<Record<string, ModelsDevProvider>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch('https://models.dev/api.json', { signal: ctrl.signal })
    if (!res.ok) throw new Error(`models.dev returned ${res.status}`)
    console.log('  source: models.dev/api.json (live)')
    return (await res.json()) as Record<string, ModelsDevProvider>
  } catch (err) {
    const cache = path.join(os.homedir(), '.cache', 'opencode', 'models.json')
    if (fs.existsSync(cache)) {
      console.log(`  source: ${cache} (models.dev fetch failed: ${err instanceof Error ? err.message : String(err)})`)
      return JSON.parse(fs.readFileSync(cache, 'utf8')) as Record<string, ModelsDevProvider>
    }
    throw new Error(
      `Could not load models.dev (${err instanceof Error ? err.message : String(err)}) ` +
      'and no opencode cache found. Run `opencode models --refresh` or connect to the network.',
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Pick the api-key env var for an opencode provider (skip OAuth-token vars). */
function pickEnvVar(env: string[]): string | undefined {
  return env.find((v) => !/OAUTH/i.test(v)) ?? env[0]
}

/**
 * Bare hostname from a base-URL string, or null if unparseable or not a fixed
 * host. Rejects templated/placeholder hosts like models.dev's databricks
 * `https://${databricks_host}/...` — a per-workspace host the proxy can't
 * match on, so the provider is skipped rather than emitted with a bogus host.
 */
function hostFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname
    return /^[a-z0-9.-]+$/i.test(host) ? host : null
  } catch {
    return null
  }
}

async function buildOpencodeRows(): Promise<ProviderRow[]> {
  const db = await fetchModelsDev()
  const rows: ProviderRow[] = []
  const skipped: string[] = []
  for (const [id, p] of Object.entries(db)) {
    if (OPENCODE_EXCLUDE.has(id)) { skipped.push(`${id} (multi-config)`); continue }
    const env = Array.isArray(p.env) ? p.env : []
    const envVar = pickEnvVar(env)
    if (!envVar) { skipped.push(`${id} (no env var)`); continue }
    const host = (p.api && hostFromUrl(p.api)) || (p.npm ? OPENCODE_HOST_BY_NPM[p.npm] : undefined)
    if (!host) { skipped.push(`${id} (no stable host)`); continue }
    rows.push({ id, label: p.name ?? id, envVar, apiHost: host })
  }
  console.log(`  opencode: ${rows.length} providers, ${skipped.length} skipped`)
  if (skipped.length) console.log(`    skipped: ${skipped.join(', ')}`)
  return sortRows(rows)
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

function sharedFile(opencode: ProviderRow[], pi: ProviderRow[], header: string): string {
  return `/* eslint-disable */
// AUTO-GENERATED by scripts/gen-tool-providers.ts — DO NOT EDIT BY HAND.
// Regenerate with: pnpm gen:providers
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

${idTupleAndType('OPENCODE_PROVIDER_IDS', 'OpencodeProviderId', opencode)}

export const OPENCODE_PROVIDERS: readonly ToolProviderInfo[] = [
${opencode.map(rowLiteral).join('\n')}
]

${idTupleAndType('PI_PROVIDER_IDS', 'PiProviderId', pi)}

export const PI_PROVIDERS: readonly ToolProviderInfo[] = [
${pi.map(rowLiteral).join('\n')}
]
`
}

function hostMap(name: string, rows: ProviderRow[]): string {
  const entries = rows.map((r) => `  ${JSON.stringify(r.id)}: ${JSON.stringify(r.apiHost)},`).join('\n')
  return `export const ${name}: Record<string, string> = {\n${entries}\n}`
}

function proxyFile(opencode: ProviderRow[], pi: ProviderRow[], header: string): string {
  return `/* eslint-disable */
// AUTO-GENERATED by scripts/gen-tool-providers.ts — DO NOT EDIT BY HAND.
// Regenerate with: pnpm gen:providers (from the repo root).
${header}
//
// Proxy-side copy: the host each opencode/pi provider's api key authenticates
// against. The proxy swaps the placeholder key only on this host for a session
// registered as that tool. It can't import packages/shared (self-only bundle),
// so it carries its own generated copy — kept in sync by the same codegen.

${hostMap('OPENCODE_PROVIDER_HOSTS', opencode)}

${hostMap('PI_PROVIDER_HOSTS', pi)}
`
}

async function main(): Promise<void> {
  console.log('Generating tool provider tables…')
  const [opencode, pi] = await Promise.all([buildOpencodeRows(), buildPiRows()])

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

  const sharedPath = path.join(REPO_ROOT, 'packages', 'shared', 'src', 'tool-providers.generated.ts')
  const proxyPath = path.join(REPO_ROOT, 'k8s', 'proxy', 'tool-providers.generated.ts')
  fs.writeFileSync(sharedPath, sharedFile(opencode, pi, header))
  fs.writeFileSync(proxyPath, proxyFile(opencode, pi, header))
  console.log(`Wrote ${path.relative(REPO_ROOT, sharedPath)}`)
  console.log(`Wrote ${path.relative(REPO_ROOT, proxyPath)}`)
}

await main()
