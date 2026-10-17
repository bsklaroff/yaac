import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { opencodeCheckpointDir, setDataDir } from '@yaac/shared/project-paths'
import { replayAcpLog, opencodeTranscriptAsAcp } from '#runtime/agents'
import type { AcpEvent } from '@yaac/shared/acp'

/*
 * The fixtures in replay-fixtures/opencode/ are real @opencode/cli 2.0.30
 * output, driven against a scripted model. `live.jsonl` is what
 * `opencode acp` streamed to a client declaring yaac's capabilities over one
 * conversation (shell, write, edit, read, glob, grep, webfetch, failed
 * tools, a subagent, an interrupted command, a question the client cannot
 * show, an image prompt, a provider error), and `rows.jsonl` is the export
 * `yaac-opencode-checkpoint` wrote from the database that same run left.
 * `tui-rows.jsonl` is a conversation driven through the TUI: a `!command`,
 * a subagent, an answered question, an interrupt and a manual `/compact`.
 */
const fixture = (name: string): Promise<string> =>
  fs.readFile(path.join(import.meta.dirname, 'replay-fixtures/opencode', name), 'utf8')
const rowsOf = async (name: string): Promise<Array<Record<string, unknown>>> =>
  (await fixture(name)).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)

const ROOT = 'ses_ebbc91a76ffe3FIk6JSlpGuSKi'
const TUI_ROOT = 'ses_ebbc54393ffehl779tjDUeM6OX'
const projectId = 'demo'
const ws = 'ws-1'
const checkpoint = (): string => opencodeCheckpointDir(projectId, ws)

/** opencode's two tables, holding just the columns the reader asks for. */
async function writeDatabase(rows: Array<Record<string, unknown>>): Promise<void> {
  await fs.mkdir(checkpoint(), { recursive: true })
  const db = new DatabaseSync(path.join(checkpoint(), 'opencode.db'))
  db.exec('pragma journal_mode = wal')
  db.exec('create table session_v2 (id text primary key, parent_id text, title text, directory text, time_created integer)')
  db.exec('create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, data text)')
  rows.forEach((r, i) => {
    if (r.type === 'session') {
      db.prepare('insert into session_v2 values (?, ?, ?, ?, ?)').run(String(r.session), r.parent as string | null, String(r.title), String(r.directory), i)
    } else {
      db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?)')
        .run(`msg_${String(i)}`, String(r.session), String(r.type), Number(r.seq), i, JSON.stringify(r.data))
    }
  })
  db.close()
}

async function writeExport(root: string, body: string): Promise<string> {
  const file = path.join(checkpoint(), 'yaac-transcripts', `${root}.jsonl`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
  return file
}

/**
 * What a pane renders, without the stream's granularity: live text arrives
 * as many chunks and a call as several updates, which a pane merges, so
 * chunks are joined and each call and subagent is shown once, where it
 * first appeared, in its last state. Session state a transcript does not
 * show (commands, models) is left out, and so are times, which the live
 * fixture's record does not hold.
 */
function rendered(events: AcpEvent[]): unknown[] {
  const out: Array<Record<string, unknown>> = []
  const at = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'commands' || e.type === 'models') continue
    const { seq: _, at: _at, ...shown } = e as AcpEvent & Record<string, unknown>
    if (e.type === 'tool' || e.type === 'subagent') {
      const key = e.type === 'tool' ? e.call.toolCallId : e.subagent.id
      const i = at.get(key)
      if (i === undefined) at.set(key, out.push(shown) - 1)
      else out[i] = shown
      continue
    }
    const last = out[out.length - 1] as { type?: string; thread?: string; content: unknown[] } | undefined
    if ((e.type === 'agent' || e.type === 'thought') && last?.type === e.type && last.thread === e.thread) {
      const text = (c: unknown[]): string => c.map((b) => (b as { text?: string }).text ?? '').join('')
      last.content = [{ type: 'text', text: text(last.content) + text(e.content) }]
      continue
    }
    out.push(shown)
  }
  return out
}

