import { workspaceDriver } from '#drivers/driver'
import { shellQuote } from '#lib/shell'

/**
 * Git queries for the file explorer, run inside the running workspace
 * (docs/file-editor.md). The checkout's git dir belongs to the workspace (the
 * agent can edit its config), so the server never runs git against it on the
 * host (docs/server-git.md).
 */

/** Ends each section of the listing script's NUL-separated output. */
const SECTION = '@@yaac-section@@'

export interface CheckoutListing {
  /** Tracked and untracked files, gitignore-aware, minus those deleted from
   *  disk. */
  paths: string[]
  /** Ignored files, and each wholly ignored folder as one `dir/` entry. */
  ignored: string[]
  /** Untracked folders, one entry each, without the trailing slash. This is
   *  the only way git reports a folder with no files in it. */
  untrackedDirs: string[]
  /** Files with an unresolved merge conflict. */
  conflicted: string[]
}

/**
 * List a running workspace's checkout in one exec: five `ls-files`, each
 * ended by a section marker, so a run that died partway has too few sections
 * to pass for an empty checkout. `ls-files` only reads the index, so it
 * never writes underneath the agent's own git.
 */
export async function listCheckoutFiles(jobName: string): Promise<CheckoutListing> {
  const driver = workspaceDriver()
  const commands = [
    'ls-files -z --cached --others --exclude-standard',
    'ls-files -z --deleted',
    'ls-files -z --others --ignored --exclude-standard --directory',
    'ls-files -z --others --exclude-standard --directory',
    'ls-files -z --unmerged',
  ]
  const script = [`cd ${driver.workspacePaths(jobName).workspaceDir} || exit 3`,
    ...commands.map((c) => `git ${c} || exit 4; printf '\\000${SECTION}\\000'`)].join('\n')
  const { stdout } = await driver.exec(jobName, script, { timeout: 20_000 })
  const sections: string[][] = [[]]
  for (const entry of stdout.split('\0')) {
    if (entry === SECTION) sections.push([])
    else if (entry !== '') sections[sections.length - 1].push(entry)
  }
  if (sections.length !== commands.length + 1) {
    throw new Error('checkout listing: the script ended partway')
  }
  const [listed, deleted, ignored, untrackedDirs, unmerged] = sections
  const gone = new Set(deleted)
  return {
    // A conflicted file is listed once per index stage.
    paths: [...new Set(listed)].filter((p) => !gone.has(p)),
    ignored,
    untrackedDirs: untrackedDirs.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)),
    // `<mode> <object> <stage>\t<path>`, one entry per conflict stage.
    conflicted: [...new Set(unmerged.map((e) => e.slice(e.indexOf('\t') + 1)))],
  }
}

/**
 * How far a running workspace's HEAD has diverged from `base`: commits on
 * HEAD and not on the base (`ahead`), and the reverse (`behind`). The base
 * is `origin/<base>`, else the local `<base>` for a branch that was never
 * pushed, as the changes diff resolves it; null when neither exists or
 * `base` is not a plain branch name.
 */
export async function checkoutAheadBehind(
  jobName: string,
  base: string,
): Promise<{ ref: string; ahead: number; behind: number; remote: boolean } | null> {
  // Git's ref-name rules; also stops `base` from being read as a range.
  if (!/^[^\s~^:?*[\\]+$/.test(base) || base.includes('..') || base.includes('@{')) return null
  const driver = workspaceDriver()
  // `--` stops a same-named file from turning a bad revision into a pathspec.
  const script = `cd ${driver.workspacePaths(jobName).workspaceDir} || exit 3; `
    + 'for ref in "refs/remotes/origin/$1" "refs/heads/$1"; do '
    + 'n=$(git rev-list --left-right --count "$ref...HEAD" -- 2>/dev/null) && { echo "$ref $n"; exit 0; }; '
    + 'done; exit 0'
  const { stdout } = await driver.exec(jobName, `sh -c ${shellQuote(script)} yaac ${shellQuote(base)}`)
  const [ref, behind, ahead] = stdout.trim().split(/\s+/)
  if (!ref) return null
  const remote = ref.startsWith('refs/remotes/')
  return { ref: remote ? `origin/${base}` : base, ahead: Number(ahead), behind: Number(behind), remote }
}

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
