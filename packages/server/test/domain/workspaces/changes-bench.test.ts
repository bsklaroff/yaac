/**
 * A benchmark of the changes read, the measurements behind its caching
 * (docs/file-editor.md "Changes"). Skipped unless BENCH_REPO names the
 * checkout to read:
 *
 *   BENCH_REPO=<dir> [BENCH_FIXTURE=synthetic|yaac] [BENCH_BUILD=<files>] \
 *     pnpm vitest run --project unit:server packages/server/test/domain/workspaces/changes-bench.test.ts
 *
 * A missing <dir> is built first as BENCH_FIXTURE: `synthetic` (the default)
 * is 30,000 files in 1,000 folders whose branch edits 600, adds 20 and
 * renames 5; `yaac` is a shared clone of this repo with `main` 40 commits
 * behind HEAD. Either way HEAD is compared against `main`. BENCH_BUILD adds
 * rows for an untracked build folder of that many files that nothing
 * ignores. Put <dir> on the filesystem being measured: in a workspace, the
 * checkout's own volume (the gitignored `.yaac-dev/` holds it).
 *
 * Each row runs `readWorkspaceChanges` a few times through a fake driver
 * that runs every exec with `sh`, and prints each poll's time, then the
 * last poll's output size and exec count.
 */
import { it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { forgetWorkspaceChanges, readWorkspaceChanges, type ChangesRequest } from '#domain/workspaces/changes'
import { WorkspaceExecError } from '#drivers/contract'
import { installFakeWorkspaceDriver, workspacePathsFixture } from '#test/support/fake-driver'

const repo = process.env.BENCH_REPO ?? ''
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, args: string[], input?: Buffer): string =>
  execFileSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 << 20, env: { ...process.env, ...GIT_ENV } })

/** The synthetic fixture as a `git fast-import` stream: `main` holds `n`
 *  files of 60 lines, and `agent/x` edits `changed` of them, adds 20 and
 *  renames 5. */
function syntheticStream(n = 30_000, changed = 600): Buffer {
  const out: Buffer[] = []
  const put = (s: string | Buffer): void => { out.push(Buffer.from(s)) }
  const data = (s: string): void => { put(`data ${Buffer.byteLength(s)}\n`); put(s); put('\n') }
  const body = (i: number, edited: boolean): string => Array.from({ length: 60 }, (_, l) =>
    `${edited && l % 10 === 9 ? 'edited ' : ''}file ${i} line ${l} some text to make the line longer\n`).join('')
  const file = (i: number): string => `d${String(i % 1000).padStart(3, '0')}/f${i}.txt`
  const commit = (ref: string, msg: string, parent?: string): void => {
    put(`commit ${ref}\ncommitter t <t@t> 1700000000 +0000\n`)
    data(msg)
    if (parent) put(`from ${parent}\n`)
  }
  commit('refs/heads/main', 'base')
  for (let i = 0; i < n; i++) { put(`M 100644 inline ${file(i)}\n`); data(body(i, false)) }
  commit('refs/heads/agent/x', 'work', 'refs/heads/main')
  for (let k = 0; k < changed; k++) {
    const i = Math.floor(k * n / changed)
    put(`M 100644 inline ${file(i)}\n`)
    data(body(i, true))
  }
  for (let k = 1; k <= 20; k++) {
    put(`M 100644 inline d000/added${k}.txt\n`)
    data(Array.from({ length: 100 }, (_, j) => `new file ${j}\n`).join(''))
  }
  for (let k = 1; k <= 5; k++) put(`R ${file(1 + k * 1000)} d002/moved${k}.txt\n`)
  put('done\n')
  return Buffer.concat(out)
}

/** Build the BENCH_FIXTURE checkout at `dir`, on `agent/x`. */
function buildFixture(dir: string): void {
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  if (process.env.BENCH_FIXTURE === 'yaac') {
    git(path.dirname(dir), ['clone', '-q', '--shared', path.resolve(import.meta.dirname, '../../../../..'), dir])
    git(dir, ['checkout', '-q', '-B', 'agent/x'])
    git(dir, ['update-ref', 'refs/heads/main', 'HEAD~40'])
    return
  }
  fs.mkdirSync(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['fast-import', '--quiet'], syntheticStream())
  git(dir, ['checkout', '-q', 'agent/x'])
}

/** An untracked build folder of `n` files of about 2 KB in 50 folders,
 *  each file's content marked by `tag`, so a rebuild rewrites them all. */
function writeBuild(dir: string, n: number, tag: string): void {
  for (let i = 0; i < n; i++) {
    const sub = path.join(dir, `m${String(i % 50).padStart(2, '0')}`)
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, `o${i}.js`), Array.from({ length: 40 }, (_, l) =>
      `// ${tag} build output ${i} line ${l} xxxxxxxxxxxxxxxxxxxx\n`).join(''))
  }
}

