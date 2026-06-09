import { getRpcClient, toClientError } from '@/commands/rpc'

interface RebuildResult {
  projectSlug: string
  finalTag: string
}

type StreamEvent =
  | { type: 'progress'; message: string }
  | { type: 'result'; result: RebuildResult }
  | { type: 'error'; error: { code: string; message: string } }

async function consumeRebuildStream(res: Response): Promise<RebuildResult> {
  if (!res.body) throw new Error('daemon returned an empty response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let result: RebuildResult | null = null
  const handle = (line: string): void => {
    if (!line) return
    const event = JSON.parse(line) as StreamEvent
    if (event.type === 'progress') console.log(event.message)
    else if (event.type === 'result') result = event.result
    else if (event.type === 'error') throw new Error(event.error.message)
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buf += decoder.decode(value, { stream: true })
    if (done) { buf += decoder.decode(); break }
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) handle(line)
  }
  if (buf) handle(buf)
  if (!result) throw new Error('daemon stream ended without a result event')
  return result
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

  const result = await consumeRebuildStream(res)
  console.log(`Rebuilt ${result.projectSlug} → ${result.finalTag}`)
}
