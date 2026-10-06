import { api } from '#commands/api'

export async function projectAdd(input: string, credentialName: string): Promise<void> {
  const { gitCredentials } = await api.auth.list.$get()
  const gitCredentialId = gitCredentials.find((c) => c.name === credentialName)?.id
  if (gitCredentialId === undefined) {
    throw new Error(`No git credential named "${credentialName}". Run \`yaac auth list\` to see them.`)
  }
  console.log(`Adding project from ${input}...`)
  const result = await api.project.add.$post({ json: { remoteUrl: input, gitCredentialId } })
  console.log(`Project "${result.project.name}" (${result.project.id}) added successfully.`)
  if (result.knownHostsEntry !== null) console.log(`Host key trusted: ${result.knownHostsEntry}`)
}
