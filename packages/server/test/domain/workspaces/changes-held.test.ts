import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  forgetWorkspaceChanges,
  type ChangesReading,
  type ChangesRequest,
} from '#domain/workspaces/changes'
import { filled, git, workspace } from '#test/support/changes-workspace'

// What the changes read holds between reads, so a poll costs only what
// moved. The rest of `readWorkspaceChanges` is in changes.test.ts.

describe('readWorkspaceChanges', () => {
  // A file's numstat row and body part are a function of its raw line and
  // the diff settings, so every answer, whatever the server holds, must
  // match a read from nothing: after each kind of change, including
  // settings that change every file's diff mid-session. A change costs the
  // fill of the files it touched alone, whatever kind of file each is, and a
  // second base, as a range pane ending at the working tree polls beside
  // the workspace's own, costs nothing once both are held. Each scan is
  // slow, so changes are batched and a read is checked against a fresh one
  // only where its answer is not already known.
  it('answers from what it holds as a read from nothing would, filling only what changed', async () => {
    const w = workspace()
    const { repo } = w
    const file = (n: number): string => path.join(repo, `src/f${String(n).padStart(2, '0')}.txt`)
    fs.mkdirSync(path.join(repo, 'src'))
    for (let n = 0; n < 12; n++) fs.writeFileSync(file(n), `line ${n}\n`.repeat(20))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'files')
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    for (let n = 0; n < 8; n++) fs.appendFileSync(file(n), `edit ${n}\n`)
    git(repo, 'mv', 'src/f11.txt', 'moved.txt')
    fs.writeFileSync(path.join(repo, 'added.txt'), 'new\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'work')
    // Uncommitted work on top: edits, and files the agent never added.
    for (let n = 8; n < 10; n++) fs.appendFileSync(file(n), `edit ${n}\n`)
    for (let n = 0; n < 3; n++) fs.writeFileSync(path.join(repo, `new${n}.txt`), `n${n}\n`)
    /** Read, keeping the answer as `last`, and return the paths its fill
     *  read. */
    let last!: ChangesReading['changes']
    const readFills = async (r: Partial<ChangesRequest> = {}): Promise<string[]> => {
      const before = w.runs.length
      last = (await w.read(r)).changes
      return filled(w.runs.slice(before))
    }
    /** As `readFills`, checking the answer against a read from nothing. */
    const expectRead = async (r: Partial<ChangesRequest> = {}): Promise<string[]> => {
      const fills = await readFills(r)
      expect(last).toEqual((await w.fresh(r)).changes)
      return fills
    }
    /** A read of what is held, which must scan once, print no pair, and
     *  answer `held`. */
    const expectHeld = async (r: Partial<ChangesRequest>, held: ChangesReading['changes']): Promise<void> => {
      const at = w.runs.length
      expect((await w.read(r)).changes).toEqual(held)
      expect(w.runs.slice(at).map((run) => run.out)).toEqual([expect.not.stringContaining('@@RAW@@')])
    }

    expect(await readFills()).toHaveLength(15)
    await expectHeld({}, last)

    // An edit to a file the base has, one to a file the agent added, a new
    // file, a file put back as the base had it, a mode change, a deleted
    // untracked file, a typechange (two body parts for its one row) and a
    // quoted name (sorted by its bytes). A read with no body fills only the
    // counts, and the next with one the parts, of which the file put back
    // has none: the body is the base diff, where it no longer appears.
    fs.appendFileSync(file(3), 'more\n')
    fs.appendFileSync(file(5), 'more\n')
    fs.appendFileSync(path.join(repo, 'added.txt'), 'more\n')
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u\n')
    fs.writeFileSync(file(7), 'line 7\n'.repeat(20))
    fs.chmodSync(file(2), 0o755)
    fs.rmSync(path.join(repo, 'new2.txt'))
    fs.rmSync(file(10))
    fs.symlinkSync('../moved.txt', file(10))
    fs.writeFileSync(path.join(repo, 'src/café.txt'), 'c\n')
    const changed = ['"src/caf\\303\\251.txt"', 'added.txt', 'src/f02.txt', 'src/f03.txt', 'src/f05.txt', 'src/f07.txt', 'src/f10.txt', 'untracked.txt']
    expect(await readFills({ diff: false })).toEqual(changed)
    expect(await expectRead()).toEqual(changed.filter((p) => p !== 'src/f07.txt'))

    // Staging an edit and committing it read nothing: the staged line is
    // the unstaged one it replaces, and the committed one the base diff's.
    git(repo, 'add', 'src/f05.txt')
    expect(await expectRead()).toEqual([])
    git(repo, 'commit', '-qm', 'f05')
    expect(await expectRead()).toEqual([])

    // Another base: once both are held, switching prints no pair.
    const own = last
    expect(await expectRead({ base: 'agent/x' })).not.toEqual([])
    await expectHeld({}, own)
    await expectHeld({ base: 'agent/x' }, last)

    // An attribute can turn another file binary, and the diff config can
    // turn rename pairing off; either changes every file's key. Color never
    // reaches the body, and the ids' length is keyed.
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'src/f01.txt -diff\n')
    expect(await expectRead()).toEqual(expect.arrayContaining(last.files.map((f) => f.path)))
    expect(last.files.find((f) => f.path === 'src/f01.txt')?.binary).toBe(true)
    git(repo, 'config', 'diff.renames', 'false')
    git(repo, 'config', 'color.ui', 'always')
    git(repo, 'config', 'core.abbrev', '12')
    expect(await expectRead()).not.toEqual([])
    expect(last.files.find((f) => f.path === 'moved.txt')?.status).toBe('added')
    expect(last.diff).toMatch(/^diff --git /)
    expect(last.diff).toMatch(/^index [0-9a-f]{12}\.\./m)
  })

  // A fill reads the lines it lacks by path, and git pairs renames among
  // the paths it is given alone. Where that differs from the whole pair (a
  // rename limit the whole pair passed), the fill's lines say so and the
  // whole pair is read instead; past 300 lines it is read whole anyway.
  it('fills by path, reading the whole pair when the paths pair differently or are too many', async () => {
    const w = workspace()
    const { repo } = w
    const body = (n: number): string => Array.from({ length: 20 }, (_, l) => `${n} line ${l}\n`).join('')
    for (let n = 0; n < 3; n++) fs.writeFileSync(path.join(repo, `old${n}.txt`), body(n))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'old')
    git(repo, 'checkout', '-q', '-b', 'agent/x')
    git(repo, 'config', 'diff.renameLimit', '2')
    const fills = (from: number): string[] => w.runs.slice(from).filter((r) => r.out.startsWith('@@PAIR@@')).map((r) => r.cmd)

    // Two files replaced by unlike ones, then one moved with a line changed:
    // three added and three deleted is past the limit, so the whole pair
    // pairs none, while the moved file's two paths alone would pair.
    for (let n = 1; n < 3; n++) {
      fs.rmSync(path.join(repo, `old${n}.txt`))
      fs.writeFileSync(path.join(repo, `new${n}.txt`), 'unlike\n'.repeat(n))
    }
    await w.read()
    fs.rmSync(path.join(repo, 'old0.txt'))
    fs.writeFileSync(path.join(repo, 'new0.txt'), `${body(0)}changed\n`)
    const before = w.runs.length
    const moved = (await w.read()).changes
    const [byPath, whole] = fills(before)
    expect(byPath).toContain("'--' 'new0.txt'")
    expect(whole).not.toContain("'--'")
    expect(moved).toEqual((await w.fresh()).changes)
    expect(moved.files.filter((f) => f.path.endsWith('0.txt')).map((f) => f.status)).toEqual(['added', 'deleted'])

    for (let n = 0; n < 301; n++) fs.writeFileSync(path.join(repo, `many${n}.txt`), `${n}\n`)
    const many = w.runs.length
    const read = (await w.read()).changes
    expect(fills(many)).toHaveLength(1)
    expect(fills(many)[0]).not.toContain("'--'")
    expect(read).toEqual((await w.fresh()).changes)
  })

  // What the fills read is kept in a file in the workspace's scratch,
  // written through the next scan's stdin, so a server restart costs a scan
  // and the file read back rather than a fill. A line cut short by a killed
  // write is dropped and the file replaced, as it is once it passes twice
  // the size of what is live.
  it('carries what it filled across a server restart in a file in scratch', async () => {
    const w = workspace()
    const entries = path.join(w.scratch(), 'yaac-changes.idx.entries')
    const lines = (): string[] => fs.readFileSync(entries, 'utf8').split('\n').filter(Boolean)
    for (let n = 0; n < 5; n++) fs.writeFileSync(path.join(w.repo, `f${n}.txt`), `${n}\n`)
    git(w.repo, 'add', '-A')
    git(w.repo, 'commit', '-qm', 'files')
    git(w.repo, 'checkout', '-q', '-b', 'agent/x')
    for (let n = 0; n < 5; n++) fs.appendFileSync(path.join(w.repo, `f${n}.txt`), 'edit\n')
    const restarted = async (): Promise<{ changes: ChangesReading['changes']; execs: number }> => {
      forgetWorkspaceChanges('ws')
      const before = w.runs.length
      const { changes } = await w.read()
      return { changes, execs: w.runs.length - before }
    }

    // The counts first, then the parts, each written by the next scan.
    await w.read({ diff: false })
    const first = (await w.read()).changes
    await w.read()
    // Each file's line, the same in the base diff and the unstaged one, as
    // counts and then with its part.
    expect(lines()).toHaveLength(10)
    expect(await restarted()).toEqual({ changes: first, execs: 1 })

    fs.appendFileSync(entries, '{"k":"cut sho')
    expect(await restarted()).toEqual({ changes: first, execs: 1 })
    await w.read()
    expect(lines().map((l) => (JSON.parse(l) as { k: string }).k)).toHaveLength(5)

    // A line that is not an entry is dropped too, and so is a file past its
    // bound, unread; either way the file is replaced.
    const wrong = lines().map((l) => JSON.parse(l) as Record<string, unknown>)
    wrong[0].p = 5
    fs.writeFileSync(entries, wrong.map((e) => `${JSON.stringify(e)}\n`).join(''))
    expect((await restarted()).changes).toEqual(first)
    await w.read()
    expect(lines().every((l) => typeof (JSON.parse(l) as { p: unknown }).p === 'string')).toBe(true)
    w.rewrite((cmd) => cmd.replace(/-gt \d+ \] \|\| \{ printf "@@ENTRIES@@/, '-gt 10 ] || { printf "@@ENTRIES@@'))
    expect((await restarted())).toEqual({ changes: first, execs: 2 })
    w.rewrite((cmd) => cmd)
    await w.read()
    expect(lines()).toHaveLength(5)

    for (let k = 0; k < 12; k++) {
      fs.appendFileSync(path.join(w.repo, 'f0.txt'), `edit ${k}\n`)
      await w.read()
    }
    expect(lines().length).toBeLessThanOrEqual(12)
    expect((await restarted()).changes).toEqual((await w.fresh()).changes)
  })
})
