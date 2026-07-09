import readline from 'node:readline/promises'
import simpleGit from 'simple-git'
import { getGitUserConfig } from '@/shared/git'

/**
 * Resolve the user's global git identity, prompting for (and persisting)
 * one when it's missing. Session create/restart resolve the identity
 * CLI-side so the daemon receives an already-resolved pair. Returns
 * `undefined` when the prompt is abandoned (empty name or email); callers
 * set the exit code.
 */
export async function ensureGitIdentity(): Promise<{ name: string; email: string } | undefined> {
  const existing = await getGitUserConfig()
  if (existing) {
    console.log(`Git identity: ${existing.name} <${existing.email}>`)
    return existing
  }

  console.log('No global git user configured. Git commits require a user identity.')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const name = await rl.question('Enter git user.name: ')
  const email = await rl.question('Enter git user.email: ')
  rl.close()
  if (!name || !email) {
    console.error('Git user.name and user.email are required.')
    return undefined
  }
  await simpleGit().addConfig('user.name', name, false, 'global')
  await simpleGit().addConfig('user.email', email, false, 'global')
  return { name, email }
}
