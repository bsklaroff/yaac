import { getRpcClient, toClientError } from '@/commands/rpc'

interface PromoteResult {
  sessionId: string
  projectSlug: string
  imageRef: string
  exitCode: number
}

type StreamEvent =
  | { type: 'progress'; message: string }
  | { type: 'result'; result: PromoteResult }
  | { type: 'error'; error: { code: string; message: string } }

/**
 * Read the NDJSON event stream returned by `POST /session/promote`, printing
 * each promoter log line as it arrives and returning the terminal `result`.
 * Throws with the daemon's message on an `error` event or a stream that ends
 * without a result.
 */
async function consumePromoteStream(res: Response): Promise<PromoteResult> {
  if (!res.body) throw new Error('daemon returned an empty response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let result: PromoteResult | null = null
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
 * CLI entry point for `yaac session promote`. Runs the image-cache promoter
 * for a single session by id (full or unique prefix) and streams its output
 * to the console. A debugging aid for the nestedContainers shared-image
 * cache: production runs the very same promoter (`promoteSessionImages`)
 * silently during session teardown, so this is the way to watch a promotion
 * happen and see why a copy did or didn't land.
 */
export async function sessionPromote(idOrName: string): Promise<void> {
  const client = await getRpcClient()
  const res = await client.session.promote.$post({ json: { sessionId: idOrName } })
  if (!res.ok) throw await toClientError(res)

  const result = await consumePromoteStream(res)
  if (result.exitCode !== 0) {
    console.error(`Promoter exited with code ${result.exitCode}.`)
    process.exitCode = result.exitCode
  }
}
