import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { setDataDir, worktreeLinksDir, claudeDir, codexDir } from '@yaac/shared/project-paths'
import {
  clearPanePointers,
  readAllWorktreeLinks,
  readWorktreeLinks,
} from '#features/agents/agent-links'

/**
 * The agent-session link tree, end to end: the real hook script writes it and
 * the real reader reads it back.
 *
 * The script is extracted verbatim from `dockerfiles/Dockerfile.tools` rather
 * than duplicated here, so the copy under test is the copy that ships and no
 * drift guard is needed. It only depends on `sh`, `sed`, `python3`, `basename`
 * and `ln`, so it runs directly on the test host — no container. The tool home
 * is an argument (that is why the baked script takes one), which is all the
 * parameterization the test needs.
 */

/** The hook script as baked into the image, sliced out of its heredoc. */
async function bakedHookScript(): Promise<string> {
  const dockerfile = await fs.readFile(
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'dockerfiles', 'Dockerfile.tools'),
    'utf8',
  )
  const start = dockerfile.indexOf("cat <<'HOOK' > /etc/yaac/agent-links.sh\n")
  expect(start, 'agent-links.sh heredoc not found in Dockerfile.tools').toBeGreaterThan(-1)
  const body = dockerfile.slice(dockerfile.indexOf('\n', start) + 1)
  const end = body.indexOf('\nHOOK\n')
  expect(end, 'unterminated agent-links.sh heredoc').toBeGreaterThan(-1)
  return body.slice(0, end + 1)
}

