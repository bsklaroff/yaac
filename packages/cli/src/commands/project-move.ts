import { api, projectRepoOf, resolveGitCredentialId, resolveProject } from '#commands/api'
import { confirmDefault } from '@yaac/shared/confirm'

/**
 * Move a repo yaac hosts to an empty remote elsewhere, keeping yaac's copy
 * of the repository until the owner removes it (docs/hosted-projects.md
 * "Moving to a git host"). It stops every workspace holding a checkout of
 * the repo, other users' included, so it says what stops and asks first,
 * defaulting to no; with no terminal to ask on it refuses. `--repo` names
 * the repo of a project with several.
 */
export async function projectMove(
  project: string,
  remoteUrl: string,
  credentialName: string,
  opts: { repo?: string } = {},
): Promise<void> {
  const summary = await resolveProject(project)
  const repo = projectRepoOf(summary, opts.repo)
  const name = summary.repos.length > 1 ? `${summary.name}/${repo.dir}` : summary.name
  const credentialId = await resolveGitCredentialId(credentialName)
  const param = { repoId: repo.id }
  const { runningWorkspaces, sharedWith } = await api.repo[':repoId']['move-preview'].$get({ param })
  // A script reading the exit code must not take a move that never ran for
  // success.
  if (!process.stdin.isTTY) {
    console.error('A repo is only moved from a terminal, where you confirm what it stops.')
    process.exitCode = 1
    return
  }
  if (!await confirmDefault(
    `This moves ${name} to ${remoteUrl}, which must be empty. It first stops ${runningWorkspaces} running `
    + 'workspace(s) that hold a checkout of it, whoever owns them; their checkouts are kept, and push to the new '
    + 'remote once restarted. Nothing can start with it until the move is done.'
    + (sharedWith.length > 0
      ? ` It is shared with ${sharedWith.join(', ')}: each keeps a repo of their own for it, but needs a git `
        + 'credential of their own for the new remote before a workspace can start with it.'
      : '')
    + ' yaac keeps its copy of the repository, read-only, until you remove it in Settings → Repos. Continue?',
  )) {
    console.log('Aborted — nothing was stopped or moved.')
    return
  }
  console.log(`Moving ${name} to ${remoteUrl}...`)
  const { knownHostsEntry } = await api.repo[':repoId'].move.$post({ param, json: { remoteUrl, credentialId } })
  if (knownHostsEntry !== null) console.log(`Host key trusted: ${knownHostsEntry}`)
  console.log(`${name} now uses ${remoteUrl}. Once you have checked it has every branch and tag, `
    + "remove yaac's copy of the repository in Settings → Repos.")
}