it.skipIf(!repo)('benchmarks the changes read', async () => {
  if (!fs.existsSync(repo)) buildFixture(repo)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-bench-'))
  /** The caches the read keeps in the workspace, besides the private index. */
  const dropFiles = (): void => {
    for (const k of ['committed', 'staged', 'unstaged', 'lists', 'body']) fs.rmSync(`${scratch}/yaac-changes.idx.${k}`, { force: true })
  }
  const forget = (): void => { forgetWorkspaceChanges('bench') }
  let last = { bytes: 0, execs: 0 }
  installFakeWorkspaceDriver({
    exec: (_job, cmd, opts) => {
      last.execs++
      try {
        const stdout = execFileSync('sh', ['-c', cmd], {
          input: opts?.stdin ?? '', encoding: 'utf8', maxBuffer: 256 << 20, env: { ...process.env, ...GIT_ENV },
        })
        last.bytes += Buffer.byteLength(stdout)
        return Promise.resolve({ stdout, stderr: '' })
      } catch (err) {
        const e = err as { status: number; stdout: string; stderr: string }
        return Promise.reject(new WorkspaceExecError(`exited ${e.status}: ${e.stderr}`, e.status, e.stdout, e.stderr))
      }
    },
    workspacePaths: () => workspacePathsFixture({ workspaceDir: repo, scratchDir: scratch }),
  })

  const DEF: ChangesRequest = { defaultBase: 'main', diff: true, listing: 'full' }
  const BAR: ChangesRequest = { ...DEF, diff: false, listing: 'paths' }
  const poll = async (label: string, req: ChangesRequest, before?: () => void, n = 3): Promise<void> => {
    const times: number[] = []
    let files = 0
    for (let k = 0; k < n; k++) {
      before?.()
      last = { bytes: 0, execs: 0 }
      const t = performance.now()
      files = (await readWorkspaceChanges('bench', req)).changes.files.length
      times.push(Math.round(performance.now() - t))
    }
    console.log(`${label.padEnd(56)} ms=${times.join(',').padEnd(20)} out=${(last.bytes / 1024).toFixed(0)}KiB `
      + `execs=${last.execs} files=${files}`)
  }
  let edit = 0
  const append = (rel: string) => (): void => { fs.appendFileSync(path.join(repo, rel), `edit ${edit++}\n`) }
  const tracked = git(repo, ['diff', '--name-only', '--diff-filter=M', 'main', 'HEAD']).split('\n')[0]
  const added = git(repo, ['diff', '--name-only', '--diff-filter=A', 'main', 'HEAD']).split('\n')[0]

  try {
    await poll('cold: no private index, nothing cached', DEF, () => {
      forget(); dropFiles(); fs.rmSync(`${scratch}/yaac-changes.idx`, { force: true })
    }, 1)
    await poll('warm index, nothing cached', DEF, () => { forget(); dropFiles() })
    await poll('  same, the status bar (no body, paths)', BAR, () => { forget(); dropFiles() })
    await poll('idle', DEF)
    await poll('idle, the status bar', BAR)
    await poll('idle after a server restart', DEF, forget)
    await poll('idle, the server holding nothing, no files', DEF, () => { forget(); dropFiles() }, 1)
    await poll('edit to a file the base has', DEF, append(tracked))
    await poll('  same, the status bar', BAR, append(tracked))
    await poll('  same, after a server restart', DEF, () => { append(tracked)(); forget() })
    await poll('edit to a file the agent added', DEF, append(added))
    await poll('a new untracked file', DEF, () => { fs.writeFileSync(path.join(repo, `bench-new-${edit++}.txt`), 'new\n') })
    await poll('two bases alternating, each switch', DEF, undefined, 1)
    for (let k = 0; k < 2; k++) {
      await poll('  -> HEAD', { ...DEF, base: 'agent/x' }, undefined, 1)
      await poll('  -> main', DEF, undefined, 1)
    }
    const build = Number(process.env.BENCH_BUILD ?? 0)
    if (build) {
      const dir = path.join(repo, 'bench-build')
      await poll(`first poll after a ${build}-file build folder appears`, DEF, () => { writeBuild(dir, build, 'a') }, 1)
      await poll('  idle', DEF)
      await poll('  edit to a file the agent added', DEF, append(added))
      await poll('  first poll after a rebuild rewrites every file', DEF, () => { writeBuild(dir, build, 'b') }, 1)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    for (const f of fs.readdirSync(repo)) if (f.startsWith('bench-new-')) fs.rmSync(path.join(repo, f))
    git(repo, ['checkout', '-q', '--', tracked, added])
    forget()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}, 3_600_000)
