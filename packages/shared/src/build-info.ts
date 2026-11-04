import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The release and commit a build is cut from, which the build stamps into
 * the CLI bundle (tsup `env`) and the webapp (Vite `define`) so a running
 * copy can say what it is (docs/feedback.md). Run by the build configs
 * only, which bundle without the package's `#` imports and so name the
 * repo `root` themselves. The commit ends in `-dirty` when tracked files
 * had uncommitted changes. It is empty unless `root` is itself a git
 * checkout's top level, so a source tree unpacked inside some other
 * repository does not take that repository's commit.
 */
export function buildStamp(root: string): { version: string; gitCommit: string } {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    if (fs.realpathSync(git('rev-parse', '--show-toplevel')) !== fs.realpathSync(root)) return { version, gitCommit: '' }
    return { version, gitCommit: git('rev-parse', 'HEAD') + (git('status', '--porcelain', '--untracked-files=no') ? '-dirty' : '') }
  } catch {
    return { version, gitCommit: '' }
  }
}
