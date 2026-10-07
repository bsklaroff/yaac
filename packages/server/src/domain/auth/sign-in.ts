import { fanOutToolCredentials, runtimeMediatesEgress } from './credential-sync'
import { pushCredentialsToRuntime } from './runtime-push'
import { persistToolAuthPayload } from './store'
import type { AgentTool, ToolAuthPayload } from '@yaac/shared/types'

/**
 * Store a user's sign-in for a tool (`PUT /auth/:tool`) and hand it to
 * everything that holds a copy: each of their projects' tool homes, which
 * agents read (a sentinel the proxy swaps, or the real bundle without one),
 * and the runtime.
 */
export async function signInTool(owner: string, tool: AgentTool, payload: ToolAuthPayload): Promise<void> {
  await persistToolAuthPayload(owner, tool, payload)
  await fanOutToolCredentials(owner, tool, { mediatedEgress: runtimeMediatesEgress() })
  await pushCredentialsToRuntime()
}
