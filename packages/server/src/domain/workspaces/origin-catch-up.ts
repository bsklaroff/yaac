/**
 * Moving a checkout to its branch's tip on origin (docs/server-git.md
 * "Starting a workspace"). A workspace starts at the commit its repo's main
 * clone already has (`pickStart`), so its start never waits on the network,
 * and catches up once it is up and the start's fetch has landed. The same
 * move takes a spare to a new tip or to another branch.
 *
 * The move runs inside the workspace, as the agent's own user: the server
 * resolves the target commit from the main clone, whose objects the
 * checkout borrows, and never runs git on a checkout itself.
 */
import path from 'node:path'
import { workspaceDriver } from '#drivers/driver'
import { applyWorkspaceEvent, getProjectRow, type ProjectRow } from '#db'
import { resolveRemoteRef } from '#domain/git'
import { errorText, serverLog } from '#lib/log'
import { shellEscape, shellQuote } from '#lib/shell'
import { repoDir } from '@yaac/shared/project-paths'

/** How long after its agent launched a workspace still catches up with a
 *  fetch that lands. A later fetch leaves it behind origin. */
export const CATCH_UP_WAIT_MS = 5_000

/** A move can rewrite a whole tree, so a command carrying one gets longer
 *  than an exec's default. */
export const MOVE_TIMEOUT_MS = 120_000

/** One checkout of a starting workspace, and the branch of origin it
 *  follows. */
export interface Following {
  repoId: string
  /** Where it sits under the workspace root: `''` or its folder. */
  path: string
  branch: string
  /** The commit it was started at. */
  at: string
  /** The start's fetch of its repo's main clone. */
  fetched: Promise<void>
}

/** How a checkout is named in what is said about it. */
const label = (f: Following): string => (f.path === '' ? 'the checkout' : f.path)

/** One checkout's move, at `dir` as its workspace sees it. */
interface CheckoutMove {
  dir: string
  branch: string
  target: string
  /**
   * What to do where git refuses the fast-forward:
   * - `reset`: reset to the target and remove untracked files. For a spare,
   *   which nothing has touched and nothing runs in.
   * - `untouchedAt`: reset only a checkout still on that commit, the one it
   *   was put at, with nothing modified or untracked. For a workspace in
   *   which nothing runs yet: the test and the reset are separate
   *   processes, so a file written between them would be lost.
   * - `leave`: leave the checkout as it is. For a workspace whose agent or
   *   steps may be running.
   */
  otherwise: 'reset' | { untouchedAt: string } | 'leave'
  /** Make `origin/<branch>` the checked-out branch's upstream: a spare
   *  moving to another branch. */
  retrack?: boolean
}

/** Starts the line a move prints: the commit its checkout ended at. */
const ENDED_AT = 'yaac-at:'

/**
 * The paths under a checkout at `dir` that are mount points (its scratch
 * dirs, and cache volumes inside it), as `git clean` exclusions: removing
 * one fails with EBUSY.
 */
function mountExclusions(project: Pick<ProjectRow, 'scratchDirs' | 'cacheVolumes'> | undefined, dir: string): string {
  const inside = Object.values(project?.cacheVolumes ?? {})
    .flatMap((p) => (p.startsWith(`${dir}/`) ? [p.slice(dir.length + 1)] : []))
  return [...(project?.scratchDirs.dirs.map((d) => d.path) ?? []), ...inside]
    .map((p) => ` -e '${shellEscape(p)}'`).join('')
}

/**
 * The shell command that moves a checkout to `target` if that is safe, and
 * prints where it ended up. It fast-forwards, which git refuses when the
 * checkout has commits of its own or a change the incoming commits would
 * overwrite. Where git refuses (a force-pushed branch, another branch),
 * `otherwise` says whether the checkout is reset or left as it is.
 *
 * `origin/<branch>` is set to the target either way: the checkout's own
 * copy may be older, and a refresh from the main clone never follows a
 * force-push (`buildOriginRefreshExec`). Hooks are off for the merge, so a
 * `post-merge` hook (a package install, say) does not run on the server's
 * say-so; a reset runs none. The untouched test names its own untracked
 * and submodule modes, so no git config can narrow it. The command always
 * succeeds, so it can ride the one that opens a window.
 */
function moveCommand(move: CheckoutMove, exclusions: string): string {
  const git = `git -C ${shellQuote(move.dir)}`
  const quiet = '>/dev/null 2>&1'
  const upstream = `origin/${shellEscape(move.branch)}`
  const head = `$(${git} rev-parse -q --verify HEAD)`
  const reset = `${git} reset --hard ${move.target} ${quiet}`
  const otherwise = move.otherwise === 'leave' ? ''
    : move.otherwise === 'reset' ? ` || { ${reset} && ${git} clean -fd${exclusions} ${quiet}; }`
      : ` || { [ "${head}" = ${move.otherwise.untouchedAt} ]`
        + ` && [ -z "$(${git} status --porcelain --untracked-files=all --ignore-submodules=none 2>&1)" ] && ${reset}; }`
  return `{ ${git} update-ref 'refs/remotes/${upstream}' ${move.target} ${quiet}; `
    + (move.retrack === true ? `${git} branch --set-upstream-to '${upstream}' ${quiet}; ` : '')
    + `${git} -c core.hooksPath=/dev/null merge --ff-only ${move.target} ${quiet}${otherwise}; `
    + `echo "${ENDED_AT}${head}"; }`
}

/** Run moves in a workspace, in one exec, and answer what they printed. */
async function runMoves(jobName: string, cmds: string[]): Promise<string> {
  return (await workspaceDriver().exec(jobName, cmds.join('; '), { timeout: MOVE_TIMEOUT_MS })).stdout
}

