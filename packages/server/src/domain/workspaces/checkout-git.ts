import { workspaceDriver } from '#drivers/driver'
import { shellQuote } from '#lib/shell'
import type { WorkspaceGitLog } from '@yaac/shared/types'
import { RESOLVE_BASE_SH } from './changes'

/**
 * Git reads for the file editor and the Commits pane, run inside the
 * running workspace (docs/file-editor.md). The checkout's git dir belongs to the workspace (the
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

/** Field separator in the log's records, which are NUL-terminated. */
const FS = '\x1f'

/**
 * The Commits pane's history (`WorkspaceGitLog`): up to `limit` commits
 * reachable from HEAD or the compared branch, and with `branches` the
 * checkout's branches. The branch is picked by the changes script's own
 * `RESOLVE_BASE_SH`, so the pane and the git status strip always name the
 * same ref. A named branch it cannot use exits CHANGES_BASE_UNRESOLVED; a
 * default it cannot use leaves the log to HEAD alone.
 */
export async function checkoutLog(
  jobName: string,
  { base, defaultBase, limit, branches }: { base?: string; defaultBase?: string; limit: number; branches: boolean },
): Promise<WorkspaceGitLog> {
  const driver = workspaceDriver()
  const script = `cd ${driver.workspacePaths(jobName).workspaceDir} || exit 3; ${RESOLVE_BASE_SH}`
    + 'sha=; [ -z "$ref" ] || sha=$(git rev-parse -q --verify "$ref^{commit}") || exit 5; '
    // An unborn HEAD (an empty repo's checkout) has no history of its own.
    + 'head=$(git rev-parse -q --verify HEAD); '
    + 'printf "REF %s\\nHEAD %s\\n" "$ref" "$head"; '
    + '[ "$4" != 1 ] || git for-each-ref --format="%(refname)" refs/heads refs/remotes/origin || exit 5; '
    + 'printf "LOG\\n"; '
    + '[ -z "$head$sha" ] || exec git log -z --date-order -n "$3" --decorate-refs-exclude=refs/remotes/origin/HEAD '
    + `--format="%H${FS}%P${FS}%an${FS}%at${FS}%D${FS}%s" $head $sha --`
  const { stdout } = await driver.exec(
    jobName,
    `sh -c ${shellQuote(script)} yaac ${shellQuote(base ?? '')} ${shellQuote(defaultBase ?? '')} ${limit + 1} ${branches ? 1 : 0}`,
  )
  const split = stdout.indexOf('\nLOG\n')
  const [refLine = '', headLine = '', ...refnames] = stdout.slice(0, split).split('\n')
  if (!refLine.startsWith('REF ') || !headLine.startsWith('HEAD ')) throw new Error('checkout log read: unexpected output')
  const commits = stdout.slice(split + '\nLOG\n'.length).split('\0').filter((r) => r !== '').map((record) => {
    const [sha = '', parents = '', author = '', time = '', refs = '', subject = ''] = record.replace(/^\n/, '').split(FS)
    return {
      sha,
      parents: parents ? parents.split(' ') : [],
      author,
      time: Number(time),
      subject,
      refs: refs ? refs.split(', ') : [],
    }
  })
  return {
    ref: refLine.slice('REF '.length) || null,
    head: headLine.slice('HEAD '.length) || null,
    ...(branches ? {
      branches: refnames.flatMap((r) => {
        if (r.startsWith('refs/heads/')) return [r]
        const name = r.slice('refs/remotes/'.length)
        return name === 'origin/HEAD' ? [] : [name]
      }),
    } : {}),
    commits: commits.slice(0, limit),
    more: commits.length > limit,
  }
}
