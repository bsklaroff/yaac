import {
  insertCustomEndpoint,
  listCustomEndpoints,
  listToolCredentials,
  setToolCredential,
  updateCustomEndpoint,
  type CustomEndpointRow,
} from '#db'
import { serverLog } from '#lib/log'
import { API_KEY_TOOLS, CUSTOM_PROVIDER } from '@yaac/shared/tool-providers'

/**
 * Move each custom sign-in that still carries its endpoint (URL, model ids
 * and key, written before endpoints were their own rows) onto a custom
 * endpoint of its owner's, and point the sign-in at it. Sign-ins of one
 * owner that share a URL and key share one endpoint, listing every model
 * any of them did. Runs at server start, before anything reads a sign-in;
 * idempotent (docs/legacy-compat-shims.md).
 */
export async function importEmbeddedEndpoints(): Promise<void> {
  for (const [owner, bundle] of Object.entries(await listToolCredentials())) {
    let endpoints: CustomEndpointRow[] | undefined
    for (const tool of API_KEY_TOOLS) {
      const file = bundle[tool]
      if (file?.provider !== CUSTOM_PROVIDER || file.endpointId !== undefined || file.endpoint === undefined) continue
      endpoints ??= await listCustomEndpoints(owner)
      const { baseUrl, models: ids = [] } = file.endpoint
      let row = endpoints.find((e) => e.baseUrl === baseUrl && e.apiKey === file.apiKey)
      if (row === undefined) {
        const host = new URL(baseUrl).hostname
        let name = host
        for (let n = 2; endpoints.some((e) => e.name === name); n++) name = `${host}-${n}`
        row = await insertCustomEndpoint({ owner, name, baseUrl, apiKey: file.apiKey, models: [] })
        endpoints.push(row)
      }
      const missing = ids.filter((id) => !row.models.some((m) => m.id === id))
      if (missing.length > 0) {
        row.models = [...row.models, ...missing.map((id) => ({ id }))]
        await updateCustomEndpoint(row.id, { models: row.models })
      }
      await setToolCredential(owner, tool, {
        kind: 'api-key', provider: file.provider, apiKey: '', savedAt: file.savedAt, endpointId: row.id,
      })
      serverLog(`[server] moved ${tool}'s custom endpoint ${baseUrl} to the custom endpoint "${row.name}"`)
    }
  }
}
