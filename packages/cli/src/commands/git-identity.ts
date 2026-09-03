import readline from 'node:readline/promises'
import { getApiClient } from '@yaac/shared/server-api'
import { seedGitIdentityFromShell } from '@yaac/shared/git-identity-seed'

/**
 * Make sure the SERVER has a git identity before asking it to make a
 * worktree, seeding it from this machine's git config and prompting only if
 * that comes up empty too.
 *
 * The identity is a server setting, not something each create carries: it is
 * the same answer every time, and a webapp create — which has no shell to
 * read one from — needs it to already be there. What this keeps is the
 * convenience the CLI always had, which is that nobody who has configured
 * git on their laptop should have to type their own name again.
 *
 * The prompt writes to the SERVER rather than to this machine's global git
 * config. Writing the latter would be this command reaching outside its own
 * job, and against a remote server it would configure the wrong machine.
 *
 * Returns `undefined` when the prompt is abandoned (empty name or email);
 * callers set the exit code.
 */
export async function ensureGitIdentity(): Promise<{ name: string; email: string } | undefined> {
  const seeded = await seedGitIdentityFromShell()
  if (seeded) {
    console.log(`Git identity: ${seeded.name} <${seeded.email}>`)
    return seeded
  }

  console.log('This server has no git identity, and this machine has none to give it.')
  console.log('Git commits require one.')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const name = (await rl.question('Enter git user.name: ')).trim()
  const email = (await rl.question('Enter git user.email: ')).trim()
  rl.close()
  if (!name || !email) {
    console.error('Git user.name and user.email are required.')
    return undefined
  }
  const { identity } = await getApiClient().config['git-identity'].$put({
    json: { name, email },
  })
  return identity
}