describe('agent-session link tree', () => {
  let tmpDir: string
  let scriptPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-agent-links-'))
    setDataDir(path.join(tmpDir, 'data'))
    scriptPath = path.join(tmpDir, 'agent-links.sh')
    await fs.writeFile(scriptPath, await bakedHookScript(), { mode: 0o755 })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  /** Run the hook the way a tool would: payload on stdin, home as argv. */
  async function runHook(
    home: string,
    payload: Record<string, unknown>,
    env: Record<string, string> = {},
  ): Promise<void> {
    await fs.mkdir(home, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'sh',
        [scriptPath, home],
        { env: { ...process.env, YAAC_SESSION_ID: 'wt-1', ...env } },
        (err) => (err ? reject(err instanceof Error ? err : new Error('hook failed')) : resolve()),
      )
      child.stdin?.end(JSON.stringify(payload))
    })
  }

  /**
   * A transcript where the tool actually writes one: under its own home
   * (`.claude/projects/…`, `.codex/sessions/…`). That the transcript lives
   * under the home is what lets the hook record a home-relative path.
   */
  async function writeTranscript(
    home: string,
    rel: string,
    content = '{"type":"user"}\n',
  ): Promise<string> {
    const file = path.join(home, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
    return file
  }

  /**
   * The tree the hook wrote before records replaced symlinks:
   * `sessions/<agentSessionId>.jsonl` is a symlink whose target is relative to
   * `sessions/`, and the pane pointer is unchanged. Every worktree that ran
   * before the upgrade has one of these on disk, and a pod launched from an
   * older image goes on writing them, so the reader must still understand it.
   */
  async function writeLegacyLink(
    tool: 'claude' | 'codex',
    agentSessionId: string,
    transcript: string,
    paneId?: string,
  ): Promise<void> {
    const dir = worktreeLinksDir('proj', tool, 'wt-1')
    const sessions = path.join(dir, 'sessions')
    await fs.mkdir(sessions, { recursive: true })
    await fs.symlink(
      path.relative(sessions, transcript),
      path.join(sessions, `${agentSessionId}.jsonl`),
    )
    if (paneId !== undefined) {
      await fs.mkdir(path.join(dir, 'panes'), { recursive: true })
      await fs.writeFile(path.join(dir, 'panes', paneId.slice(1)), `${agentSessionId}\n`)
    }
  }

  /** A transcript somewhere no tool home covers. */
  async function writeTranscriptOutside(rel: string): Promise<string> {
    const file = path.join(tmpDir, 'elsewhere', rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{"type":"user"}\n')
    return file
  }

  describe('readWorktreeLinks', () => {
    it('links a started conversation, with a relative record and a pane pointer', async () => {
      const home = claudeDir('proj')
      const transcript = await writeTranscript(home, 'projects/-workspace/conv-a.jsonl')
      await runHook(home, {
        session_id: 'conv-a',
        transcript_path: transcript,
        hook_event_name: 'SessionStart',
        source: 'startup',
      }, { TMUX_PANE: '%0' })

      const links = await readWorktreeLinks('proj', 'claude', 'wt-1')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        agentSessionId: 'conv-a',
        tool: 'claude',
        transcriptPath: await fs.realpath(transcript),
        paneIds: ['%0'],
      })

      // The record is a plain file holding a path RELATIVE to the tool home:
      // the hook only ever sees the in-pod path, and the reader joins the
      // host-side home back on. Nothing in the tree is a symlink, and nothing
      // encodes a path that only resolves inside the container.
      const record = path.join(worktreeLinksDir('proj', 'claude', 'wt-1'), 'sessions', 'conv-a')
      expect((await fs.lstat(record)).isSymbolicLink()).toBe(false)
      const recorded = (await fs.readFile(record, 'utf8')).trim()
      expect(recorded.startsWith('/')).toBe(false)
      expect(path.join(home, recorded)).toBe(await fs.realpath(transcript))
    })

    it('records /clear as a second conversation that takes over the pane', async () => {
      const home = claudeDir('proj')
      const first = await writeTranscript(home, 'projects/-workspace/conv-a.jsonl')
      await runHook(home, { session_id: 'conv-a', transcript_path: first }, { TMUX_PANE: '%0' })
      const second = await writeTranscript(home, 'projects/-workspace/conv-b.jsonl')
      await runHook(home, {
        session_id: 'conv-b',
        transcript_path: second,
        source: 'clear',
      }, { TMUX_PANE: '%0' })

      const links = await readWorktreeLinks('proj', 'claude', 'wt-1')
      // Both are history; only the new one still owns the pane, which is what
      // makes the old one inactive once the registry cross-checks live panes.
      expect(links.map((l) => l.agentSessionId)).toEqual(['conv-a', 'conv-b'])
      expect(links.find((l) => l.agentSessionId === 'conv-a')?.paneIds).toEqual([])
      expect(links.find((l) => l.agentSessionId === 'conv-b')?.paneIds).toEqual(['%0'])
    })

    it('keeps two conversations on separate panes (a second terminal)', async () => {
      const home = claudeDir('proj')
      await runHook(home, {
        session_id: 'conv-a',
        transcript_path: await writeTranscript(home, 't/conv-a.jsonl'),
      }, { TMUX_PANE: '%0' })
      await runHook(home, {
        session_id: 'conv-b',
        transcript_path: await writeTranscript(home, 't/conv-b.jsonl'),
      }, { TMUX_PANE: '%4' })

      const links = await readWorktreeLinks('proj', 'claude', 'wt-1')
      expect(links.map((l) => [l.agentSessionId, l.paneIds])).toEqual([
        ['conv-a', ['%0']],
        ['conv-b', ['%4']],
      ])
    })

    it('keeps every pane pointing at a conversation resumed onto a second one', async () => {
      const home = claudeDir('proj')
      const transcript = await writeTranscript(home, 't/conv-a.jsonl')
      await runHook(home, { session_id: 'conv-a', transcript_path: transcript }, { TMUX_PANE: '%0' })
      await runHook(home, {
        session_id: 'conv-a',
        transcript_path: transcript,
        source: 'resume',
      }, { TMUX_PANE: '%7' })

      const links = await readWorktreeLinks('proj', 'claude', 'wt-1')
      // The pane it moved off still points at it until that pane's exit is
      // observed; ordering is by pane number, not readdir order.
      expect(links).toHaveLength(1)
      expect(links[0]?.paneIds).toEqual(['%0', '%7'])
    })

    it('falls back to the transcript basename when the payload omits session_id', async () => {
      // Codex names its rollout file after the conversation; this is the guard
      // for a tool that ever stops sending the id outright.
      await runHook(codexDir('proj'), {
        transcript_path: await writeTranscript(codexDir('proj'), 'sessions/2026/04/15/rollout-xyz.jsonl'),
      })
      const links = await readWorktreeLinks('proj', 'codex', 'wt-1')
      expect(links.map((l) => l.agentSessionId)).toEqual(['rollout-xyz'])
    })

    it('writes nothing without a worktree id, a home, or any identifiable id', async () => {
      const home = claudeDir('proj')
      const transcript = await writeTranscript(home, 't/conv-a.jsonl')
      await runHook(home, { session_id: 'conv-a', transcript_path: transcript }, { YAAC_SESSION_ID: '' })
      await runHook(home, { hook_event_name: 'SessionStart' })
      expect(await readWorktreeLinks('proj', 'claude', 'wt-1')).toEqual([])
    })

    it('records a conversation whose transcript is outside the tool home', async () => {
      // The conversation is still real and still part of the worktree's
      // history; only its path is inexpressible host-side, so it is recorded
      // without one rather than dropped or given a path resolving nowhere.
      await runHook(claudeDir('proj'), {
        session_id: 'conv-out',
        transcript_path: await writeTranscriptOutside('conv-out.jsonl'),
      })
      const links = await readWorktreeLinks('proj', 'claude', 'wt-1')
      expect(links.map((l) => [l.agentSessionId, l.transcriptPath]))
        .toEqual([['conv-out', undefined]])
    })

    it('reports a removed transcript as a conversation with no transcript', async () => {
      const home = claudeDir('proj')
      const transcript = await writeTranscript(home, 't/conv-a.jsonl')
      await runHook(home, { session_id: 'conv-a', transcript_path: transcript })
      await fs.rm(transcript)

      const links = await readWorktreeLinks('proj', 'claude', 'wt-1')
      // The conversation existed and is still part of the worktree's history;
      // only its last-activity is unknowable.
      expect(links).toHaveLength(1)
      expect(links[0]?.transcriptPath).toBeUndefined()
      expect(links[0]?.lastActiveMs).toBeUndefined()
    })

    it('reads the symlink tree an older hook wrote', async () => {
      // Read as a record file, the symlink would name a phantom conversation
      // `conv-a.jsonl`, hide the real `conv-a` its pane pointer names, and
      // slurp the whole transcript into memory as if it were a path.
      const home = claudeDir('proj')
      const transcript = await writeTranscript(home, 'projects/-workspace/conv-a.jsonl')
      await writeLegacyLink('claude', 'conv-a', transcript, '%0')

      const links = await readWorktreeLinks('proj', 'claude', 'wt-1')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        agentSessionId: 'conv-a',
        transcriptPath: await fs.realpath(transcript),
        paneIds: ['%0'],
      })
    })

    it('records a legacy conversation whose symlink now dangles', async () => {
      const home = claudeDir('proj')
      const transcript = await writeTranscript(home, 'projects/-workspace/conv-a.jsonl')
      await writeLegacyLink('claude', 'conv-a', transcript)
      await fs.rm(transcript)

      const links = await readWorktreeLinks('proj', 'claude', 'wt-1')
      expect(links.map((l) => [l.agentSessionId, l.transcriptPath]))
        .toEqual([['conv-a', undefined]])
    })

    it('collapses a conversation a mid-life upgrade recorded in both formats', async () => {
      // A pod started before the upgrade writes the symlink; the same
      // conversation resumed under the new hook writes a record beside it.
      // One conversation, not two, and the older sighting is the one that
      // orders the history.
      const home = claudeDir('proj')
      const transcript = await writeTranscript(home, 'projects/-workspace/conv-a.jsonl')
      await writeLegacyLink('claude', 'conv-a', transcript)
      await runHook(home, {
        session_id: 'conv-a',
        transcript_path: transcript,
        source: 'resume',
      }, { TMUX_PANE: '%2' })

      const links = await readWorktreeLinks('proj', 'claude', 'wt-1')
      expect(links.map((l) => [l.agentSessionId, l.paneIds]))
        .toEqual([['conv-a', ['%2']]])
      expect(links[0]?.transcriptPath).toBe(await fs.realpath(transcript))
    })

    it('is empty for a worktree whose pod predates the hook', async () => {
      expect(await readWorktreeLinks('proj', 'claude', 'never-linked')).toEqual([])
    })
  })

  describe('readAllWorktreeLinks', () => {
    it('merges the tools a worktree ran, since a home is what identifies one', async () => {
      await runHook(claudeDir('proj'), {
        session_id: 'conv-a',
        transcript_path: await writeTranscript(claudeDir('proj'), 't/conv-a.jsonl'),
      }, { TMUX_PANE: '%0' })
      await runHook(codexDir('proj'), {
        session_id: 'conv-c',
        transcript_path: await writeTranscript(codexDir('proj'), 't/conv-c.jsonl'),
      }, { TMUX_PANE: '%2' })

      const links = await readAllWorktreeLinks('proj', 'wt-1')
      expect(links.map((l) => [l.tool, l.agentSessionId])).toEqual([
        ['claude', 'conv-a'],
        ['codex', 'conv-c'],
      ])
    })
  })

  describe('clearPanePointers', () => {
    it('forgets the previous life\'s panes but keeps the conversation history', async () => {
      const home = claudeDir('proj')
      await runHook(home, {
        session_id: 'conv-a',
        transcript_path: await writeTranscript(home, 't/conv-a.jsonl'),
      }, { TMUX_PANE: '%0' })

      await clearPanePointers('proj', 'wt-1')

      const links = await readWorktreeLinks('proj', 'claude', 'wt-1')
      expect(links.map((l) => l.agentSessionId)).toEqual(['conv-a'])
      expect(links[0]?.paneIds).toEqual([])
    })

    it('is a no-op for a worktree that never linked anything', async () => {
      await expect(clearPanePointers('proj', 'never-linked')).resolves.toBeUndefined()
    })
  })
})
