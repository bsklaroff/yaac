import { promptForGithubToken } from '@/lib/project/credentials'

export async function authUpdate(): Promise<void> {
  await promptForGithubToken()
}
