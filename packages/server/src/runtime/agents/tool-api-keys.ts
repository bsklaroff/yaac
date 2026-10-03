import type { ConfinedRoot } from '#lib/confined-fs'
import { toolApiKeyEnvVar, type ToolProviderInfo } from '@yaac/shared/tool-providers'

/**
 * Points opencode and pi at the workspace variable holding yaac's key for
 * their provider (`toolApiKeyEnvVar`), through config in the project's tool
 * homes. The tool then finds its key however it is started (as yaac's
 * agent, under an ACP adapter, or by hand in a terminal), and since each
 * tool reads its own variable, both can use one provider with different
 * keys, and neither picks up the provider's own variable while yaac's is
 * set (a host export, a project variable, or claude's or codex's
 * `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`). Without yaac's variable, both fall
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
 *
 * Entries for providers the user has since switched away from are kept:
 * each names only its own provider's variable, which then goes unset.
 *
 * Verified against pi 0.99.2 and @opencode/cli 2.0.21.
 */

/** Larger than any hand-written models.json; a bigger one is left alone. */
const MAX_MODELS_BYTES = 1024 * 1024

/**
 * Write the config that points each signed-in api-key tool at its variable
 * (see the module comment). `opencodeConfig` and `pi` are the project's tool
 * homes, opened with `openSandboxDir`. Returns opencode's file, relative to
 * its config dir, for the workspace's `OPENCODE_CONFIG`. Idempotent; a
 * `models.json` that is not valid JSON is left for pi to report.
 */
export async function ensureToolApiKeyConfig(
  homes: { opencodeConfig: ConfinedRoot; pi: ConfinedRoot },
  providers: { opencode?: ToolProviderInfo; pi?: ToolProviderInfo },
): Promise<{ opencodeConfigFile?: string }> {
  let opencodeConfigFile: string | undefined
  if (providers.opencode) {
    const { id } = providers.opencode
    opencodeConfigFile = `yaac-keys/${id}.json`
    const config = { provider: { [id]: { env: [toolApiKeyEnvVar('opencode', id), providers.opencode.envVar] } } }
    await writeIfChanged(homes.opencodeConfig, opencodeConfigFile, JSON.stringify(config, null, 2) + '\n')
  }
  if (providers.pi) {
    const { id, envVar } = providers.pi
    const rel = 'agent/models.json'
    await homes.pi.locked(rel, async () => {
      let models: { providers?: Record<string, { apiKey?: unknown }> }
      try {
        const raw = await homes.pi.readFile(rel, { maxBytes: MAX_MODELS_BYTES })
        models = raw === null ? {} : JSON.parse(raw.toString('utf8')) as typeof models
      } catch {
        return
      }
      if (models.providers?.[id]?.apiKey !== undefined) return
      const apiKey = `!printenv ${toolApiKeyEnvVar('pi', id)} || printenv ${envVar}`
      const next = { ...models, providers: { ...models.providers, [id]: { ...models.providers?.[id], apiKey } } }
      await homes.pi.writeAtomic(rel, JSON.stringify(next, null, 2) + '\n')
    })
  }
  return opencodeConfigFile !== undefined ? { opencodeConfigFile } : {}
}

async function writeIfChanged(home: ConfinedRoot, rel: string, content: string): Promise<void> {
  const current = await home.readFile(rel, { maxBytes: MAX_MODELS_BYTES }).catch(() => null)
  if (current?.toString('utf8') !== content) await home.writeAtomic(rel, content)
}
