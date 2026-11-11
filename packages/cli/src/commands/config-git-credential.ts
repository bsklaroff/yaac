import { api, projectRepoOf, resolveGitCredentialId, resolveProject } from '#commands/api'

/**
 * `yaac config git-credential <project> [credential]`: show which git
 * credential a project's repo clones, fetches and pushes with, or assign it
 * one by name, as `yaac auth list` prints it (docs/git-credentials.md). The
 * credential is the repo's, so every project linking the repo uses it. A
 * repo hosted by yaac needs none, and the server refuses one. `--repo`
 * names the repo of a project with several.
 */
export async function configGitCredential(
  project: string,
  credential: string | undefined,
  opts: { repo?: string } = {},
): Promise<void> {
  const repo = projectRepoOf(await resolveProject(project), opts.repo)
  const name = repo.hosted ? repo.dir : repo.remoteUrl

  if (credential === undefined) {
    console.log(repo.hosted
      ? `${name} is hosted by yaac, so it needs no git credential.`
      : repo.gitCredential
        ? `${name} uses the git credential ${repo.gitCredential.name}.`
        : `${name} has no git credential, so no workspace can start with it until it is given one.`)
    return
  }
  const credentialId = await resolveGitCredentialId(credential)
  const { knownHostsEntry } = await api.repo[':repoId']['git-credential'].$put({ param: { repoId: repo.id }, json: { credentialId } })
  console.log(`${name} now uses the git credential ${credential}, from its next fetch.`)
  if (knownHostsEntry !== null) console.log(`Host key trusted: ${knownHostsEntry}`)
}
