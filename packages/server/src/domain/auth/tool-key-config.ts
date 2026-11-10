import fs from 'node:fs/promises'
import { ompDir, opencodeConfigDir, piDir } from '@yaac/shared/project-paths'
import { ompProviderInfo, opencodeProviderInfo, piProviderInfo } from '@yaac/shared/tool-providers'
import type { ToolAuthEntry } from '@yaac/shared/types'
import { ensureToolApiKeyConfig, openSandboxDir, type KeyProviders } from '#runtime/agents'
import { serverLog } from '#lib/log'
import { loadToolAuthEntry, ownedProjectIds } from './store'

type Entry<T> = Extract<ToolAuthEntry, { tool: T }> | null

/** The api-key tools' providers as the config writer takes them
 *  (`ensureToolApiKeyConfig`): each signed-in tool's provider row, and its
 *  custom endpoint. */
export function toolKeyProviders(auth: { opencode: Entry<'opencode'>; pi: Entry<'pi'>; omp: Entry<'omp'> }): KeyProviders {
  return {
    ...(auth.opencode ? { opencode: { ...opencodeProviderInfo(auth.opencode.opencodeProvider), endpoint: auth.opencode.endpoint } } : {}),
    ...(auth.pi ? { pi: { ...piProviderInfo(auth.pi.piProvider), endpoint: auth.pi.endpoint } } : {}),
    ...(auth.omp ? { omp: { ...ompProviderInfo(auth.omp.ompProvider), endpoint: auth.omp.endpoint } } : {}),
  }
}

/**
 * Rewrite the api-key tools' config in every one of the owner's projects,
 * so an edited custom endpoint reaches agents started from now on without
 * waiting for the project's next create. A project that fails is logged
 * and left for that create.
 */
export async function refreshToolKeyConfigs(owner: string): Promise<void> {
  const [opencode, pi, omp] = await Promise.all([
    loadToolAuthEntry(owner, 'opencode'), loadToolAuthEntry(owner, 'pi'), loadToolAuthEntry(owner, 'omp'),
  ])
  const providers = toolKeyProviders({ opencode, pi, omp })
  for (const projectId of await ownedProjectIds(owner)) {
    try {
      const dirs = [opencodeConfigDir(projectId), piDir(projectId), ompDir(projectId)]
      await Promise.all(dirs.map((d) => fs.mkdir(d, { recursive: true })))
      const [opencodeConfig, piHome, ompHome] = await Promise.all(dirs.map((d) => openSandboxDir(projectId, d)))
      await ensureToolApiKeyConfig({ opencodeConfig, pi: piHome, omp: ompHome }, providers)
    } catch (err) {
      serverLog(`[server] rewriting project "${projectId}"'s api-key tool config failed: ${String(err)}`)
    }
  }
}
