import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Resolve the user's editor: `$EDITOR`, then `$VISUAL`, then `vi`. The value
 * is split on whitespace so `EDITOR="code -w"` works without a shell.
 */
// eslint-disable-next-line no-process-env -- DI seam reading EDITOR/VISUAL; tests inject a fake env.
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } {
  const raw = (env.EDITOR ?? env.VISUAL ?? 'vi').trim()
  const [cmd, ...args] = raw.split(/\s+/)
  return { cmd, args }
}

/**
 * Open `filePath` in the user's editor with inherited stdio, creating the
 * parent directory first. Rejects if the editor fails to start or exits
 * non-zero.
 */
// eslint-disable-next-line no-process-env -- DI seam; tests inject a fake env.
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