/** The commit each move's checkout ended at, in the moves' order. */
function endedAt(stdout: string): string[] {
  return stdout.split('\n').flatMap((l) => (l.startsWith(ENDED_AT) ? [l.slice(ENDED_AT.length).trim()] : []))
}

/**
 * Move a spare's checkouts, each to a commit of a branch: to a new tip in
 * the background, or to what a claim starts with. Nothing has touched a
 * spare, so each ends at its target or this throws, and the caller reaps
 * the spare.
 */
export async function moveSpare(
  spare: { jobName: string; projectId: string },
  moves: Array<{ dir: string; branch: string; target: string; retrack?: boolean }>,
): Promise<void> {
  const project = await getProjectRow(spare.projectId)
  const ended = endedAt(await runMoves(spare.jobName, moves.map((m) => moveCommand({ ...m, otherwise: 'reset' }, mountExclusions(project, m.dir)))))
  for (const [i, m] of moves.entries()) {
    if (ended[i] !== m.target) throw new Error(`the checkout at ${m.dir} is at ${ended[i] || 'no commit'}, not ${m.target}`)
  }
}

/** A workspace's catch-up with the fetches that have landed. */
export interface CatchUp {
  /** The moves, as commands to run in the workspace; none when every
   *  checkout is current. */
  cmds: string[]
  /** Take what the command carrying them printed: a checkout that reached
   *  its target starts there from now on, and one that did not is said.
   *  Resolves with what else was printed. */
  settle: (stdout: string) => Promise<string>
  /** The checkouts whose fetch is still running. */
  waiting: Following[]
}

/**
 * Work out a workspace's catch-up: for each checkout whose fetch lands
 * within `withinMs`, a move to where origin now has its branch, if that is
 * not where it started. The caller runs the commands, with the command
 * that opens the agent's window when they are ready by then. A fetch that
 * failed, or a branch origin no longer has, leaves the checkout where it
 * started, which is said through `say`.
 *
 * `live` says an agent or a step may already be running in the workspace.
 * Then a checkout is only ever fast-forwarded, and one git cannot
 * fast-forward (a force-pushed branch) is left behind origin. With nothing
 * running yet, such a checkout is reset if it is untouched.
 */
export async function catchUp(
  workspace: { projectId: string; workspaceId: string; jobName: string },
  following: Following[],
  withinMs: number,
  say: (message: string) => void,
  { live }: { live: boolean },
): Promise<CatchUp> {
  const { projectId, workspaceId, jobName } = workspace
  const waiting: Following[] = []
  const due = (await Promise.all(following.map(async (f) => {
    const landed = await settledWithin(f.fetched, withinMs)
    if (landed === 'pending') {
      waiting.push(f)
      return []
    }
    if (landed !== 'landed') {
      say(`${label(f)} starts from the last commit fetched: ${errorText(landed)}`)
      return []
    }
    const target = await resolveRemoteRef(repoDir(f.repoId), f.branch).catch(() => undefined)
    if (target === undefined) say(`${label(f)} stays on ${f.branch}, which origin no longer has`)
    return target === undefined || target === f.at ? [] : [{ f, target }]
  }))).flat()
  if (due.length === 0) return { cmds: [], settle: (stdout) => Promise.resolve(stdout), waiting }
  const { workspaceDir } = workspaceDriver().workspacePaths(jobName)
  return {
    cmds: due.map(({ f, target }) => {
      const dir = path.posix.join(workspaceDir, f.path)
      return moveCommand({ dir, branch: f.branch, target, otherwise: live ? 'leave' : { untouchedAt: f.at } }, '')
    }),
    settle: async (stdout) => {
      const ended = endedAt(stdout)
      for (const [i, { f, target }] of due.entries()) {
        if (ended[i] !== target) {
          say(`${label(f)} is left at ${(ended[i] || f.at).slice(0, 12)}, behind origin/${f.branch}: it could not be moved there safely`)
          continue
        }
        await applyWorkspaceEvent({ type: 'start-commit-resolved', projectId, workspaceId, repoId: f.repoId, startCommit: target })
      }
      return stdout.split('\n').filter((l) => !l.startsWith(ENDED_AT)).join('\n')
    },
    waiting,
  }
}

/**
 * Catch a launched workspace up with the fetches still running, in the
 * background, each checkout on its own repo's fetch: one whose fetch lands
 * within `CATCH_UP_WAIT_MS` is fast-forwarded, and any other stays behind
 * origin, which is logged.
 */
export function followOrigin(
  workspace: { projectId: string; workspaceId: string; jobName: string },
  following: Following[],
): void {
  const say = (message: string): void => { serverLog(`[workspace] ${workspace.workspaceId}: ${message}`) }
  for (const f of following) {
    void (async () => {
      const { cmds, settle, waiting } = await catchUp(workspace, [f], CATCH_UP_WAIT_MS, say, { live: true })
      if (waiting.length > 0) {
        say(`${label(f)} is left behind origin/${f.branch}: the fetch took longer than ${String(CATCH_UP_WAIT_MS / 1000)}s`)
      }
      if (cmds.length > 0) await settle(await runMoves(workspace.jobName, cmds))
    })().catch((err: unknown) => { say(`catching up with origin failed: ${errorText(err)}`) })
  }
}

/** How a fetch stands `withinMs` from now: landed, still running, or what
 *  it failed with. */
async function settledWithin(fetched: Promise<void>, withinMs: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      fetched.then(() => 'landed', (err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
      new Promise<'pending'>((r) => { timer = setTimeout(() => { r('pending') }, withinMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
