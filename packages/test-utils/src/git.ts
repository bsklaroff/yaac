import { execFile } from 'node:child_process'

/**
 * Run plain git in `dir`, for test setup and assertions — git as a developer
 * or a pod runs it, deliberately NOT the server's hardened runner. Resolves
 * with stdout; rejects with stderr as the message on a non-zero exit.
 */
export function git(dir: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, env: opts.env ?? process.env, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(stderr.trim() || err.message), { code: err.code }))
      else resolve(stdout)
    })
  })
}
