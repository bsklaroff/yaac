import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Resolve the user's preferred terminal editor, matching git's convention.
 * `$EDITOR` wins, then `$VISUAL`, then `vi` as a last resort. Whitespace
 * is split so values like `EDITOR="code -w"` produce a multi-arg invocation
 * (no shell, so paths can't be misinterpreted as shell metacharacters).
 */
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } {
  const raw = (env.EDITOR ?? env.VISUAL ?? 'vi').trim()
  const [cmd, ...args] = raw.split(/\s+/)
  return { cmd, args }
}

/**
 * Open `filePath` in the user's editor, creating the parent directory
 * first so the editor can save into a fresh location. Inherits stdio so
 * full-screen editors (vim, nano) render normally. Resolves on a clean
 * exit; rejects on spawn error or non-zero exit code.
 */
export async function editFile(filePath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const { cmd, args } = resolveEditor(env)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [...args, filePath], { stdio: 'inherit' })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`editor exited with code ${code}`))
    })
    child.on('error', reject)
  })
}
