import readline from 'node:readline/promises'
import { promptForGithubToken } from '@/lib/project/credentials'
import { runToolLogin, persistToolLogin } from '@/lib/project/tool-auth'

export async function authUpdate(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('What would you like to authenticate?')
  console.log('  1) GitHub repository token')
  console.log('  2) Claude Code (Anthropic)')
  console.log('  3) Codex (OpenAI)')
  const answer = (await rl.question('Choice [1-3]: ')).trim()
  rl.close()

  if (answer === '1') {
    await promptForGithubToken()
    return
  }

  if (answer === '2') {
    const result = await runToolLogin('claude')
    await persistToolLogin('claude', result)
    console.log('Claude Code credentials saved.')
    return
  }

  if (answer === '3') {
    const result = await runToolLogin('codex')
    await persistToolLogin('codex', result)
    console.log('Codex credentials saved.')
    return
  }

  console.log('Cancelled.')
}
