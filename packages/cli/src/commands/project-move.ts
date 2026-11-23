import { api, projectRepoOf, resolveGitCredentialId, resolveProject } from '#commands/api'
import { printTable } from '#commands/table'
import { confirmDefault } from '@yaac/shared/confirm'
import type { UpstreamMoveBranch } from '@yaac/shared/types'

export interface ProjectMoveOptions {
  /** The repo of a project with several. */
  repo?: string
  /** Move a repo on a git host onto yaac (docs/repo-forks.md). */
  hosted?: boolean
  /** Move a fork back onto its upstream. */
  upstream?: boolean
  /** Branches to push to the upstream, each `<branch>[=<name>]`. */
  push?: string[]
  pushAll?: boolean
  leaveRest?: boolean
  /** Skip the confirmation. */
  yes?: boolean
}

/**
 * `yaac project move`: move a project's repo between yaac and a git host
 * (docs/hosted-projects.md "Moving to a git host", docs/repo-forks.md). A
 * move stops every workspace holding a checkout of the repo, so it says
 * what stops and asks first, defaulting to no; with no terminal it needs
 * `--yes`. `--repo` names the repo of a project with several.
 */
export async function projectMove(
  project: string,
  remoteUrl: string | undefined,
  credentialName: string | undefined,
  opts: ProjectMoveOptions = {},
): Promise<void> {
  const ways = [remoteUrl !== undefined, opts.hosted === true, opts.upstream === true].filter(Boolean).length
  if (ways !== 1 || (remoteUrl !== undefined && credentialName === undefined)) {
    throw new Error('Give one of: <remote-url> <credential>, --hosted, or --upstream.')
  }
  const summary = await resolveProject(project)
  const repo = projectRepoOf(summary, opts.repo)
  const name = summary.repos.length > 1 ? `${summary.name}/${repo.dir}` : summary.name
  const param = { repoId: repo.id }
  const confirm = async (question: string): Promise<boolean> => {
    if (opts.yes === true) return true
    // A script reading the exit code must not take a move that never ran
    // for success.
    if (!process.stdin.isTTY) {
      console.error('No terminal to confirm on; pass --yes to move without asking.')
      process.exitCode = 1
      return false
    }
    if (await confirmDefault(question)) return true
    console.log('Aborted — nothing was stopped or moved.')
    return false
  }

  if (opts.hosted === true) {
    const { projects } = await api.repo[':repoId']['host-preview'].$get({ param })
    for (const p of projects) console.log(`  ${p.name}: ${p.workspaces.map((w) => w.slice(0, 8)).join(', ')}`)
    const stopping = projects.reduce((n, p) => n + p.workspaces.length, 0)
    if (!await confirm(`This moves ${name} onto yaac, which then hosts it; ${repo.remoteUrl} becomes its upstream, which `
      + `workspaces fetch and never push. It first stops the ${stopping} running workspace(s) listed above; their `
      + 'checkouts are kept, and push to yaac once restarted. Continue?')) return
    console.log(`Moving ${name} onto yaac...`)
    await api.repo[':repoId'].host.$post({ param })
    console.log(`${name} is now hosted by yaac, a fork of ${repo.remoteUrl}. Its workspaces see that history as upstream/*.`)
    return
  }

  if (opts.upstream === true) {
    const preview = await api.repo[':repoId']['move-preview'].$get({ param, query: { target: 'upstream' } })
    const target = preview.toUpstream
    if (target === undefined) throw new Error('The server did not answer the branches to move.')
    const pushes = upstreamPushes(target.branches, opts)
    if (pushes === null) {
      process.exitCode = 1
      return
    }
    const pushed = pushes.push.map((p) => (p.as !== undefined ? `${p.branch} as ${p.as}` : p.branch))
    if (!await confirm(`This moves ${name} onto ${target.remoteUrl}, pushing ${pushed.length > 0 ? pushed.join(', ') : 'nothing'}`
      + (pushes.leave.length > 0 ? ` and leaving ${pushes.leave.join(', ')} behind where the fork was` : '')
      + `. It first stops ${preview.runningWorkspaces} running workspace(s) holding a checkout of it, whoever owns them.`
      + (preview.sharedWith.length > 0 ? ` Its sharing with ${preview.sharedWith.join(', ')} ends.` : '')
      + ' Continue?')) return
    console.log(`Moving ${name} onto ${target.remoteUrl}...`)
    const { leftAt } = await api.repo[':repoId']['move-upstream'].$post({ param, json: pushes })
    console.log(`${name} now uses ${target.remoteUrl}.`
      + (leftAt !== undefined ? ` The fork stays at ${leftAt}, untouched.`
        : " yaac keeps the fork's repository, read-only, until you remove it in Settings → Repos."))
    return
  }

  const credentialId = await resolveGitCredentialId(credentialName ?? '')
  const { runningWorkspaces, sharedWith } = await api.repo[':repoId']['move-preview'].$get({ param, query: {} })
  if (!await confirm(
    `This moves ${name} to ${remoteUrl}, which must be empty. It first stops ${runningWorkspaces} running `
    + 'workspace(s) that hold a checkout of it, whoever owns them; their checkouts are kept, and push to the new '
    + 'remote once restarted. Nothing can start with it until the move is done.'
    + (sharedWith.length > 0
      ? ` It is shared with ${sharedWith.join(', ')}: each keeps a repo of their own for it, but needs a git `
        + 'credential of their own for the new remote before a workspace can start with it.'
      : '')
    + ' yaac keeps its copy of the repository, read-only, until you remove it in Settings → Repos. Continue?',
  )) return
  console.log(`Moving ${name} to ${remoteUrl}...`)
  const { knownHostsEntry } = await api.repo[':repoId'].move.$post({ param, json: { remoteUrl: remoteUrl ?? '', credentialId } })
  if (knownHostsEntry !== null) console.log(`Host key trusted: ${knownHostsEntry}`)
  console.log(`${name} now uses ${remoteUrl}. Once you have checked it has every branch and tag, `
    + "remove yaac's copy of the repository in Settings → Repos.")
}

