/**
 * Consumer side of the server's NDJSON operation streams
 * (`POST /session/create`, `POST /session/restart`,
 * `POST /project/:slug/rebuild`): zero or more `{type:'progress'}` events
 * followed by exactly one terminal `{type:'result'}` or `{type:'error'}`.
 *
 * Browser-safe on purpose (no node imports) — the webapp consumes the same
 * streams as the CLI.
 */

type NdjsonEvent<T> =
  | { type: 'progress'; message: string }
  | { type: 'result'; result: T }
  | { type: 'error'; error: { code: string; message: string } }

/**
 * Read an NDJSON event stream, invoking `onProgress` per progress event
 * (default: print to the console, the CLI behavior) and returning the
 * terminal `result` payload. Throws with the server's message if the stream
 * carries an `error` event or ends without a result. A trailing line without
 * a final newline is still processed.
 */
export async function consumeNdjsonStream<T>(
  res: Response,
  onProgress: (message: string) => void = (message) => { console.log(message) },
): Promise<T> {
  if (!res.body) throw new Error('server returned an empty response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  // Boxed so a result payload that is itself falsy still counts as terminal.
  let result: { value: T } | null = null
  const handle = (line: string): { value: T } | null => {
    if (!line) return null
    const event = JSON.parse(line) as NdjsonEvent<T>
    if (event.type === 'progress') onProgress(event.message)
    else if (event.type === 'result') return { value: event.result }
    else if (event.type === 'error') throw new Error(event.error.message)
    return null
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buf += decoder.decode(value, { stream: true })
    if (done) {
      buf += decoder.decode()
      break
    }
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) result = handle(line) ?? result
  }
  if (buf) result = handle(buf) ?? result
  if (!result) throw new Error('server stream ended without a result event')
  return result.value
}
