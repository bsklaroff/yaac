import { afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  OUTPUT_PAGE_BYTES,
  forgetWorkspaceChanges,
  readWorkspaceChanges,
  type ChangesReading,
  type ChangesRequest,
} from '#domain/workspaces/changes'
import { WorkspaceExecError, type WorkspaceDriver } from '#drivers/contract'
import { installFakeWorkspaceDriver, workspacePathsFixture } from '#test/support/fake-driver'

/**
 * The fixture of the `changes*.test.ts` files: a scratch repo standing in
 * for a running workspace. The reads run the exact scripts with `sh -c`
 * against it, as streamd does, to catch shell bugs that string assertions
 * miss. Importing this registers the cleanup after each test.
 */

/** Scratch dirs removed after each test; a test adds its own. */
export const tmpDirs: string[] = []
afterEach(() => {
  exec.mockReset()
  for (const job of ['ws', 'fresh', 'yaac-proj-abc']) forgetWorkspaceChanges(job)
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

export const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
}
export const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, ...GIT_ENV } })

export const exec = vi.fn<WorkspaceDriver['exec']>()

/** A scratch repo as a running workspace, and ways to read its changes. */
export interface Workspace {
  repo: string
  /** A job's scratch dir, which holds its private index; each job has its
   *  own, so two jobs over one checkout read it independently. */
  scratch: (job?: string) => string
  /** Every exec's command and output, in order. */
  runs: { cmd: string; out: string }[]
  /** Edit each command before it runs. */
  rewrite: (edit: (cmd: string) => string) => void
  /** Read the changes as job `ws`, against `main` unless asked otherwise. */
  read: (r?: Partial<ChangesRequest>, job?: string) => Promise<ChangesReading>
  /** Read them as a server holding nothing would, as another job. */
  fresh: (r?: Partial<ChangesRequest>) => Promise<ChangesReading>
}

/**
 * A repo on `main` with one commit (on an unborn `agent/x` when `empty`),
 * through a driver whose workspace it is, running each exec for real. With
 * `pageBytes`, the scan pages at that size, and an output over twice it
 * fails, as one over streamd's cap does.
 */
export function workspace({ pageBytes, empty }: { pageBytes?: number; empty?: boolean } = {}): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-changes-'))
  tmpDirs.push(root)
  const repo = path.join(root, 'workspace')
  fs.mkdirSync(repo)
  if (empty) {
    git(repo, 'init', '-q', '-b', 'agent/x')
  } else {
    git(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
  }
  const scratch = (job = 'ws'): string => {
    const dir = path.join(root, `scratch-${job}`)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }
  const runs: Workspace['runs'] = []
  let rewrite = (cmd: string): string => cmd
  installFakeWorkspaceDriver({
    exec,
    workspacePaths: (job) => workspacePathsFixture({ workspaceDir: repo, scratchDir: scratch(job) }),
  })
  exec.mockImplementation((_job, cmd, opts) => {
    const run = rewrite(pageBytes ? cmd.replaceAll(String(OUTPUT_PAGE_BYTES), String(pageBytes)) : cmd)
    let out: string
    try {
      out = execFileSync('sh', ['-c', run], {
        input: opts?.stdin ?? '', encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, ...GIT_ENV },
      })
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      return Promise.reject(new WorkspaceExecError(`command exited ${e.status}`, e.status, e.stdout, e.stderr))
    }
    runs.push({ cmd, out })
    if (pageBytes && Buffer.byteLength(out) > 2 * pageBytes) return Promise.reject(new Error('output over the cap'))
    return Promise.resolve({ stdout: out, stderr: '' })
  })
  const read = (r: Partial<ChangesRequest> = {}, job = 'ws'): Promise<ChangesReading> =>
    readWorkspaceChanges(job, { defaultBase: 'main', diff: true, ...r })
  return {
    repo, scratch, runs, read,
    rewrite: (edit) => { rewrite = edit },
    fresh: (r) => {
      forgetWorkspaceChanges('fresh')
      fs.rmSync(path.join(scratch('fresh'), 'yaac-changes.idx.entries'), { force: true })
      return read(r, 'fresh')
    },
  }
}

/** The paths of the lines the fills among `runs` read. */
export const filled = (runs: Workspace['runs']): string[] => [...new Set(runs.filter((r) => r.out.startsWith('@@PAIR@@'))
  .flatMap((r) => r.out.split('\n').filter((l) => l.startsWith(':')).map((l) => l.split('\t').at(-1)!)))].sort()

/** The environment that reads a workspace's scratch objects as reads of
 *  the changes do. */
export const scratchObjectsEnv = (repo: string, scratchDir: string): NodeJS.ProcessEnv => ({
  GIT_OBJECT_DIRECTORY: path.join(scratchDir, 'yaac-changes.idx.objects'),
  GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(repo, '.git/objects'),
})

/** A unified diff's parts by destination path. */
export const partsOf = (diff = ''): Map<string, string> => new Map(diff.split(/(?=^diff --git )/m)
  .filter(Boolean).map((p) => [/^diff --git a\/\S+ b\/(\S+)/.exec(p)![1], p]))
