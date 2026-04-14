import fs from 'node:fs/promises'
import readline from 'node:readline/promises'
import { credentialsPath } from '@/lib/credentials'

export async function authClear(): Promise<void> {
  const filePath = credentialsPath()

  try {
    await fs.access(filePath)
  } catch {
    console.log('No credentials file found.')
    return
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('Are you sure you want to clear your stored credentials? (y/N) ')
  rl.close()

  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Cancelled.')
    return
  }

  await fs.rm(filePath)
  console.log(`Credentials removed from ${filePath}`)
}
