/**
 * Typed Hono RPC client for the launcher — the desktop twin of
 * `getRpcClient` in @yaac/shared/server-client, minus that module's Node
 * target resolution (fs reads) and retry logic, neither of which exists in
 * a webview. The fetch implementation is injected; the real app passes
 * @tauri-apps/plugin-http's fetch (see #deps).
 */
import { hc } from 'hono/client'
import type { AppType } from '@yaac/server/server'
import type { ServerTarget } from '@yaac/shared/server-client'

export function makeServerClient(
  fetchImpl: typeof globalThis.fetch,
  target: ServerTarget,
) {
  return hc<AppType>(target.baseUrl, {
    fetch: fetchImpl,
    headers: { authorization: `Bearer ${target.secret}` },
  })
}

export type ServerClient = ReturnType<typeof makeServerClient>
