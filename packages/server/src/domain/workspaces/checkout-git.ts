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

/** Field separator in the log's records. */
const FS = '\x1f'
/** Starts each of the log's records, whose body runs over many lines. */
const RS = '\x1e'
/** The most of one commit's body the log carries, and of all its bodies
 *  together, in bytes; a body cut short ends in `…`. Together they keep
 *  the log well under an exec's 4 MiB output cap however long its messages
 *  run, and its 10-second poll small. */
const MAX_BODY_BYTES = 1024
const MAX_BODIES_BYTES = 512 * 1024

/**
 * awk that cuts the log's bodies to `m` bytes each and `t` in all. A record
 * starts at a header line, `r`, a full commit id and `f`; any other line
 * loses its `r` and `f`, so a message can neither start a record nor split
 * a field. A line crossing a cap keeps what fits before the `…`. Past `t`,
 * a body is `…` alone, which still says it has one. A blank line that does
 * not fit is dropped rather than cut, since a commit with no body still
 * prints one.
 */
const CUT_BODIES = 'index($0, r) == 1 && match($0, /^.[0-9a-f]+/) && (RLENGTH == 41 || RLENGTH == 65) '
  + '&& substr($0, RLENGTH + 1, 1) == f { n = 0; c = 0; print; next } '
  + 'c { next } { gsub(r, ""); gsub(f, ""); l = length($0) + 1 } '
  + 'n + l <= m && b + l <= t { print; n += l; b += l; next } l == 1 { next } '
  + '{ k = m - n; if (t - b < k) k = t - b; if (k > 1) print substr($0, 1, k - 1); print "…"; c = 1; if (k > 0) b += k }'

/**
 * The Commits pane's history (`WorkspaceGitLog`): up to `limit` commits
 * reachable from HEAD or the base ref, each with its message's body. The
 * ref is checked by the changes script's own `RESOLVE_BASE_SH`, so the pane
 * and the git status strip always name the same one; a base that shares no
 * history with HEAD leaves the log to HEAD alone. Bodies are cut inside the
 * workspace (`CUT_BODIES`); a commit's pane shows its whole message.
 */
export async function checkoutLog(
  jobName: string,
  { defaultBase, limit }: { defaultBase?: string; limit: number },
): Promise<WorkspaceGitLog> {
  const driver = workspaceDriver()
  const { workspaceDir, scratchDir } = driver.workspacePaths(jobName)
  const script = `cd ${workspaceDir} || exit 3; ${RESOLVE_BASE_SH}`
    + 'sha=; [ -z "$ref" ] || sha=$(git rev-parse -q --verify "$ref^{commit}") || exit 5; '
    // An unborn HEAD (a new orphan branch) has no history of its own.
    + 'head=$(git rev-parse -q --verify HEAD); '
    + 'printf "REF %s\\nHEAD %s\\nLOG\\n" "$ref" "$head"; '
    + `[ -z "$head$sha" ] && exit 0; o=${scratchDir}/yaac-log.$$; `
    + 'git log --date-order -n "$3" --decorate-refs-exclude=refs/remotes/origin/HEAD '
    + `--format="${RS}%H${FS}%P${FS}%an${FS}%at${FS}%D${FS}%s%n%b" $head $sha -- > $o || { rm -f $o; exit 5; }; `
    + `LC_ALL=C awk -v r="$(printf '\\036')" -v f="$(printf '\\037')" -v m=${MAX_BODY_BYTES} -v t=${MAX_BODIES_BYTES} `
    + `${shellQuote(CUT_BODIES)} $o; rm -f $o`
  const { stdout } = await driver.exec(
    jobName,
    `sh -c ${shellQuote(script)} yaac '' ${shellQuote(defaultBase ?? '')} ${limit + 1}`,
  )
  const split = stdout.indexOf('\nLOG\n')
  const [refLine = '', headLine = ''] = stdout.slice(0, split).split('\n')
  if (!refLine.startsWith('REF ') || !headLine.startsWith('HEAD ')) throw new Error('checkout log read: unexpected output')
  // A record starts at a line opening with RS; one inside a subject stays.
  const commits = stdout.slice(split + '\nLOG'.length).split(`\n${RS}`).slice(1).map((record) => {
    // A commit with no body is its header line alone.
    const [header = '', ...body] = record.split('\n')
    // The subject is last, so a separator in it stays part of it.
    const [sha = '', parents = '', author = '', time = '', refs = '', ...subject] = header.split(FS)
    return {
      sha,
      parents: parents ? parents.split(' ') : [],
      author,
      time: Number(time),
      subject: subject.join(FS),
      body: body.join('\n').trim(),
      refs: refs ? refs.split(', ') : [],
    }
  })
  return {
    ref: refLine.slice('REF '.length) || null,
    head: headLine.slice('HEAD '.length) || null,
    commits: commits.slice(0, limit),
    more: commits.length > limit,
  }
}
