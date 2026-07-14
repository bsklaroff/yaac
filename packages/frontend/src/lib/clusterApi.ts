import { rpc } from './rpc'
import type { CheckResult, ClusterSetupEvent } from '@yaac/shared/types'

/** Is the cluster ready for sessions, and the per-check breakdown. */
export function getClusterCheck(): Promise<{ ok: boolean; results: CheckResult[] }> {
  return rpc.cluster.check.$get().then((r) => r.json())
}

/**
 * Run `cluster setup` and consume its NDJSON progress stream (progress →
 * result | error). Calls `onProgress` per line; resolves with the setup's
 * final verdict or throws the server's error message.
 */
export async function streamClusterSetup(onProgress: (line: string) => void): Promise<boolean> {
  const res = await fetch('/cluster/setup', { method: 'POST', credentials: 'same-origin' })
  if (!res.ok || !res.body) throw new Error(`setup failed (HTTP ${res.status})`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let ok: boolean | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const event = JSON.parse(line) as ClusterSetupEvent
      if (event.type === 'progress') onProgress(event.message)
      else if (event.type === 'result') ok = event.ok
      else if (event.type === 'error') throw new Error(event.error.message)
    }
  }

  if (ok === null) throw new Error('setup returned no result')
  return ok
}
