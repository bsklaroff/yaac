import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { readSessionStarts } from '#domain/worktrees/session-starts'
import { setDataDir, worktreeSessionStartsPath } from '@yaac/shared/project-paths'

/**
 * The POSIX-sh half of the two-writer contract, end to end: the real hook
 * appends and the real reader parses it back.
 *
 * Worth its own file because the two halves can only disagree silently. The
 * hook always exits 0 — it must never take the agent down — so a line it
 * emits in the wrong shape is dropped by `readSessionStarts` with no error
 * anywhere, and the session simply never appears. Nothing else would catch
 * that: the fold's own tests are written against hand-authored lines, which
 * is precisely the copy that cannot drift.
 *
 * The shipped `worktree-bin/yaac-agent-links` is run as-is, unedited — the
 * copy under test is the copy staged into every worktree. That is possible
 * because the script writes to `$HOME`, so the fixture below stands up the
 * exact shape a workspace has: a private home whose `.yaac/session-starts.jsonl`
 * is a link to the worktree's real log, which is what the containerless driver
 * realizes and what the pod driver mounts. It needs only `sh`, `sed`,
 * `basename` and `mkdir`, so it runs on the test host with no container.
 */

/** The staged hook script, as shipped. */
function hookScript(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', '..', 'worktree-bin', 'yaac-agent-links')
}

