import { api, resolveGitCredentialId, resolveProjectId } from '#commands/api'
import { confirmDefault } from '@yaac/shared/confirm'

/**
 * Move a project yaac hosts, and every share of it, to an empty remote
 * elsewhere, keeping yaac's copy of the repository until the owner removes
 * it (docs/hosted-projects.md "Moving to a git host"). It stops
 * every workspace on the project, other users' included, so it says what
 * stops and asks first, defaulting to no; with no terminal to ask on it
 * refuses.
 */
export async function projectMove(project: string, remoteUrl: string, credentialName: string): Promise<void> {
  const projectId = await resolveProjectId(project)
  const gitCredentialId = await resolveGitCredentialId(credentialName)
  const move = api.project[':projectId'].move
  const { runningWorkspaces, sharedWith } = await move.$get({ param: { projectId } })
  // A script reading the exit code must not take a move that never ran for
  // success.
  if (!process.stdin.isTTY) {
    console.error('A project is only moved from a terminal, where you confirm what it stops.')
    process.exitCode = 1
    return
  }
  if (!await confirmDefault(
    `This moves ${project} to ${remoteUrl}, which must be empty. It first stops ${runningWorkspaces} running `
    + 'workspace(s) on the project, whoever owns them; their checkouts are kept, and push to the new remote '
    + 'once restarted. Nothing can start in it until the move is done.'
    + (sharedWith.length > 0
      ? ` It is shared with ${sharedWith.join(', ')}: each keeps their copy, but needs a git credential of `
        + 'their own for the new remote before it can start a workspace.'
      : '')
    + ' yaac keeps its copy of the repository, read-only, until you remove it in Project settings. Continue?',
  )) {
    console.log('Aborted — nothing was stopped or moved.')
    return
  }
  console.log(`Moving ${project} to ${remoteUrl}...`)
  const { knownHostsEntry } = await move.$post({ param: { projectId }, json: { remoteUrl, gitCredentialId } })
  if (knownHostsEntry !== null) console.log(`Host key trusted: ${knownHostsEntry}`)
  console.log(`${project} now uses ${remoteUrl}. Once you have checked it has every branch and tag, `
    + "remove yaac's copy of the repository in Project settings.")
}
