import { getRpcClient, toClientError } from '@/commands/rpc'
import { consumeNdjsonStream } from '@/shared/ndjson'

interface RebuildResult {
  projectSlug: string
  finalTag: string
}

/**
 * CLI entry point for `yaac project rebuild`. Forces a `--no-cache` rebuild
 * of the project's tools layer (and every downstream layer) so upstream
 * agent CLI versions (Claude Code, codex, opencode, chrome-devtools-mcp) get
 * re-fetched. The slow system base layer is left alone.
 */
export async function projectRebuild(projectSlug: string): Promise<void> {
  const client = await getRpcClient()
  const res = await client.project[':slug'].rebuild.$post({ param: { slug: projectSlug } })
  if (!res.ok) throw await toClientError(res)

  const result = await consumeNdjsonStream<RebuildResult>(res)
  console.log(`Rebuilt ${result.projectSlug} → ${result.finalTag}`)
}
