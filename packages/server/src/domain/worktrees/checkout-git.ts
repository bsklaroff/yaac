import { worktreeDriver } from '#drivers/driver'
import { shellQuote } from '#lib/shell'
import type { FileStatus } from '@yaac/shared/types'

/**
 * What the file explorer asks of a checkout's git, asked INSIDE the running
 * workspace (docs/file-editor.md). A checkout's git dir is the workspace's
 * own: the agent writes its config, and the server never runs git against it
 * after creating it (docs/server-git.md). Whatever the workspace's git runs,
 * it runs there, as the workspace.
 */

/** Ends each section of the listing script's NUL-separated output. */
const SECTION = '@@yaac-section@@'

/** What `listCheckoutFiles` reads off a worktree's checkout. */
export interface CheckoutListing {
  /** Tracked and untracked files, gitignore-aware, minus those deleted from
   *  disk. */
  paths: string[]
  /** Ignored files, and each wholly ignored folder as one `dir/` entry. */
  ignored: string[]
  /** Untracked folders, each collapsed to one entry without its trailing
   *  slash — the only record git keeps of a folder holding no file. */
  untrackedDirs: string[]
  status: Record<string, FileStatus>
}

/**
 * The file list of a running worktree's checkout: four `ls-files` and one
 * `status`, each NUL-separated and ended by a section marker, so one exec
 * answers all of them and a run that died partway has too few sections to
 * pass for an empty checkout.
 *
 * `status` skips submodules outright and takes no optional locks, so its
 * opportunistic index refresh is never written back under the agent's own
 * git.
 */
export async function listCheckoutFiles(jobName: string): Promise<CheckoutListing> {
  const driver = worktreeDriver()
  const commands = [
    'ls-files -z --cached --others --exclude-standard',
    'ls-files -z --deleted',
    'ls-files -z --others --ignored --exclude-standard --directory',
    'ls-files -z --others --exclude-standard --directory',
    '--no-optional-locks status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all',
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
  const [listed, deleted, ignored, untrackedDirs, status] = sections
  const gone = new Set(deleted)
  return {
    // A file both tracked and modified is listed once per index stage when
    // conflicted, so the list is deduplicated too.
    paths: [...new Set(listed)].filter((p) => !gone.has(p)),
    ignored,
    untrackedDirs: untrackedDirs.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)),
    status: parsePorcelainStatus(status),
  }
}

/**
 * How far a running worktree's HEAD has diverged from `base`: commits on
 * HEAD and not on the base (`ahead`), and the reverse (`behind`). The base
 * is `origin/<base>`, else the local `<base>` for a branch that was never
 * pushed, as the Changes diff resolves it; null when neither exists or
 * `base` is not a plain branch name.
 */
export async function checkoutAheadBehind(
  jobName: string,
  base: string,
): Promise<{ ref: string; ahead: number; behind: number; remote: boolean } | null> {
  // Git's own ref-name rules, which also keep `base` from reading as a range.
  if (!/^[^\s~^:?*[\\]+$/.test(base) || base.includes('..') || base.includes('@{')) return null
  const driver = worktreeDriver()
  // `--`: a file of that name in the checkout must not turn an unresolvable
  // revision into a pathspec.
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
 * Map `status --porcelain=v1 -z` entries to one `FileStatus` per path.
 * Staged and unstaged are not told apart, and a deletion is dropped: the
 * explorer only colors files that exist.
 */
function parsePorcelainStatus(entries: string[]): Record<string, FileStatus> {
  const out: Record<string, FileStatus> = {}
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const [x, y, file] = [entry[0], entry[1], entry.slice(3)]
    // A rename or copy is followed by its source path as its own entry.
    if (x === 'R' || x === 'C') i++
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) out[file] = 'conflicted'
    else if (x === '?') out[file] = 'untracked'
    else if (y === 'D') continue
    else if (x === 'A' || x === 'R' || x === 'C' || y === 'A') out[file] = 'added'
    else if (x === 'M' || y === 'M' || x === 'T' || y === 'T') out[file] = 'modified'
  }
  return out
}
