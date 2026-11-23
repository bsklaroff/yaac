import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  CHANGES_BASE_UNRESOLVED,
  MAX_UNTRACKED_FILE_BYTES,
  MAX_UNTRACKED_FOLDER_FILES,
  readWorkspaceChanges,
  type ChangesReading,
  type ChangesRequest,
} from '#domain/workspaces/changes'
import { WorkspaceExecError } from '#drivers/contract'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { exec, filled, git, partsOf, workspace } from '#test/support/changes-workspace'

// The caps and failures of the changes read: outputs too large for one
// exec, files and folders too large to stage, timeouts. The rest of
// `readWorkspaceChanges` is in changes.test.ts.

describe('readWorkspaceChanges', () => {
  // One huge file is cut at its own cap rather than using up the body, so
  // the files after it keep their parts, and an edit after it reads only
  // that file's part.
  it('cuts a huge file\'s diff short, keeping the parts of the files after it', async () => {
    const w = workspace()
    const file = (name: string): string => path.join(w.repo, name)
    for (const name of ['edit.txt', 'gone.txt', 'mode.sh', 'old.txt']) fs.writeFileSync(file(name), `${name}\n`.repeat(20))
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'files')
    fs.writeFileSync(file('big.txt'), `${'x'.repeat(60)}\n`.repeat(20_000))
    fs.appendFileSync(file('edit.txt'), 'more\n')
    fs.rmSync(file('gone.txt'))
    fs.chmodSync(file('mode.sh'), 0o755)
    fs.renameSync(file('old.txt'), file('renamed.txt'))

    const first = (await w.read()).changes
    expect(first.truncated).toBe(true)
    const got = partsOf(first.diff)
    expect([...got.keys()]).toEqual(['big.txt', 'edit.txt', 'gone.txt', 'mode.sh', 'renamed.txt'])
    expect(got.get('big.txt')).toMatch(/\n\+x+\n@@CUT@@\n$/)
    expect(Buffer.byteLength(got.get('big.txt')!)).toBeLessThan(260_000)
    expect(got.get('edit.txt')).toContain('\n+more\n')
    expect(got.get('gone.txt')).toContain('\n-gone.txt\n')
    expect(got.get('mode.sh')).toContain('\nnew mode 100755\n')
    expect(got.get('renamed.txt')).toContain('\nrename from old.txt\n')

    fs.appendFileSync(file('edit.txt'), 'again\n')
    const before = w.runs.length
    const edited = (await w.read()).changes
    expect(filled(w.runs.slice(before))).toEqual(['edit.txt'])
    expect(partsOf(edited.diff).get('edit.txt')).toContain('\n+again\n')
    expect(edited).toEqual((await w.fresh()).changes)
  })

  // A big checkout's first read, and any whose listing moved, prints more
  // than an exec can carry, so it is fetched in pages. The listing is held
  // and printed again only when a path or an ignored entry came or went.
  it('pages an output over the exec cap, and prints the listing only when it moved', async () => {
    const pageBytes = 4096
    const w = workspace({ pageBytes })
    const dir = path.join(w.repo, 'a-folder-with-a-rather-long-name/and-another-one')
    fs.mkdirSync(dir, { recursive: true })
    for (let n = 0; n < 300; n++) fs.writeFileSync(path.join(dir, `file-${n}-also-named-at-length.txt`), `${n}\n`)
    fs.writeFileSync(path.join(w.repo, '.gitignore'), '*.log\n')
    // A submodule whose changes git is told to ignore.
    const sm = path.join(w.repo, 'sm')
    fs.mkdirSync(sm)
    git(sm, 'init', '-q')
    git(sm, 'commit', '-q', '--allow-empty', '-m', 'sm')
    fs.writeFileSync(path.join(w.repo, '.gitmodules'), '[submodule "sm"]\n\tpath = sm\n\turl = ./sm\n\tignore = all\n')
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'files')
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    for (let n = 0; n < 100; n++) fs.appendFileSync(path.join(dir, `file-${n}-also-named-at-length.txt`), 'edit\n')
    fs.writeFileSync(path.join(w.repo, 'link'), '')
    const request: Partial<ChangesRequest> = { listing: 'full' }
    /** A read, whether its scan was paged, and which listing parts it printed. */
    const read = async (r = request): Promise<{ reading: ChangesReading; printed: string; paged: boolean }> => {
      const before = w.runs.length
      const reading = await w.read(r)
      const [scan, ...rest] = w.runs.slice(before)
      const paged = scan.out.startsWith('PAGED ')
      const out = paged
        ? Buffer.concat(rest.filter((p) => p.cmd.startsWith('tail -c')).map((p) => Buffer.from(p.out, 'base64'))).toString()
        : scan.out
      const printed = [out.includes('\n@@PATHS@@\n') && 'paths', out.includes('\n@@IGNORED@@\n') && 'extras'].filter(Boolean).join(' ')
      return { reading, printed, paged }
    }
    const leftovers = (): string[] => fs.readdirSync(w.scratch()).filter((f) => f.includes('.out.'))
    const same = async (r = request): Promise<ChangesReading> => {
      const { readMs: _ms, ...fresh } = await w.fresh(r)
      return { ...fresh, readMs: expect.any(Number) as number }
    }

    const first = await read()
    expect(first).toMatchObject({ printed: 'paths extras', paged: true })
    expect(first.reading.changes.files).toHaveLength(101)
    expect(first.reading.changes.diff).toContain('+edit')
    expect(first.reading.listing?.paths).toHaveLength(305)
    expect(first.reading.listing?.ignored).toEqual([])
    // The scan's output and the fill's.
    expect(leftovers()).toHaveLength(2)

    // Nothing moved: no listing, no pair, and the next run clears the file.
    const idle = await read()
    expect(idle).toMatchObject({ printed: '', paged: false })
    expect(idle.reading).toEqual({ ...first.reading, readMs: idle.reading.readMs })
    expect(leftovers()).toEqual([])

    // An edit leaves the paths as held; an ignored file reprints only
    // those; a retyped path reprints the paths.
    fs.appendFileSync(path.join(dir, 'file-200-also-named-at-length.txt'), 'edit\n')
    expect((await read()).printed).toBe('')
    fs.writeFileSync(path.join(w.repo, 'debug.log'), '')
    const ignored = await read()
    expect(ignored).toMatchObject({ printed: 'extras', paged: false })
    expect(ignored.reading.listing?.ignored).toEqual(['debug.log'])
    fs.rmSync(path.join(w.repo, 'link'))
    fs.symlinkSync('.gitignore', path.join(w.repo, 'link'))
    const retyped = await read()
    expect(retyped.printed).toBe('paths')
    expect(retyped.reading.listing?.links).toEqual(['link'])
    expect(retyped.reading).toEqual(await same())

    // A paths listing leaves the held extras out, and keeps them.
    const paths = await read({ listing: 'paths' })
    expect(paths.printed).toBe('')
    expect(paths.reading.listing).toEqual({ paths: retyped.reading.listing!.paths, links: ['link'], conflicted: [] })
    expect((await read()).printed).toBe('')

    // `ls-files` lists a gitlink whatever `.gitmodules` says, so deleting
    // one reprints the paths.
    fs.rmSync(sm, { recursive: true })
    const unlinked = await read()
    expect(unlinked.printed).toBe('paths')
    expect(unlinked.reading.listing?.paths).not.toContain('sm')
    expect(unlinked.reading).toEqual(await same())
  })

  // Callers map the exit code (a bad base is a 400), and a transport failure
  // says nothing about the base, so both arrive as the driver raised them.
  it('passes a failed run and a transport failure through untranslated', async () => {
    installFakeWorkspaceDriver({ exec })
    const badBase = new WorkspaceExecError('command exited 4', CHANGES_BASE_UNRESOLVED, '', '')
    exec.mockRejectedValueOnce(badBase)
    await expect(readWorkspaceChanges('yaac-proj-abc', { base: 'nope', diff: true })).rejects.toBe(badBase)
    const dial = new Error('connection refused')
    exec.mockRejectedValueOnce(dial)
    await expect(readWorkspaceChanges('yaac-proj-abc', { base: 'dev', diff: true })).rejects.toBe(dial)
  })

  // A run cut off mid-staging saves no index, so until a read succeeds each
  // gets the longer timeout, long enough for a cold index to be staged. An
  // abandoned read leaves the index as warm as it was.
  it('gives a read the longer timeout until one succeeds, and again after one fails', async () => {
    const w = workspace()
    const timeouts = (): (number | undefined)[] => exec.mock.calls.filter((c) => c[1].includes('yaac-changes')).map((c) => c[2]?.timeout)

    await w.read()
    await w.read()
    exec.mockRejectedValueOnce(new Error('stream read timeout'))
    await expect(w.read()).rejects.toThrow('stream read timeout')
    await w.read()
    const caller = new AbortController()
    exec.mockImplementationOnce((_job, _cmd, opts) => new Promise((_, reject) => {
      opts!.signal!.addEventListener('abort', () => { reject(opts!.signal!.reason as Error) })
      caller.abort()
    }))
    await expect(readWorkspaceChanges('ws', { defaultBase: 'main', diff: true }, caller.signal)).rejects.toThrow()
    await w.read()
    expect(timeouts()).toEqual([120_000, 20_000, 20_000, 120_000, 20_000, 20_000])
  })

  // An untracked folder too large to stage is left out, so an unignored
  // build output cannot stall every read. It counts only files no ignore
  // pattern covers, less those of a folder already left out below it, and
  // its tracked files are still diffed. So is an untracked file too large
  // to hold in scratch, which the listing still names. A `.gitattributes`
  // staging leaves out applies neither to a cached read nor to a fresh one.
  it('leaves out untracked folders and files over the size limits, still diffing tracked files', async () => {
    const w = workspace()
    const write = (dir: string, n: number): void => {
      fs.mkdirSync(path.join(w.repo, dir), { recursive: true })
      for (let k = 0; k < n; k++) fs.writeFileSync(path.join(w.repo, dir, `f${k}.js`), `${dir} ${k}\n`)
    }
    fs.writeFileSync(path.join(w.repo, '.gitignore'), 'node_modules/\n')
    write('build', 1)
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'build')
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    w.rewrite((cmd) => cmd.replaceAll(`>${MAX_UNTRACKED_FOLDER_FILES}`, '>5').replaceAll(`+${MAX_UNTRACKED_FILE_BYTES}c`, '+100c'))
    const read = (): Promise<ChangesReading> => w.read({ listing: 'paths' })
    const changed = (r: ChangesReading): string[] => r.changes.files.map((f) => f.path)

    write('build/m0', 4)
    const under = await read()
    expect(under.changes.skipped).toBeUndefined()
    expect(changed(under)).toEqual(['build/m0/f0.js', 'build/m0/f1.js', 'build/m0/f2.js', 'build/m0/f3.js'])

    write('build/m1', 4)
    write('out/big', 7)
    write('out', 1)
    write('newpkg', 3)
    write('newpkg/node_modules/dep', 10)
    fs.appendFileSync(path.join(w.repo, 'build/f0.js'), 'edited\n')
    const over = await read()
    expect(over.changes.skipped?.sort()).toEqual(['build/', 'out/big/'])
    expect(changed(over)).toEqual(['build/f0.js', 'newpkg/f0.js', 'newpkg/f1.js', 'newpkg/f2.js', 'out/f0.js'])
    expect(over.changes.files[0].stages).toEqual({ modified: { additions: 1, deletions: 0 } })
    expect(over.listing?.paths.filter((p) => p.startsWith('build/') || p.startsWith('out/big/'))).toEqual(['build/f0.js'])
    expect(git(w.repo, 'status', '--porcelain', '--', 'build')).toBe(' M build/f0.js\n?? build/m0/\n?? build/m1/\n')

    // A folder whose name git quotes is read from the tree unquoted.
    fs.mkdirSync(path.join(w.repo, 'café'))
    fs.writeFileSync(path.join(w.repo, 'café/f0.js'), 'c\n')
    git(w.repo, 'add', 'café')
    git(w.repo, 'commit', '-qm', 'café')
    fs.appendFileSync(path.join(w.repo, 'café/f0.js'), 'edited\n')
    await read()
    for (const attrs of ['build/.gitattributes', '.gitattributes', 'café/.gitattributes']) {
      fs.writeFileSync(path.join(w.repo, attrs), 'f0.js -diff\n')
      if (attrs === '.gitattributes') fs.appendFileSync(path.join(w.repo, '.gitignore'), '/.gitattributes\n')
      expect((await read()).changes).toEqual((await w.fresh({ listing: 'paths' })).changes)
      expect((await read()).changes.files.find((f) => f.path === 'build/f0.js')?.binary).toBe(false)
      fs.rmSync(path.join(w.repo, attrs))
      expect((await read()).changes).toEqual((await w.fresh({ listing: 'paths' })).changes)
    }

    fs.writeFileSync(path.join(w.repo, 'big.bin'), 'x'.repeat(200))
    const large = await read()
    expect(large.changes.skipped?.sort()).toEqual(['big.bin', 'build/', 'out/big/'])
    expect(changed(large)).not.toContain('big.bin')
    expect(large.listing?.paths).toContain('big.bin')
    expect(git(w.repo, 'status', '--porcelain', '--', 'big.bin')).toBe('?? big.bin\n')
    fs.rmSync(path.join(w.repo, 'big.bin'))

    fs.rmSync(path.join(w.repo, 'build/m1'), { recursive: true })
    const back = await read()
    expect(back.changes.skipped).toEqual(['out/big/'])
    expect(changed(back).filter((p) => p.startsWith('build/'))).toEqual([
      'build/f0.js', 'build/m0/f0.js', 'build/m0/f1.js', 'build/m0/f2.js', 'build/m0/f3.js',
    ])
  })
})
