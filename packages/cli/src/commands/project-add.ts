import { api, resolveGitCredentialId } from '#commands/api'

export async function projectAdd(input: string, credentialName: string): Promise<void> {
  const gitCredentialId = await resolveGitCredentialId(credentialName)
  console.log(`Adding project from ${input}...`)
  const result = await api.project.add.$post({ json: { remoteUrl: input, gitCredentialId } })
  console.log(`Project "${result.project.name}" (${result.project.id}) added successfully.`)
  if (result.knownHostsEntry !== null) console.log(`Host key trusted: ${result.knownHostsEntry}`)
  if (result.allowedHost !== null) {
    console.log(`Added ${result.allowedHost} to the project's egress allowlist, so its workspaces can reach the repo.`)
  }
}