/**
 * The choices `--push`, `--push-all` and `--leave-rest` make for the
 * branches that need one, or null, with the table printed, while one has
 * none.
 */
function upstreamPushes(
  branches: UpstreamMoveBranch[],
  opts: ProjectMoveOptions,
): { push: Array<{ branch: string; as?: string }>; leave: string[] } | null {
  const named = new Map((opts.push ?? []).map((p) => {
    const at = p.indexOf('=')
    return at < 0 ? [p, undefined] as const : [p.slice(0, at), p.slice(at + 1)] as const
  }))
  const push: Array<{ branch: string; as?: string }> = []
  const leave: string[] = []
  const open: UpstreamMoveBranch[] = []
  for (const b of branches) {
    if (b.state === 'same' || b.state === 'upstream-only') continue
    if (named.has(b.branch)) {
      const as = named.get(b.branch)
      push.push({ branch: b.branch, ...(as !== undefined ? { as } : {}) })
    } else if (opts.pushAll === true && b.state !== 'diverged') {
      push.push({ branch: b.branch })
    } else if (opts.leaveRest === true) {
      leave.push(b.branch)
    } else {
      open.push(b)
    }
  }
  if (open.length === 0) return { push, leave }
  console.error('These branches need a choice (--push <branch>[=<name>], --push-all, --leave-rest):')
  printTable(
    [{ header: 'BRANCH' }, { header: 'STATE' }, { header: 'DEPENDS ON IT' }],
    open.map((b) => [
      b.branch,
      b.state === 'diverged' ? 'diverged (leave it, or catch up in a workspace first)' : b.state,
      [
        ...(b.dependents.running > 0 ? [`${b.dependents.running} running`] : []),
        ...(b.dependents.stopped > 0 ? [`${b.dependents.stopped} stopped`] : []),
        ...(b.dependents.queued > 0 ? [`${b.dependents.queued} queued`] : []),
        ...(b.dependents.routines > 0 ? [`${b.dependents.routines} routine(s)`] : []),
      ].join(', '),
    ]),
  )
  return null
}