describe('opencodeTranscriptAsAcp', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-opencode-replay-'))
    setDataDir(tmp)
  })

  afterEach(async () => {
    resetWorkspaceDriver()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('renders a host workspace\'s database as the live acp stream rendered it, leaving the database untouched', async () => {
    installFakeWorkspaceDriver({ kind: 'containerless' })
    await writeDatabase(await rowsOf('rows.jsonl'))
    const live = rendered(replayAcpLog(await fixture('live.jsonl')))

    const events = await opencodeTranscriptAsAcp(projectId, ws, ROOT)
    expect(rendered(events)).toEqual(live)
    // A sample of what that covers, so a fixture gone empty cannot pass.
    const calls = events.flatMap((e) => e.type === 'tool' ? [e.call] : [])
    expect(events.find((e) => e.type === 'user' && e.content.length === 2)).toMatchObject({
      content: [{ type: 'text', text: 'IMAGE look' }, { type: 'image', mimeType: 'image/png' }],
    })
    expect(calls.find((c) => c.title === 'edit' && c.status === 'completed')?.content).toContainEqual({ type: 'diff', path: '/workspace/notes.txt', oldText: 'alpha\nbeta\n', newText: 'alpha\ngamma\n' })
    expect(calls.find((c) => c.title === 'sleep 30' && c.status !== 'pending')).toMatchObject({ shell: true, status: 'failed' })
    expect(events.filter((e) => e.type === 'subagent').at(-1)).toMatchObject({ subagent: { name: 'Inspect notes', state: 'completed' } })
    // Dated by opencode's own times, to within the second a record keeps.
    const [opening] = events.flatMap((e) => (e.type === 'user' ? [e.at] : []))
    expect(opening).toBeGreaterThan(1792145811053 - 1000)
    expect(opening).toBeLessThanOrEqual(1792145811053)
    // Read immutable: no lock file or sidecar appears beside it.
    expect(await fs.readdir(checkpoint())).toEqual(['opencode.db'])

    // With a `-wal`, opencode may be writing; what it has written is read
    // through it.
    const db = new DatabaseSync(path.join(checkpoint(), 'opencode.db'))
    try {
      db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?)')
        .run('msg_late', ROOT, 'user', 999, 999, JSON.stringify({ text: 'one more thing', files: [] }))
      expect(await fs.readdir(checkpoint())).toContain('opencode.db-wal')
      expect((await opencodeTranscriptAsAcp(projectId, ws, ROOT)).at(-1))
        .toMatchObject({ type: 'user', content: [{ type: 'text', text: 'one more thing' }] })
    } finally {
      db.close()
    }
  })

  it('reads a sandboxed workspace\'s export and never its database', async () => {
    installFakeWorkspaceDriver({ kind: 'k8s' })
    // A database a sandboxed workspace wrote is never opened, whatever it says.
    await writeDatabase([{ session: ROOT, type: 'session', parent: null, title: 'planted', directory: '/' }])
    expect(await opencodeTranscriptAsAcp(projectId, ws, ROOT)).toEqual([])

    const exported = await writeExport(ROOT, await fixture('rows.jsonl'))
    const live = rendered(replayAcpLog(await fixture('live.jsonl')))
    expect(rendered(await opencodeTranscriptAsAcp(projectId, ws, ROOT))).toEqual(live)

    // A link the workspace planted in place of the export is not followed.
    await fs.rm(exported)
    const elsewhere = path.join(tmp, 'elsewhere.jsonl')
    await fs.writeFile(elsewhere, await fixture('rows.jsonl'))
    await fs.symlink(elsewhere, exported)
    expect(await opencodeTranscriptAsAcp(projectId, ws, ROOT)).toEqual([])
    // Nor is an id that could name a path.
    expect(await opencodeTranscriptAsAcp(projectId, ws, '../ses_x')).toEqual([])

    // An edit's patch becomes one diff per hunk, so separate regions of a
    // file never read as one block. Compactions end as the live stream
    // reports them: an interrupted one as cancelled, and a failure whose
    // message spans lines as a bare "Compaction failed".
    const patch = [
      '--- notes.txt', '+++ notes.txt',
      '@@ -1,2 +1,2 @@', ' alpha', '-beta', '+gamma',
      '@@ -9,2 +9,2 @@', ' omega', '-psi', '+chi',
    ].join('\n')
    const edit = {
      type: 'tool', id: 'call_edit', name: 'edit',
      state: { status: 'completed', input: { filePath: 'notes.txt' }, content: [], metadata: { files: [{ file: 'notes.txt', patch }] } },
    }
    await writeExport('ses_hunks', [
      { session: 'ses_hunks', type: 'session', parent: null, directory: '/workspace' },
      { session: 'ses_hunks', type: 'user', seq: 0, data: { text: 'edit', files: [] } },
      { session: 'ses_hunks', type: 'assistant', seq: 1, data: { content: [edit] } },
      { session: 'ses_hunks', type: 'compaction', seq: 2, data: { id: 'c1', reason: 'auto', status: 'failed', error: { type: 'compaction.interrupted', message: 'stopped' } } },
      { session: 'ses_hunks', type: 'compaction', seq: 3, data: { id: 'c2', reason: 'auto', status: 'failed', error: { type: 'compaction.failed', message: 'bad\nsummary' } } },
    ].map((l) => JSON.stringify(l)).join('\n'))
    const replayed = await opencodeTranscriptAsAcp(projectId, ws, 'ses_hunks')
    expect(replayed.flatMap((e) => e.type === 'compaction' ? [[e.compaction.status, e.compaction.error]] : []))
      .toEqual([['cancelled', undefined], ['failed', 'Compaction failed']])
    const call = replayed.flatMap((e) => e.type === 'tool' && e.call.status === 'completed' ? [e.call] : [])[0]
    expect(call.content?.filter((c) => c.type === 'diff')).toEqual([
      { type: 'diff', path: '/workspace/notes.txt', oldText: 'alpha\nbeta\n', newText: 'alpha\ngamma\n' },
      { type: 'diff', path: '/workspace/notes.txt', oldText: 'omega\npsi\n', newText: 'omega\nchi\n' },
    ])
  })

  it('stays linear on a crafted export of many subagent calls and unrelated sessions', async () => {
    // Each subagent call looks for an unplaced session under its own, which
    // a scan of every session per call makes quadratic.
    installFakeWorkspaceDriver({ kind: 'k8s' })
    const n = 20_000
    const task = (i: number): unknown => ({ type: 'tool', id: `call_${String(i)}`, name: 'task', state: { status: 'completed', input: {}, content: [] } })
    const lines = [
      { session: ROOT, type: 'session', parent: null, directory: '/workspace' },
      { session: ROOT, type: 'user', seq: 0, data: { text: 'go', files: [] } },
      { session: ROOT, type: 'assistant', seq: 1, data: { content: Array.from({ length: n }, (_, i) => task(i)) } },
      ...Array.from({ length: n }, (_, i) => ({ session: `ses_other${String(i)}`, type: 'session', parent: 'ses_elsewhere' })),
    ]
    await writeExport(ROOT, lines.map((l) => JSON.stringify(l)).join('\n'))

    const started = Date.now()
    const events = await opencodeTranscriptAsAcp(projectId, ws, ROOT)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(events.filter((e) => e.type === 'subagent')).toEqual([])
    expect(events.filter((e) => e.type === 'tool')).toHaveLength(2 * n)
  })

  it('renders what only the TUI writes, and places a subagent at the call still running it', async () => {
    installFakeWorkspaceDriver({ kind: 'k8s' })
    const rows = await rowsOf('tui-rows.jsonl')
    await writeExport(TUI_ROOT, rows.map((r) => JSON.stringify(r)).join('\n'))
    const events = rendered(await opencodeTranscriptAsAcp(projectId, ws, TUI_ROOT))
    const child = 'ses_ebbc52032ffej3i8JvksILESSo'

    expect(events).toMatchObject([
      { type: 'user', content: [{ type: 'text', text: '!echo shell-from-user' }] },
      { type: 'tool', call: { title: 'echo shell-from-user', shell: true, status: 'completed', content: [{ type: 'text', text: 'shell-from-user\n' }] } },
      { type: 'user', content: [{ type: 'text', text: 'SUB tui' }] },
      { type: 'agent', content: [{ type: 'text', text: 'Delegating.' }] },
      { type: 'tool', call: { toolCallId: 'call_1', kind: 'think', status: 'completed' } },
      { type: 'subagent', subagent: { id: child, name: 'Inspect notes', task: '', state: 'completed' } },
      { type: 'thought', thread: child, content: [{ type: 'text', text: 'Counting.' }] },
      { type: 'tool', thread: child, call: { toolCallId: `${child}:call_2`, title: 'Inspect notes: wc -l notes.txt', status: 'completed' } },
      { type: 'agent', thread: child, content: [{ type: 'text', text: 'notes.txt has 2 lines.' }] },
      { type: 'agent', content: [{ type: 'text', text: 'Subagent finished.' }] },
      { type: 'user', content: [{ type: 'text', text: 'ASK tui' }] },
      { type: 'tool', call: { title: 'question', status: 'completed' } },
      { type: 'agent', content: [{ type: 'text', text: 'Thanks for answering.' }] },
      { type: 'user', content: [{ type: 'text', text: 'SLOW tui' }] },
      { type: 'agent', content: [{ type: 'text', text: 'Sleeping.' }] },
      { type: 'tool', call: { title: 'sleep 30', status: 'failed', content: [{ type: 'text', text: 'Tool execution interrupted' }] } },
      { type: 'user', content: [{ type: 'text', text: '/compact' }] },
      { type: 'compaction', compaction: { trigger: 'manual', status: 'failed', error: 'Compaction summary did not match the required template' } },
      { type: 'user', content: [{ type: 'text', text: 'after compact' }] },
      { type: 'agent', content: [{ type: 'text', text: 'Hello from the mock.' }] },
    ])
    expect(JSON.stringify(events[11])).toContain('\\"Which color?\\"=\\"Red\\"')

    // A workspace stopped mid-subagent: the call is still running and has
    // not yet named its session, which is still played inside it.
    const running = rows.map((r) => {
      const content = (r.data as { content?: Array<Record<string, unknown>> } | undefined)?.content
      const call = content?.find((p) => p.id === 'call_1')
      return call === undefined ? r : {
        ...r,
        data: { ...(r.data as object), content: content!.map((p) => p === call ? { ...p, state: { status: 'running', input: (call.state as { input: unknown }).input } } : p) },
      }
    })
    await writeExport(TUI_ROOT, running.map((r) => JSON.stringify(r)).join('\n'))
    const replayed = rendered(await opencodeTranscriptAsAcp(projectId, ws, TUI_ROOT))
    const callAt = replayed.findIndex((e) => (e as { call?: { toolCallId: string } }).call?.toolCallId === 'call_1')
    expect(replayed[callAt]).toMatchObject({ call: { status: 'in_progress' } })
    expect(replayed[callAt + 1]).toMatchObject({ type: 'subagent', subagent: { id: child } })
  })
})
