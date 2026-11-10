import { parseDocument, type Document } from 'yaml'
import type { ConfinedRoot } from '#lib/confined-fs'
import { CUSTOM_PROVIDER, toolApiKeyEnvVar, type CustomEndpoint, type ToolProviderInfo } from '@yaac/shared/tool-providers'

/**
 * Points opencode, pi and omp at the workspace variable holding yaac's key
 * for their provider (`toolApiKeyEnvVar`), through config in the project's
 * tool homes. The tool then finds its key however it is started (as yaac's
 * agent, under an ACP adapter, or by hand in a terminal), and since each
 * tool reads its own variable, they can use one provider with different
 * keys, and none picks up the provider's own variable while yaac's is set
 * (a host export, a project variable, or claude's or codex's
 * `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`). Without yaac's variable, each falls
 * back to the provider's own.
 *
 * - opencode: a yaac-owned file per provider, which the workspace names in
 *   `OPENCODE_CONFIG`; opencode merges it over the user's `opencode.json`.
 *   It replaces the provider's `env` list, the variables opencode reads the
 *   key from, first one set wins. (An `options.apiKey` would not do: opencode
 *   ranks the provider's variable above it.)
 * - pi: an entry in `models.json`, the one config file pi reads a provider
 *   key from (a key saved with pi's own `/login` still wins over it). The
 *   key is a command that tries yaac's variable, then the provider's. A
 *   provider entry the user already gave a key is left alone.
 * - omp: the same entry, in its `models.yml`, edited in place so the user's
 *   comments and other entries are kept.
 *
 * Entries for providers the user has since switched away from are kept:
 * each names only its own provider's variable, which then goes unset.
 *
 * The `custom` provider (a self-hosted OpenAI-compatible endpoint) is
 * defined here whole rather than pointed at: an `@ai-sdk/openai-compatible`
 * provider in opencode's file, and an `openai-completions` provider in
 * pi's `models.json` and omp's `models.yml`, which yaac owns and rewrites
 * on every create. Each lists the credential's models. With no key the
 * workspace sets no variable: opencode then sends no credential, and pi's
 * and omp's key falls back to a dummy, which they need before they will
 * offer the models.
 *
 * Verified against pi 1.4.0, omp 18.18.3 and @opencode/cli 2.1.4.
 */

/** A provider row, plus the endpoint when it is `custom`. */
type KeyProvider = ToolProviderInfo & { endpoint?: CustomEndpoint }

/** Larger than any hand-written models file; a bigger one is left alone. */
const MAX_MODELS_BYTES = 1024 * 1024

/**
 * Write the config that points each signed-in api-key tool at its variable
 * (see the module comment). The homes are the project's tool homes, opened
 * with `openSandboxDir`. Returns opencode's file, relative to its config
 * dir, for the workspace's `OPENCODE_CONFIG`. Idempotent.
 */
