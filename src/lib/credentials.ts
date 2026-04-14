import fs from 'node:fs/promises'
import readline from 'node:readline/promises'
import path from 'node:path'
import { getDataDir, ensureDataDir } from '@/lib/paths'

interface Credentials {
  GITHUB_TOKEN: string
}

export function credentialsPath(): string {
  return path.join(getDataDir(), '.credentials.json')
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(credentialsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).GITHUB_TOKEN === 'string' &&
      (parsed as Record<string, unknown>).GITHUB_TOKEN !== ''
    ) {
      return parsed as Credentials
    }
    return null
  } catch {
    return null
  }
}

export async function getGithubToken(): Promise<string | null> {
  const creds = await loadCredentials()
  return creds?.GITHUB_TOKEN ?? null
}

export async function promptForGithubToken(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('Enter your GitHub Personal Access Token.')
  console.log('It will be used for all git operations and available (via proxy) to all requests to github.com in yaac.')
  const token = await rl.question('GitHub PAT: ')
  rl.close()

  if (!token.trim()) {
    console.error('Token cannot be empty.')
    process.exit(1)
  }

  await ensureDataDir()
  const filePath = credentialsPath()
  await fs.writeFile(filePath, JSON.stringify({ GITHUB_TOKEN: token.trim() }, null, 2) + '\n', { mode: 0o600 })
  console.log(`Credentials saved to ${filePath}`)

  return token.trim()
}

export async function ensureGithubToken(): Promise<string> {
  const existing = await getGithubToken()
  if (existing) return existing
  return promptForGithubToken()
}
