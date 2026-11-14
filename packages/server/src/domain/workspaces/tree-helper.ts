/**
 * `yaac-files`: the file editor's operations run inside a k8s workspace
 * (`tree-ops.ts`), built into a self-contained script that ships with the
 * other `workspace-bin` helpers. It reads one `TreeRequest` as JSON on
 * stdin and prints one JSON answer: `{ result }`, `{ error: { code,
 * message } }` for a refusal the caller can act on, `{ noTree: true }` when
 * the workspace dir cannot be opened, or `{ fault }` for anything else. It
 * always exits 0 once it has answered, so the answer is never mistaken for
 * a transport failure.
 *
 * It runs as the agent, in the agent's sandbox, so it can do nothing the
 * agent could not; the server treats what it prints as agent-written.
 */
import { ServerError } from '@yaac/shared/errors'
import { NoTreeError, runTreeRequest, type TreeRequest } from './tree-ops'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  let answer: unknown
  try {
    // An operation that answers nothing answers null, so the key survives.
    answer = { result: await runTreeRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')) as TreeRequest) ?? null }
  } catch (err) {
    answer = err instanceof ServerError
      ? { error: { code: err.code, message: err.message } }
      : err instanceof NoTreeError ? { noTree: true } : { fault: err instanceof Error ? err.message : String(err) }
  }
  process.stdout.write(JSON.stringify(answer))
}

void main()
