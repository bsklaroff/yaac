import readline from 'node:readline/promises'

/**
 * Ask a yes/no question on the terminal, defaulting to no. Without a TTY
 * there is nobody to answer, so it returns `false` and a destructive command
 * that asked aborts rather than proceeding unattended.
 */
export async function confirmDefault(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}
