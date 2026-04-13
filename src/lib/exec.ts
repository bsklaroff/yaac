import { execSync, type ExecSyncOptions } from 'node:child_process'

/**
 * Run a shell command with automatic retries on transient errors.
 * Retries when stderr matches any of the provided patterns.
 */
export function execSyncRetry(
  cmd: string,
  options?: ExecSyncOptions & { retries?: number; retryPatterns?: string[] },
): Buffer | string {
  const { retries = 5, retryPatterns = [], ...execOpts } = options ?? {}

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return execSync(cmd, execOpts)
    } catch (err: unknown) {
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? ''
      const retriable = retryPatterns.some((p) => stderr.includes(p))
      if (attempt < retries && retriable) {
        execSync(`sleep 0.${attempt}`)
        continue
      }
      throw err
    }
  }
  // unreachable — last attempt always throws or returns
  throw new Error('execSyncRetry: unexpected fall-through')
}
