import { api, projectScope, resolveGitCredentialId, resolveProjectId } from '#commands/api'

/**
 * `yaac config git-credential <project> [credential]`: show which git
 * credential a project clones, fetches and pushes with, or assign it one by
 * name, as `yaac auth list` prints it (docs/git-credentials.md). A project
 * hosted by yaac needs none, and the server refuses one.
 */
export async function configGitCredential(project: string, credential: string | undefined): Promise<void> {
  const scope = await projectScope()
  const projectId = await resolveProjectId(project, scope)
  const summary = scope.all.find((p) => p.id === projectId)
  const name = summary?.name ?? projectId

  if (credential === undefined) {
    console.log(summary?.hosted === true
      ? `${name} is hosted by yaac, so it needs no git credential.`
      : summary?.gitCredential
        ? `${name} uses the git credential ${summary.gitCredential.name}.`
        : `${name} has no git credential, so it cannot create workspaces until it is given one.`)
    return
  }
  const credentialId = await resolveGitCredentialId(credential)
  const { knownHostsEntry } = await api.project[':projectId']['git-credential'].$put({ param: { projectId }, json: { credentialId } })
  console.log(`${name} now uses the git credential ${credential}, from its next fetch.`)
  if (knownHostsEntry !== null) console.log(`Host key trusted: ${knownHostsEntry}`)
}