export async function ensureToolApiKeyConfig(
  homes: { opencodeConfig: ConfinedRoot; pi: ConfinedRoot; omp: ConfinedRoot },
  providers: { opencode?: KeyProvider; pi?: KeyProvider; omp?: KeyProvider },
): Promise<{ opencodeConfigFile?: string }> {
  let opencodeConfigFile: string | undefined
  if (providers.opencode) {
    const { id, endpoint } = providers.opencode
    const keyVar = toolApiKeyEnvVar('opencode', id)
    opencodeConfigFile = `yaac-keys/${id}.json`
    const entry = id === CUSTOM_PROVIDER
      ? {
          npm: '@ai-sdk/openai-compatible',
          name: providers.opencode.label,
          env: [keyVar],
          options: { baseURL: endpoint?.baseUrl },
          models: Object.fromEntries((endpoint?.models ?? []).map((m) => [m, {}])),
        }
      : { env: [keyVar, providers.opencode.envVar] }
    const config = { provider: { [id]: entry } }
    await writeIfChanged(homes.opencodeConfig, opencodeConfigFile, JSON.stringify(config, null, 2) + '\n')
  }
  if (providers.pi?.id === CUSTOM_PROVIDER) {
    const { label, endpoint } = providers.pi
    await updateModelsJson(homes.pi, (models) => ({
      ...models,
      providers: {
        ...models.providers,
        [CUSTOM_PROVIDER]: {
          name: label,
          baseUrl: endpoint?.baseUrl,
          api: 'openai-completions',
          apiKey: `!printenv ${toolApiKeyEnvVar('pi', CUSTOM_PROVIDER)} || echo none`,
          models: (endpoint?.models ?? []).map((id) => ({ id })),
        },
      },
    }))
  } else if (providers.pi) {
    const { id, envVar } = providers.pi
    await updateModelsJson(homes.pi, (models) => {
      if (models.providers?.[id]?.apiKey !== undefined) return undefined
      const apiKey = `!printenv ${toolApiKeyEnvVar('pi', id)} || printenv ${envVar}`
      return { ...models, providers: { ...models.providers, [id]: { ...models.providers?.[id], apiKey } } }
    })
  }
  if (providers.omp?.id === CUSTOM_PROVIDER) {
    const { endpoint } = providers.omp
    await updateModelsYml(homes.omp, (doc) => {
      doc.setIn(['providers', CUSTOM_PROVIDER], doc.createNode({
        baseUrl: endpoint?.baseUrl,
        api: 'openai-completions',
        apiKey: `!printenv ${toolApiKeyEnvVar('omp', CUSTOM_PROVIDER)} || echo none`,
        models: (endpoint?.models ?? []).map((id) => ({ id })),
      }))
      return true
    })
  } else if (providers.omp) {
    const { id, envVar } = providers.omp
    await updateModelsYml(homes.omp, (doc) => {
      if (doc.hasIn(['providers', id, 'apiKey'])) return false
      doc.setIn(['providers', id, 'apiKey'], `!printenv ${toolApiKeyEnvVar('omp', id)} || printenv ${envVar}`)
      return true
    })
  }
  return opencodeConfigFile !== undefined ? { opencodeConfigFile } : {}
}

type ModelsJson = { providers?: Record<string, { apiKey?: unknown }> }

/**
 * Rewrite pi's `models.json` under its lock with `update`, which returns
 * undefined to leave it as is. A file that is not valid JSON is left for pi
 * to report.
 */
async function updateModelsJson(home: ConfinedRoot, update: (models: ModelsJson) => ModelsJson | undefined): Promise<void> {
  const rel = 'agent/models.json'
  await home.locked(rel, async () => {
    let models: ModelsJson
    try {
      const raw = await home.readFile(rel, { maxBytes: MAX_MODELS_BYTES })
      models = raw === null ? {} : JSON.parse(raw.toString('utf8')) as ModelsJson
    } catch {
      return
    }
    const next = update(models)
    if (next !== undefined) await home.writeAtomic(rel, JSON.stringify(next, null, 2) + '\n')
  })
}

/**
 * Edit omp's `models.yml` in place under its lock with `update`, which
 * returns whether it changed anything. A file that does not parse, or is
 * not a map where an entry goes, is left for omp to report.
 */
async function updateModelsYml(home: ConfinedRoot, update: (doc: Document) => boolean): Promise<void> {
  const rel = 'agent/models.yml'
  await home.locked(rel, async () => {
    const raw = await home.readFile(rel, { maxBytes: MAX_MODELS_BYTES }).catch(() => undefined)
    if (raw === undefined) return
    const doc = parseDocument(raw?.toString('utf8') ?? '')
    if (doc.errors.length > 0) return
    try {
      if (!update(doc)) return
    } catch {
      return
    }
    await home.writeAtomic(rel, doc.toString())
  })
}

async function writeIfChanged(home: ConfinedRoot, rel: string, content: string): Promise<void> {
  const current = await home.readFile(rel, { maxBytes: MAX_MODELS_BYTES }).catch(() => null)
  if (current?.toString('utf8') !== content) await home.writeAtomic(rel, content)
}
