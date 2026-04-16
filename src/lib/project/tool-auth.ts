import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { loadCredentials, saveCredentials } from '@/lib/project/credentials'
import type { AgentTool, ToolAuthKind, ToolAuthEntry } from '@/types'

/**
 * Auto-detect the auth kind from a token string.
 * - Anthropic API keys start with "sk-ant-api03-"
 * - Anthropic OAuth tokens start with "sk-ant-oat"
 * - Everything else defaults to 'api-key'
 */
export function detectAuthKind(tool: AgentTool, token: string): ToolAuthKind {
  if (tool === 'claude') {
    if (token.startsWith('sk-ant-oat')) return 'oauth'
    return 'api-key'
  }
  return 'api-key'
}

/**
 * Load the stored auth entry for a specific tool.
 * Returns null if no credentials are configured.
 */
export async function loadToolAuthEntry(tool: AgentTool): Promise<ToolAuthEntry | null> {
  const creds = await loadCredentials()
  if (!creds.toolAuth?.length) return null
  return creds.toolAuth.find((e) => e.tool === tool) ?? null
}

/**
 * Save or update tool auth credentials.
 * Upserts by tool name — if an entry for the tool already exists, it is replaced.
 */
export async function saveToolAuth(tool: AgentTool, apiKey: string, kind: ToolAuthKind): Promise<void> {
  const creds = await loadCredentials()
  const toolAuth = creds.toolAuth ?? []
  const idx = toolAuth.findIndex((e) => e.tool === tool)
  const entry: ToolAuthEntry = { tool, kind, apiKey, savedAt: new Date().toISOString() }
  if (idx >= 0) {
    toolAuth[idx] = entry
  } else {
    toolAuth.push(entry)
  }
  creds.toolAuth = toolAuth
  await saveCredentials(creds)
}

/**
 * Remove stored auth for a specific tool. Returns true if an entry was found and removed.
 */
export async function removeToolAuth(tool: AgentTool): Promise<boolean> {
  const creds = await loadCredentials()
  const toolAuth = creds.toolAuth ?? []
  const idx = toolAuth.findIndex((e) => e.tool === tool)
  if (idx < 0) return false
  toolAuth.splice(idx, 1)
  creds.toolAuth = toolAuth
  await saveCredentials(creds)
  return true
}

/**
 * Read Claude Code's OAuth credentials from its native config.
 * Claude Code stores OAuth tokens in ~/.claude/.credentials.json under
 * the "claudeAiOauth" key.
 */
export async function readClaudeCredentials(): Promise<string | null> {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json')
    const raw = await fs.readFile(credPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined
    if (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken) {
      return oauth.accessToken
    }
    return null
  } catch {
    return null
  }
}

/**
 * Read Codex's stored API key from its native config.
 * Codex may store auth in ~/.codex/auth.json.
 */
export async function readCodexCredentials(): Promise<string | null> {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json')
    const raw = await fs.readFile(authPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Try common field names
    for (const key of ['api_key', 'apiKey', 'token', 'access_token']) {
      const val = parsed[key]
      if (typeof val === 'string' && val) {
        return val
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Spawn a CLI command and wait for it to exit.
 * Inherits stdio so the user can interact with the login flow.
 */
function runInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', reject)
  })
}

/**
 * Run the tool's native login CLI and extract the resulting credentials.
 *
 * For Claude Code: spawns `claude login` then reads ~/.claude/.credentials.json
 * For Codex: spawns `codex login` then tries to read ~/.codex/auth.json
 *
 * If credential extraction fails after login, falls back to prompting
 * the user for their API key directly.
 */
export async function runToolLogin(tool: AgentTool): Promise<{ apiKey: string; kind: ToolAuthKind }> {
  const toolLabel = tool === 'claude' ? 'Claude Code' : 'Codex'
  console.log(`Starting ${toolLabel} login flow...`)

  if (tool === 'claude') {
    const code = await runInteractive('claude', ['login'])
    if (code !== 0) {
      console.warn(`Claude Code login exited with code ${code}.`)
    }

    const token = await readClaudeCredentials()
    if (token) {
      const kind = detectAuthKind('claude', token)
      return { apiKey: token, kind }
    }

    console.log('Could not read credentials from Claude Code config.')
    return promptForApiKey(tool)
  }

  // Codex
  const code = await runInteractive('codex', ['login'])
  if (code !== 0) {
    console.warn(`Codex login exited with code ${code}.`)
  }

  const token = await readCodexCredentials()
  if (token) {
    const kind = detectAuthKind('codex', token)
    return { apiKey: token, kind }
  }

  console.log('Could not read credentials from Codex config.')
  return promptForApiKey(tool)
}

/**
 * Prompt the user to paste their API key directly.
 */
export async function promptForApiKey(tool: AgentTool): Promise<{ apiKey: string; kind: ToolAuthKind }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const label = tool === 'claude' ? 'Anthropic API key or OAuth token' : 'OpenAI API key'
  const key = (await rl.question(`Paste your ${label}: `)).trim()
  rl.close()
  if (!key) {
    console.error('Key cannot be empty.')
    process.exit(1)
  }
  const kind = detectAuthKind(tool, key)
  return { apiKey: key, kind }
}

/**
 * Ensure the given tool has stored credentials.
 * If not, runs the native login flow and saves the result.
 */
export async function ensureToolAuth(tool: AgentTool): Promise<ToolAuthEntry> {
  const existing = await loadToolAuthEntry(tool)
  if (existing) return existing

  const { apiKey, kind } = await runToolLogin(tool)
  await saveToolAuth(tool, apiKey, kind)
  const toolLabel = tool === 'claude' ? 'Claude Code' : 'Codex'
  console.log(`${toolLabel} credentials saved.`)
  return { tool, kind, apiKey, savedAt: new Date().toISOString() }
}
