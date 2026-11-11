import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PACKAGE_ROOT } from '@yaac/shared/paths'

/**
 * Runs the shipped `yaac-git-ssh` (the ssh a containerless workspace's git
 * runs, `GIT_SSH_COMMAND` in `git-auth.ts`) against a stub `ssh` on PATH
 * that prints its arguments, one per line.
 */
const execFileAsync = promisify(execFile)
const SCRIPT = path.join(PACKAGE_ROOT, 'workspace-bin', 'yaac-git-ssh')

describe('yaac-git-ssh', () => {
  let dir: string
  let table: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-git-ssh-'))
    await fs.writeFile(path.join(dir, 'ssh'), '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 })
    table = path.join(dir, 'keys')
    await fs.writeFile(table, 'github.com\to/api\t/keys/id-0.pub\ngithub.com\tO/Web\t/keys/id-1.pub\ngitlab.com\to/api\t/keys/id-2.pub\n')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  /** The arguments ssh was run with for git's `args`. */
  const sshArgs = async (...args: string[]): Promise<string[]> => {
    const { stdout } = await execFileAsync(SCRIPT, [table, '/kh', ...args], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` },
    })
    return stdout.trimEnd().split('\n')
  }
  const CHECKED = ['-F', '/dev/null', '-o', 'UserKnownHostsFile=/kh', '-o', 'StrictHostKeyChecking=yes']

  it('offers the key of the repo git names, and only that one', async () => {
    // scp-style and ssh:// remotes, with and without `.git`.
    for (const repo of ['o/api.git', '/o/api.git', 'o/api', '/o/api/']) {
      const command = `git-upload-pack '${repo}'`
      expect(await sshArgs('-o', 'SendEnv=GIT_PROTOCOL', 'git@github.com', command)).toEqual([
        '-o', 'IdentitiesOnly=yes', '-i', '/keys/id-0.pub', ...CHECKED,
        '-o', 'SendEnv=GIT_PROTOCOL', 'git@github.com', command,
      ])
    }
    // Hosts and paths compare without case, as git hosts do; the host
    // decides between two repos of one path.
    expect((await sshArgs('git@GitHub.com', 'git-receive-pack \'o/web.git\''))[3]).toBe('/keys/id-1.pub')
    expect((await sshArgs('-p', '22', 'gitlab.com', 'git-upload-pack \'o/api.git\''))[3]).toBe('/keys/id-2.pub')
    // git-lfs names the path unquoted, before the operation.
    expect((await sshArgs('git@github.com', 'git-lfs-authenticate o/web.git upload'))[3]).toBe('/keys/id-1.pub')
  })

  it('runs plain ssh, host keys still checked, for a repo the table lacks', async () => {
    const command = 'git-upload-pack \'o/other.git\''
    expect(await sshArgs('git@github.com', command)).toEqual([...CHECKED, 'git@github.com', command])
    await fs.rm(table)
    expect(await sshArgs('git@github.com', 'git-upload-pack \'o/api.git\'')).toEqual([...CHECKED, 'git@github.com', 'git-upload-pack \'o/api.git\''])
  })
})
