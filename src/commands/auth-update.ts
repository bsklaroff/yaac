import { promptForGithubToken } from '@/lib/credentials'

export async function authUpdate(): Promise<void> {
  await promptForGithubToken()
}
