import { workspaceDriver } from '#drivers/driver'
import { shellQuote } from '#lib/shell'

/**
 * Git reads for the file editor, run inside the running workspace
 * (docs/file-editor.md). The checkout's git dir belongs to the workspace (the
 * agent can edit its config), so the server never runs git against it on the
 * host (docs/server-git.md).
 */

/**
 * A blob's bytes at `rev:path` in a running workspace's checkout, or what
 * stands in for them: `absent` when that commit has no file there, `large`
 * when it is over `maxBytes`. The bytes cross `exec` as base64, since its
 * stdout is decoded as text.
 */
export async function checkoutBlobAt(
  jobName: string,
  rev: string,
  relPath: string,
  maxBytes: number,
): Promise<Buffer | 'absent' | 'large'> {
  const driver = workspaceDriver()
  const script = `cd ${driver.workspacePaths(jobName).workspaceDir} || exit 3; `
    + 'obj="$1:$2"; '
    + '[ "$(git cat-file -t "$obj" 2>/dev/null)" = blob ] || { echo absent; exit 0; }; '
    + 'size=$(git cat-file -s "$obj") || exit 4; '
    + `[ "$size" -gt ${maxBytes} ] && { echo large; exit 0; }; `
    + 'echo blob; git cat-file blob "$obj" | base64'
  const { stdout } = await driver.exec(jobName, `sh -c ${shellQuote(script)} yaac ${shellQuote(rev)} ${shellQuote(relPath)}`)
  const newline = stdout.indexOf('\n')
  const kind = stdout.slice(0, newline === -1 ? undefined : newline).trim()
  if (kind === 'absent' || kind === 'large') return kind
  if (kind !== 'blob') throw new Error(`checkout blob read: unexpected output ${JSON.stringify(kind)}`)
  return Buffer.from(stdout.slice(newline + 1), 'base64')
}