describe('the SessionStart hook', () => {
  let tmpDir: string
  let workspaceHome: string
  let home: string
  let log: string
  const slug = 'demo'
  const wt = 'wt-1'

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-hook-'))
    setDataDir(path.join(tmpDir, 'data'))
    home = path.join(tmpDir, 'home', '.claude')
    await fs.mkdir(home, { recursive: true })
    log = worktreeSessionStartsPath(slug, wt)
    await fs.mkdir(path.dirname(log), { recursive: true })
    // The workspace's own HOME, wired the way a driver wires it: the log is
    // reached through a link to the worktree's real one, never written twice.
    workspaceHome = path.join(tmpDir, 'workspace-home')
    await fs.mkdir(path.join(workspaceHome, '.yaac'), { recursive: true })
    await fs.writeFile(log, '')
    await fs.symlink(log, path.join(workspaceHome, '.yaac', 'session-starts.jsonl'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  /**
   * Run the hook the way a tool does: payload on stdin, home and its
   * project-relative name as argv, and the workspace's HOME in the
   * environment — which is what tells it where to append.
   */
  async function runHook(
    payload: Record<string, unknown>,
    env: Record<string, string> = {},
    toolHome: string = home,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'sh',
        [hookScript(), toolHome, 'claude'],
        // TMUX_PANE is deliberately NOT inherited: these tests run inside a
        // yaac session, which sets it, and a test asserting "no pane" would
        // otherwise pass or fail on where it was run.
        { env: { ...process.env, TMUX_PANE: '', HOME: workspaceHome, ...env } },
        (err) => (err ? reject(err instanceof Error ? err : new Error('hook failed')) : resolve()),
      )
      child.stdin?.end(JSON.stringify(payload))
    })
  }

  it('emits a line the reader parses, with the path made project-relative', async () => {
    // The transcript is inside the tool home, which is what lets the hook
    // express it at all: it strips the home and prefixes the home's name.
    await runHook({
      session_id: 'conv-a',
      transcript_path: `${home}/projects/-workspace/conv-a.jsonl`,
    }, { TMUX_PANE: '%3' })

    expect((await readSessionStarts(slug, wt)).sightings).toEqual([{
      atByte: 0,
      agentSessionId: 'conv-a',
      tool: 'claude',
      transcriptPath: path.join('claude', 'projects', '-workspace', 'conv-a.jsonl'),
      handle: '%3',
    }])
  })

  it('records the session with no path when the transcript is outside the home', async () => {
    // Unexpressible, not unreal: the session still has to be known, which is
    // why the hook writes an empty field rather than skipping the line.
    await runHook({ session_id: 'conv-b', transcript_path: '/somewhere/else.jsonl' })

    const [seen] = (await readSessionStarts(slug, wt)).sightings
    expect(seen).toMatchObject({ agentSessionId: 'conv-b', tool: 'claude' })
    expect(seen?.transcriptPath).toBeUndefined()
    // No tmux pane in this environment, so nothing is attributed to one.
    expect(seen?.handle).toBeUndefined()
  })

  it('falls back to the transcript basename when the payload omits session_id', async () => {
    // codex names its rollout files after the session, so the basename still
    // identifies it if a tool ever drops the field.
    await runHook({ transcript_path: `${home}/sessions/rollout-xyz.jsonl` })
    expect((await readSessionStarts(slug, wt)).sightings[0]?.agentSessionId).toBe('rollout-xyz')
  })

  it('appends rather than replacing, and every line stays parseable', async () => {
    // The whole two-writer design rests on this: the pod only ever appends,
    // so the server can fold the log into rows without a lock crossing the
    // pod boundary.
    await runHook({ session_id: 'a', transcript_path: `${home}/projects/a.jsonl` })
    await runHook({ session_id: 'b', transcript_path: `${home}/projects/b.jsonl` })

    const { sightings: seen } = await readSessionStarts(slug, wt)
    expect(seen.map((s) => s.agentSessionId)).toEqual(['a', 'b'])
    // Offsets are what let the fold tell this life's lines from the last
    // one's, so they must be real byte positions in the file.
    expect(seen[0]?.atByte).toBe(0)
    expect(seen[1]?.atByte).toBeGreaterThan(0)
    const raw = await fs.readFile(log, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.slice(seen[1]?.atByte ?? 0)).toContain('"id":"b"')
  })

  it('still emits parseable JSON for a path containing a quote', async () => {
    // A quote is legal in a filename, and the hook cannot report a failure —
    // unescaped it would emit a line that parses nowhere, so the session would
    // silently never appear at all. Escaped, the session is recorded.
    //
    // The path itself is NOT guaranteed to survive: the hook reads its input
    // with sed and does not decode the payload's own JSON escapes, so a quote
    // truncates what it extracts. That is a pre-existing limit of a hook that
    // must stay POSIX sh — the point of the escaping is that the *session*
    // survives a path the extractor mangles, rather than the line being lost.
    await runHook({
      session_id: 'conv-q',
      transcript_path: `${home}/projects/we"ird.jsonl`,
    })
    const [seen] = (await readSessionStarts(slug, wt)).sightings
    expect(seen?.agentSessionId).toBe('conv-q')
    expect(seen?.transcriptPath).toMatch(/^claude\/projects\//)
  })

  it('makes the path project-relative through a symlinked tool home', async () => {
    // What a containerless workspace looks like: the tool home in its private
    // HOME is a link to the project's shared one, and a tool that resolves its
    // own paths reports the transcript under the physical directory. The
    // project-relative form has to come out the same either way, or the server
    // cannot find the transcript it names.
    const linked = path.join(workspaceHome, '.claude')
    await fs.symlink(home, linked)
    await fs.mkdir(path.join(home, 'projects'), { recursive: true })

    await runHook(
      { session_id: 'conv-s', transcript_path: `${home}/projects/conv-s.jsonl` },
      {},
      linked,
    )

    expect((await readSessionStarts(slug, wt)).sightings[0]?.transcriptPath)
      .toBe(path.join('claude', 'projects', 'conv-s.jsonl'))
  })

  it('exits 0 and writes nothing when it has no home to work from', async () => {
    // It runs on the agent's startup path; a broken invocation must never
    // take the agent down with it.
    await new Promise<void>((resolve, reject) => {
      const child = execFile('sh', [hookScript()], (err) =>
        (err ? reject(err instanceof Error ? err : new Error('hook failed')) : resolve()))
      child.stdin?.end('{}')
    })
    await expect(fs.readFile(log, 'utf8').catch(() => '')).resolves.toBe('')
  })

  it('exits 0 and writes nothing when the environment has no HOME', async () => {
    // HOME is what says where to append now, so an environment without one is
    // the same class of broken invocation as a missing argument — and must
    // fail the same way, silently and successfully.
    const { HOME: _drop, ...noHome } = process.env
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'sh',
        [hookScript(), home, 'claude'],
        { env: { ...noHome, TMUX_PANE: '' } },
        (err) => (err ? reject(err instanceof Error ? err : new Error('hook failed')) : resolve()),
      )
      child.stdin?.end(JSON.stringify({ session_id: 'x', transcript_path: `${home}/x.jsonl` }))
    })
    await expect(fs.readFile(log, 'utf8')).resolves.toBe('')
  })
})
