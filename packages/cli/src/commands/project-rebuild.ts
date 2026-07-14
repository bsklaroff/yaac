import { api } from '#commands/api'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'

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
  const res = await api.project[':slug'].rebuild.$post({ param: { slug: projectSlug } })

  const result = await consumeNdjsonStream<RebuildResult>(res)
  console.log(`Rebuilt ${result.projectSlug} → ${result.finalTag}`)
}
