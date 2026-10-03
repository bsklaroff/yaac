import { execFile } from 'node:child_process'

/**
 * Run `kubectl` once, for what tests inspect or drive through the CLI
 * rather than the API: `exec`, `logs`, `wait`, `rollout status` and
 * jsonpath reads. `input` is piped to stdin. No retries: a failure fails
 * the test.
 */
export function kubectl(
  args: string[],
  opts: { timeout?: number; input?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('kubectl', args, { maxBuffer: 64 << 20, timeout: opts.timeout }, (err, stdout, stderr) => {
      if (err instanceof Error) reject(Object.assign(err, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
    child.stdin?.on('error', () => { /* reported via the exec callback */ })
    child.stdin?.end(opts.input)
  })
}
