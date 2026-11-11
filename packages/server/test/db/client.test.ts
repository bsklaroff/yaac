/**
 * `openDb`, `pingDb` and `closeDb`, against a real PGlite in a temp data
 * dir with the checked-in migrations, so the data-dir path builder,
 * single-flight open and dangling-handle close are covered by the dir
 * switches below. `getDb` is used only to inspect what a call opened;
 * `preferences` is the sample table.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'
import { openDb, getDb, closeDb, DbRefusal, pingDb } from '#db/client'
import { preferences } from '#db/schema'
import { BUILT_IN_USER_ID } from '#db/user-store'
import { secretKeyPath } from '@yaac/shared/project-paths'

// Other unit tests share one in-memory PGlite (YAAC_TEST_SHARED_DB) for
// speed. This file opts out because the on-disk per-dir handle is what it
// tests (0700 dir, distinct handle after a dir switch, checkpoint surviving
// a reopen).
vi.stubEnv('YAAC_TEST_SHARED_DB', '')

const dirs: string[] = []

async function freshDataDir(): Promise<string> {
  const dir = await createTempDataDir()
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await closeDb()
  while (dirs.length > 0) await cleanupTempDir(dirs.pop() as string)
})

describe('openDb', () => {
  it('creates <dataDir>/db at 0700, migrates, and answers queries', async () => {
    await freshDataDir()
    await openDb()
    // Checked before any getDb(): the handle opens lazily, so this pins that
    // openDb itself opened and migrated.
    const stat = await fs.stat(path.join(getDataDir(), 'server-local', 'db'))
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
    const db = await getDb()
    await db.insert(preferences).values({ owner: BUILT_IN_USER_ID, key: 'k', value: 'v' })
    expect(await db.select({ key: preferences.key, value: preferences.value }).from(preferences)).toEqual([{ key: 'k', value: 'v' }])
  })

  it('caches the handle while the data dir is stable', async () => {
    await freshDataDir()
    await openDb()
    await openDb()
    expect(await getDb()).toBe(await getDb())
  })

  // Data-moving migrations, which nothing else catches since every other
  // test starts from an empty migrated database. `seedBefore` migrates up to
  // (not including) `name`, runs `seed`, then migrates the rest.
  const migrations = path.resolve(fileURLToPath(import.meta.url), '../../../drizzle')
  async function seedBefore(
    name: string,
    seed: string,
  ): Promise<ReturnType<typeof drizzle>> {
    const all = (await fs.readdir(migrations)).filter((d) => /^\d{14}_/.test(d)).sort()
    const target = all.findIndex((d) => d.endsWith(`_${name}`))
    expect(target).toBeGreaterThan(0)
    const before = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-migrations-'))
    dirs.push(before)
    for (const d of all.slice(0, target)) {
      await fs.cp(path.join(migrations, d), path.join(before, d), { recursive: true })
    }
    const db = drizzle({ connection: { dataDir: 'memory://' } })
    await migrate(db, { migrationsFolder: before })
    await db.$client.exec(seed)
    await migrate(db, { migrationsFolder: migrations })
    return db
  }

  // The project's single remembered posture and the global default tool
  // become per-agent create memory.
  it('carries the old create memory into per-agent rows', async () => {
    const db = await seedBefore('per_project_create_defaults', `
        INSERT INTO projects (slug, remote_url, added_at, last_permission_mode)
          VALUES ('p', 'git@h:o/p.git', 'now', 'auto'), ('q', 'git@h:o/q.git', 'now', NULL);
        INSERT INTO preferences (key, value) VALUES ('default_tool', 'codex');
      `)
    try {
      const memory = await db.$client.query<{ name: string; tool: string; permission_mode: string }>(
        `SELECT p.name, t.tool, t.permission_mode FROM project_tool_defaults t
          JOIN projects p ON p.id = t.project_id ORDER BY p.name, t.tool`,
      )
      // `auto` reaches the tools that have it — never opencode (no reviewer
      // posture) and never pi, whose only posture says nothing about taste.
      expect(memory.rows).toEqual([
        { name: 'p', tool: 'claude', permission_mode: 'auto' },
        { name: 'p', tool: 'codex', permission_mode: 'auto' },
      ])
      const lastTools = await db.$client.query<{ name: string; last_tool: string | null }>(
        'SELECT name, last_tool FROM projects ORDER BY name',
      )
      expect(lastTools.rows).toEqual([
        { name: 'p', last_tool: 'codex' },
        { name: 'q', last_tool: 'codex' },
      ])
      const prefs = await db.$client.query('SELECT key FROM preferences')
      expect(prefs.rows).toEqual([])
    } finally {
      await db.$client.close()
    }
  })

  // A draft's title was the generated one; it moves aside for the user's. A
  // queued entry launched into its nearest parent workspace's group, and now
  // stores it — walked up a chain, and none when that workspace is ungrouped,
  // has no row, or the chain dangles or loops.
  it('moves draft titles aside and files queued entries in their parent\'s group', async () => {
    const entry = (id: string, parent: string): string =>
      `('${id}', 'p', ${parent}, 'go', 'claude', 'opus', 'tui', 'bypass', 'main')`
    const uuid = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`
    const db = await seedBefore('queued_and_draft_titles_and_groups', `
      INSERT INTO projects (slug, remote_url, added_at) VALUES ('p', 'git@h:o/p.git', 'now');
      INSERT INTO draft_worktrees (id, project_slug, prompt, title, tool, mode, permission_mode) VALUES
        ('${uuid(1)}', 'p', 'x', 'Gen one', 'claude', 'tui', 'bypass'),
        ('${uuid(2)}', 'p', 'y', NULL, 'claude', 'tui', 'bypass');
      INSERT INTO worktrees (project_slug, worktree_id, group_id) VALUES ('p', 'w1', 'g1'), ('p', 'w2', NULL);
      INSERT INTO queued_worktrees
        (id, project_slug, parent_worktree_id, parent_queued_id, prompt, tool, model, mode, permission_mode, branch)
      VALUES
        ${entry(uuid(1), `'w1', NULL`)}, ${entry(uuid(2), `NULL, '${uuid(1)}'`)},
        ${entry(uuid(3), `NULL, '${uuid(2)}'`)}, ${entry(uuid(4), `'w2', NULL`)},
        ${entry(uuid(5), `'w-missing', NULL`)}, ${entry(uuid(6), `NULL, '${uuid(9)}'`)},
        ${entry(uuid(7), `NULL, '${uuid(8)}'`)}, ${entry(uuid(8), `NULL, '${uuid(7)}'`)};
    `)
    try {
      const drafts = await db.$client.query<{ title: string | null; generated_title: string | null }>(
        'SELECT title, generated_title FROM draft_workspaces ORDER BY id',
      )
      expect(drafts.rows).toEqual([
        { title: null, generated_title: 'Gen one' },
        { title: null, generated_title: null },
      ])
      const queued = await db.$client.query<{ group_id: string | null }>(
        'SELECT group_id FROM queued_workspaces ORDER BY id',
      )
      expect(queued.rows.map((r) => r.group_id)).toEqual(['g1', 'g1', 'g1', null, null, null, null, null])
    } finally {
      await db.$client.close()
    }
  })

  // Every project reference moves from the slug to the project's id, the
  // slug stays on as the display name, and a row naming no project goes.
  it('re-keys project references by id and keeps the slug as the name', async () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const db = await seedBefore('key_projects_by_id', `
      INSERT INTO projects (id, slug, remote_url, added_at) VALUES ('${id}', 'demo', 'git@h:o/demo.git', 'now');
      INSERT INTO workspaces (project_slug, workspace_id) VALUES ('demo', 'w1'), ('gone', 'w2');
      INSERT INTO project_env_vars (project_slug, name, value) VALUES ('demo', 'A', 'x'), ('gone', 'B', 'y');
      INSERT INTO workspace_groups (project_slug, group_id, name) VALUES ('demo', 'g1', 'G'), ('gone', 'g2', 'H');
    `)
    try {
      const projects = await db.$client.query('SELECT id, name FROM projects')
      expect(projects.rows).toEqual([{ id, name: 'demo' }])
      const keys = async (table: string, key: string): Promise<unknown[]> =>
        (await db.$client.query(`SELECT project_id, ${key} AS key FROM ${table}`)).rows
      expect(await keys('workspaces', 'workspace_id')).toEqual([{ project_id: id, key: 'w1' }])
      expect(await keys('project_env_vars', 'name')).toEqual([{ project_id: id, key: 'A' }])
      expect(await keys('workspace_groups', 'group_id')).toEqual([{ project_id: id, key: 'g1' }])
    } finally {
      await db.$client.close()
    }
  })

  // Each project's remote becomes a repo with the project's id, linked into
  // it and held by its workspaces at their root, so nothing on disk moves. A
  // share has no repo of its own: it links the one it was shared from, and
  // its owner is shared that repo unless the share was removed. What queued
  // entries, routines and drafts start with, and a site's repo, name the
  // repo; a conversation two workspaces linked keeps its first.
  it('turns each project\'s remote into a repo, and a share into a link to its source\'s', async () => {
    const [PLAIN, HOSTED, SHARE, REVOKED, ODD] = [1, 2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-00000000000${n}`)
    const [ADA, BOB, CRED, FLOW, NAMED, QUEUED, ROUTINE, DRAFT] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `0a0a0a0a-0000-4000-8000-00000000000${n}`)
    const hosted = (id: string): string => `http://yaac.internal/api/workspace/git/${id}.git`
    const db = await seedBefore('add_repos', `
      INSERT INTO users (id, login, name) VALUES ('${ADA}', 'ada@x', 'Ada'), ('${BOB}', 'bob@x', 'Bob');
      INSERT INTO git_credentials (id, owner, name, kind, sealed_secret) VALUES ('${CRED}', '${ADA}', 'k', 'ssh', 'x');
      INSERT INTO projects (id, owner, name, remote_url, added_at, last_branch, git_credential_id, known_hosts_entry)
        VALUES ('${PLAIN}', '${ADA}', 'my.app', 'git@h:o/app.git', '2026-01-01', 'dev', '${CRED}', 'h ssh-ed25519 KEY');
      INSERT INTO projects (id, owner, name, remote_url, added_at, hosted, guard_default_branch)
        VALUES ('${HOSTED}', '${ADA}', 'notes', '${hosted(HOSTED)}', '2026-01-02', true, false);
      INSERT INTO projects (id, owner, name, remote_url, added_at, hosted, shared_from, share_revoked) VALUES
        ('${SHARE}', '${BOB}', 'notes', '${hosted(SHARE)}', '2026-01-03', true, '${HOSTED}', false),
        ('${REVOKED}', (SELECT id FROM users WHERE login IS NULL LIMIT 1), 'notes', '${hosted(REVOKED)}', '2026-01-04', true, '${HOSTED}', true);
      INSERT INTO projects (id, owner, name, remote_url, added_at) VALUES ('${ODD}', '${ADA}', '.Git', 'https://h/o/odd.git', '2026-01-05');
      INSERT INTO workspaces (project_id, workspace_id, base_branch, start_commit) VALUES
        ('${PLAIN}', 'w-plain', 'dev', 'abc'), ('${HOSTED}', 'w-hosted', NULL, 'def'),
        ('${SHARE}', 'w-share', 'main', NULL), ('${REVOKED}', 'w-revoked', 'main', NULL);
      INSERT INTO queued_workspaces (id, project_id, parent_workspace_id, prompt, tool, model, mode, permission_mode, branch, commit) VALUES
        ('${QUEUED}', '${SHARE}', 'w-share', 'go', 'claude', 'opus', 'tui', 'bypass', 'main', NULL),
        ('${ROUTINE}', '${PLAIN}', 'w-plain', 'go', 'claude', 'opus', 'tui', 'bypass', NULL, 'abc');
      INSERT INTO routines (id, project_id, name, cron, time_zone, tool, model, mode, permission_mode, branch)
        VALUES ('${ROUTINE}', '${PLAIN}', 'nightly', '@daily', 'UTC', 'claude', 'opus', 'tui', 'bypass', 'dev');
      INSERT INTO draft_workspaces (id, project_id, prompt, tool, mode, permission_mode, branch) VALUES
        ('${DRAFT}', '${PLAIN}', 'x', 'claude', 'tui', 'bypass', 'dev'), ('${QUEUED}', '${PLAIN}', 'y', 'claude', 'tui', 'bypass', NULL);
      INSERT INTO workflows (id, project_id, steps, hash) VALUES ('${FLOW}', '${SHARE}', '{}', 'h');
      INSERT INTO named_workflows (id, project_id, name, workflow_id) VALUES ('${NAMED}', '${SHARE}', 'site', '${FLOW}');
      INSERT INTO sites (project_id, name, hostname, port, named_workflow_id) VALUES ('${SHARE}', 's', 's.example.com', 80, '${NAMED}');
      INSERT INTO workflow_approvals (named_workflow_id, ref) VALUES ('${NAMED}', 'refs/heads/main'), ('${NAMED}', 'abc123');
      INSERT INTO conversations (project_id, tool, conversation_id) VALUES ('${PLAIN}', 'claude', 'c1');
      INSERT INTO workspace_conversations (project_id, workspace_id, tool, conversation_id, first_seen_at) VALUES
        ('${PLAIN}', 'w-later', 'claude', 'c1', '2026-02-02T00:00:00Z'), ('${PLAIN}', 'w-plain', 'claude', 'c1', '2026-02-01T00:00:00Z');
    `)
    try {
      const rows = async (sql: string): Promise<unknown[]> => (await db.$client.query(sql)).rows
      expect(await rows('SELECT id, owner, remote_url, hosted, guard_default_branch, git_credential_id, known_hosts_entry FROM repos ORDER BY id')).toEqual([
        { id: PLAIN, owner: ADA, remote_url: 'git@h:o/app.git', hosted: false, guard_default_branch: true, git_credential_id: CRED, known_hosts_entry: 'h ssh-ed25519 KEY' },
        { id: HOSTED, owner: ADA, remote_url: hosted(HOSTED), hosted: true, guard_default_branch: false, git_credential_id: null, known_hosts_entry: null },
        { id: ODD, owner: ADA, remote_url: 'https://h/o/odd.git', hosted: false, guard_default_branch: true, git_credential_id: null, known_hosts_entry: null },
      ])
      expect(await rows('SELECT project_id, repo_id, dir, last_branch, last_included FROM project_repos ORDER BY project_id')).toEqual([
        { project_id: PLAIN, repo_id: PLAIN, dir: 'my.app', last_branch: 'dev', last_included: true },
        { project_id: HOSTED, repo_id: HOSTED, dir: 'notes', last_branch: null, last_included: true },
        { project_id: SHARE, repo_id: HOSTED, dir: 'notes', last_branch: null, last_included: true },
        { project_id: REVOKED, repo_id: HOSTED, dir: 'notes', last_branch: null, last_included: true },
        // A name no checkout folder may take.
        { project_id: ODD, repo_id: ODD, dir: 'repo', last_branch: null, last_included: true },
      ])
      expect(await rows('SELECT repo_id, user_id FROM repo_shares')).toEqual([{ repo_id: HOSTED, user_id: BOB }])
      expect(await rows('SELECT workspace_id, repo_id, path, base_branch, start_commit FROM workspace_repos ORDER BY workspace_id')).toEqual([
        { workspace_id: 'w-hosted', repo_id: HOSTED, path: '', base_branch: null, start_commit: 'def' },
        { workspace_id: 'w-plain', repo_id: PLAIN, path: '', base_branch: 'dev', start_commit: 'abc' },
        { workspace_id: 'w-revoked', repo_id: HOSTED, path: '', base_branch: 'main', start_commit: null },
        { workspace_id: 'w-share', repo_id: HOSTED, path: '', base_branch: 'main', start_commit: null },
      ])
      expect(await rows('SELECT id, repos, nested, cwd FROM queued_workspaces ORDER BY id')).toEqual([
        { id: QUEUED, repos: [{ repo: HOSTED, branch: 'main' }], nested: false, cwd: HOSTED },
        { id: ROUTINE, repos: [{ repo: PLAIN, commit: 'abc' }], nested: false, cwd: PLAIN },
      ])
      expect(await rows('SELECT repos, cwd FROM routines')).toEqual([{ repos: [{ repo: PLAIN, branch: 'dev' }], cwd: PLAIN }])
      expect(await rows('SELECT id, repos FROM draft_workspaces ORDER BY id')).toEqual([
        { id: QUEUED, repos: null },
        { id: DRAFT, repos: [{ repo: PLAIN, branch: 'dev' }] },
      ])
      expect(await rows('SELECT repos FROM sites')).toEqual([{ repos: [{ repo: HOSTED }] }])
      // A share's approved branch is its source repo's; a commit is as it was.
      expect(await rows('SELECT ref FROM workflow_approvals ORDER BY ref')).toEqual([
        { ref: `${HOSTED}:refs/heads/main` }, { ref: 'abc123' },
      ])
      expect(await rows('SELECT workspace_id FROM workspace_conversations')).toEqual([{ workspace_id: 'w-plain' }])
    } finally {
      await db.$client.close()
    }
  })

  // Every conversation live at the upgrade becomes an open session with the
  // settings its workspace row held, in the window it already runs in, so a
  // running agent is watched as before and a restart brings back the same
  // agents. A workspace that recorded no conversation keeps the one session
  // its restart started.
  it('opens a session for each live conversation, on the settings its workspace held', async () => {
    const P = '11111111-2222-4333-8444-555555555555'
    const SEEN = '0a0a0a0a-0000-4000-8000-000000000001'
    const db = await seedBefore('add_sessions', `
      INSERT INTO projects (id, owner, name, remote_url, added_at, last_tool)
        VALUES ('${P}', (SELECT id FROM users LIMIT 1), 'p', 'git@h:o/p.git', 'now', 'codex');
      INSERT INTO workspaces (project_id, workspace_id, permission_mode, effort, model, mode, life_started_at, waiting_seen_by)
        VALUES ('${P}', 'running', 'plan', 'high', 'claude-opus-5', 'tui', '2026-10-01T00:00:00Z', '{${SEEN}}');
      INSERT INTO workspaces (project_id, workspace_id, mode, stopped_at) VALUES ('${P}', 'chat', 'acp', now());
      INSERT INTO workspaces (project_id, workspace_id, mode, model, effort, stopped_at, pending_prompt)
        VALUES ('${P}', 'unnamed', 'acp', 'claude-opus-5', 'max', now(), 'queued ask');
      INSERT INTO workspaces (project_id, workspace_id, mode, stopped_at) VALUES ('${P}', 'twins', 'acp', now());
      INSERT INTO workspaces (project_id, workspace_id, permission_mode, effort, model, mode, stopped_at)
        VALUES ('${P}', 'codexled', 'auto', 'max', 'claude-opus-5', 'tui', now());
      INSERT INTO workspaces (project_id, workspace_id, mode, stopped_at) VALUES ('${P}', 'dangling', 'tui', now());
      INSERT INTO conversations (project_id, tool, conversation_id, mode, first_prompt, model) VALUES
        ('${P}', 'claude', 'conv-1', 'tui', 'hello', NULL),
        ('${P}', 'codex', 'running', 'tui', NULL, NULL),
        ('${P}', 'claude', 'conv-old', 'tui', NULL, NULL),
        ('${P}', 'claude', 'conv-b', 'acp', NULL, 'claude-sonnet-5'),
        ('${P}', 'claude', 'conv-t1', 'acp', NULL, NULL),
        ('${P}', 'claude', 'conv-t2', 'acp', NULL, NULL),
        ('${P}', 'claude', 'conv-c1', 'tui', NULL, NULL),
        ('${P}', 'codex', 'conv-c2', 'tui', NULL, NULL);
      INSERT INTO workspace_conversations (project_id, workspace_id, tool, conversation_id, active, ordinal, pane_id) VALUES
        ('${P}', 'running', 'claude', 'conv-1', true, 0, '%3'),
        ('${P}', 'running', 'codex', 'running', true, 1, NULL),
        ('${P}', 'running', 'claude', 'conv-old', false, 2, NULL),
        ('${P}', 'chat', 'claude', 'conv-b', true, 0, 'claude-2'),
        ('${P}', 'twins', 'claude', 'conv-t1', true, 0, 'claude'),
        ('${P}', 'twins', 'claude', 'conv-t2', true, 1, 'claude'),
        ('${P}', 'codexled', 'claude', 'conv-c1', false, 0, NULL),
        ('${P}', 'codexled', 'codex', 'conv-c2', true, 1, NULL),
        ('${P}', 'dangling', 'opencode', 'conv-gone', false, 0, NULL);
    `)
    try {
      const sessions = (await db.$client.query<Record<string, unknown>>(
        `SELECT id, workspace_id, tool, mode, model, permission_mode, effort, ordinal, "window", launched_at,
          first_prompt, pending_prompt, conversation_id, waiting_seen_by FROM sessions ORDER BY workspace_id, ordinal`,
      )).rows
      const of = (workspaceId: string): Array<Record<string, unknown>> => sessions.filter((s) => s.workspace_id === workspaceId)
      const [first, pin] = of('running')
      expect(of('running')).toHaveLength(2)
      expect(first).toMatchObject({
        tool: 'claude', mode: 'tui', model: 'claude-opus-5', permission_mode: 'plan', effort: 'high',
        window: 'claude', conversation_id: 'conv-1', first_prompt: 'hello', waiting_seen_by: [SEEN],
      })
      expect(first.launched_at).toEqual(new Date('2026-10-01T00:00:00Z'))
      // codex names its own conversations, so one under the workspace id
      // never had a real one.
      // The row's model and effort were its launch tool's (the first
      // conversation's), so another tool's session takes neither.
      expect(pin).toMatchObject({ tool: 'codex', window: 'codex-2', conversation_id: null, model: null, effort: null })
      expect(of('codexled')).toEqual([expect.objectContaining({
        tool: 'codex', model: null, effort: null, permission_mode: 'auto', conversation_id: 'conv-c2',
      })])
      // A workspace whose only conversation row is gone still gets the fresh
      // agent its restart started, on that conversation's tool.
      expect(of('dangling')).toEqual([expect.objectContaining({ tool: 'opencode', window: 'opencode', conversation_id: null })])
      expect(of('chat')).toEqual([expect.objectContaining({
        mode: 'acp', window: 'claude-2', model: 'claude-sonnet-5', conversation_id: 'conv-b', launched_at: null,
      })])
      // With no conversation it comes back on claude, as its restart did,
      // the tool the row's model and effort were for, whatever the project
      // last used.
      expect(of('unnamed')).toEqual([expect.objectContaining({
        tool: 'claude', mode: 'acp', window: 'claude', model: 'claude-opus-5', effort: 'max',
        first_prompt: 'queued ask', pending_prompt: 'queued ask',
      })])
      // Two sessions never share a window: one of the pair keeps it.
      const twins = of('twins').map((s) => s.window as string).sort()
      expect(twins[0]).toBe('claude')
      expect(twins[1]).toMatch(/^claude-[0-9a-f]{8}$/)

      const links = (await db.$client.query<{ conversation_id: string; session_id: string | null }>(
        "SELECT conversation_id, session_id FROM workspace_conversations WHERE workspace_id = 'running' ORDER BY ordinal",
      )).rows
      expect(links.map((l) => l.session_id)).toEqual([first.id, pin.id, null])
      const columns = (await db.$client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'workspaces'",
      )).rows.map((r) => r.column_name)
      for (const gone of ['mode', 'model', 'permission_mode', 'effort', 'pending_prompt', 'waiting_seen_by']) {
        expect(columns).not.toContain(gone)
      }
    } finally {
      await db.$client.close()
    }
  })

  // A workflow's name follows a step's rule, so its `.` becomes `-`, one
  // over 48 is cut, and a name that becomes another's gets a number; where
  // a workspace recorded the name it follows. Steps of a life already
  // running keep their bare names, and a workspace that brought its own
  // graph names its workflow `_steps`.
  it('gives every step a workflow name, and workflow names a step name\'s rule', async () => {
    const [P, F1, F2, F3, F4, F5, F6, F7, F8] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `0b0b0b0b-0000-4000-8000-00000000000${n}`)
    const long = `${'a'.repeat(50)}`
    const db = await seedBefore('key_steps_by_workflow', `
      INSERT INTO projects (id, owner, name, added_at) VALUES ('${P}', (SELECT id FROM users LIMIT 1), 'p', '2026-01-01');
      INSERT INTO workflows (id, project_id, steps, hash) VALUES ('${F1}', '${P}', '{}', 'h1');
      INSERT INTO named_workflows (id, project_id, name, workflow_id, created_at) VALUES
        ('${F2}', '${P}', 'web.init', '${F1}', '2026-01-01'), ('${F3}', '${P}', 'web-init', '${F1}', '2026-01-02'),
        ('${F4}', '${P}', 'ci', '${F1}', '2026-01-03'), ('${F5}', '${P}', '${long}', '${F1}', '2026-01-04'),
        ('${F6}', '${P}', 'a.b', '${F1}', '2026-01-05'), ('${F7}', '${P}', 'a-b', '${F1}', '2026-01-06'),
        ('${F8}', '${P}', 'a-b-2', '${F1}', '2026-01-07');
      INSERT INTO workspaces (project_id, workspace_id, workflow_id, workflow_name) VALUES
        ('${P}', 'w-named', '${F1}', 'web.init'), ('${P}', 'w-own', '${F1}', NULL), ('${P}', 'w-init', NULL, NULL);
      INSERT INTO workspace_steps (workspace_id, name, project_id, origin, spec, state, life, ordinal, workflow_id, workflow_name)
        VALUES ('w-named', 'build', '${P}', 'start', '{"run":["make"]}', 'running', now(), 0, NULL, NULL),
          ('w-named', 'lint', '${P}', 'added', '{"run":["lint"]}', 'pending', now(), 1, '${F1}', 'ci');
    `)
    try {
      // A suffix from the id, which no other name can hold: `a-b-2` existing
      // beside `a.b` would refuse a number.
      const names = await db.$client.query<{ name: string }>('SELECT name FROM named_workflows ORDER BY created_at')
      const suffixed = (base: string, id: string): string => `${base}-${createHash('md5').update(id).digest('hex').slice(0, 6)}`
      expect(names.rows.map((r) => r.name))
        .toEqual([suffixed('web-init', F2), 'web-init', 'ci', 'a'.repeat(48), suffixed('a-b', F6), 'a-b', 'a-b-2'])
      const spaces = await db.$client.query<{ workspace_id: string; workflow_name: string | null }>(
        'SELECT workspace_id, workflow_name FROM workspaces ORDER BY workspace_id')
      expect(spaces.rows[0]).toEqual({ workspace_id: 'w-init', workflow_name: null })
      expect(spaces.rows[1]).toEqual({ workspace_id: 'w-named', workflow_name: names.rows[0].name })
      expect(spaces.rows[2]).toEqual({ workspace_id: 'w-own', workflow_name: '_steps' })
      const steps = await db.$client.query<{ name: string; workflow_name: string }>(
        'SELECT name, workflow_name FROM workspace_steps ORDER BY ordinal')
      expect(steps.rows).toEqual([{ name: 'build', workflow_name: '' }, { name: 'lint', workflow_name: '' }])
    } finally {
      await db.$client.close()
    }
  })

  // A project's init steps become init workflows: the named workflow it
  // followed is marked, and a graph of its own becomes a marked named
  // workflow `init`, or `init-steps` where the project already has an
  // `init`.
  it('turns each project\'s init steps into an init workflow', async () => {
    const [FOLLOWS, OWN, CLASH, NONE, F, N1, N2] = [1, 2, 3, 4, 5, 6, 7].map((n) => `0c0c0c0c-0000-4000-8000-00000000000${n}`)
    const db = await seedBefore('add_init_workflows', `
      INSERT INTO projects (id, owner, name, added_at) VALUES
        ('${FOLLOWS}', (SELECT id FROM users LIMIT 1), 'follows', '2026-01-01'),
        ('${OWN}', (SELECT id FROM users LIMIT 1), 'own', '2026-01-01'),
        ('${CLASH}', (SELECT id FROM users LIMIT 1), 'clash', '2026-01-01'),
        ('${NONE}', (SELECT id FROM users LIMIT 1), 'none', '2026-01-01');
      INSERT INTO workflows (id, project_id, steps, hash) VALUES ('${F}', '${FOLLOWS}', '{}', 'h');
      INSERT INTO named_workflows (id, project_id, name, workflow_id) VALUES
        ('${N1}', '${FOLLOWS}', 'setup', '${F}'), ('${N2}', '${CLASH}', 'init', '${F}');
      UPDATE projects SET init_named_workflow_id = '${N1}' WHERE id = '${FOLLOWS}';
      UPDATE projects SET init_workflow_id = '${F}' WHERE id IN ('${OWN}', '${CLASH}');
    `)
    try {
      const rows = await db.$client.query<{ project: string; name: string; init: boolean }>(
        'SELECT p.name AS project, n.name, n.init FROM named_workflows n JOIN projects p ON p.id = n.project_id ORDER BY p.name, n.name')
      expect(rows.rows).toEqual([
        { project: 'clash', name: 'init', init: false },
        { project: 'clash', name: 'init-steps', init: true },
        { project: 'follows', name: 'setup', init: true },
        { project: 'own', name: 'init', init: true },
      ])
    } finally {
      await db.$client.close()
    }
  })

  // A site names its repos: the one it followed, at that branch, and one
  // that followed nothing with no branch for the backfill to name. Each
  // commit becomes a map of that repo to it, so a deploy in progress across
  // the upgrade resumes.
  it('gives each site its repos and commit maps', async () => {
    const [P, REPO, F, N] = [1, 2, 3, 4].map((n) => `0d0d0d0d-0000-4000-8000-00000000000${n}`)
    const [A, B] = ['a'.repeat(40), 'b'.repeat(40)]
    const db = await seedBefore('add_site_repos', `
      INSERT INTO projects (id, owner, name, added_at) VALUES ('${P}', (SELECT id FROM users LIMIT 1), 'p', '2026-01-01');
      INSERT INTO workflows (id, project_id, steps, hash) VALUES ('${F}', '${P}', '{}', 'h');
      INSERT INTO named_workflows (id, project_id, name, workflow_id) VALUES ('${N}', '${P}', 'serve', '${F}');
      INSERT INTO sites (project_id, name, hostname, port, named_workflow_id, repo_id, follow_branch, release_commit,
        deploy_workspace_id, deploy_commit, last_deploy_commit, failed_commit) VALUES
        ('${P}', 'follows', 'f.example.com', 80, '${N}', '${REPO}', 'main', '${A}', 'w1', '${B}', '${A}', NULL),
        ('${P}', 'fixed', 'x.example.com', 80, '${N}', '${REPO}', NULL, '${A}', 'w2', '${B}', NULL, '${B}');
    `)
    try {
      const rows = await db.$client.query<Record<string, unknown>>(
        `SELECT name, repos, follow, release_commits, deploy_commits, last_deploy_commits, failed_commits
          FROM sites ORDER BY name`)
      expect(rows.rows).toEqual([
        {
          name: 'fixed', repos: [{ repo: REPO }], follow: false, release_commits: { [REPO]: A },
          deploy_commits: { [REPO]: B }, last_deploy_commits: null, failed_commits: { [REPO]: B },
        },
        {
          name: 'follows', repos: [{ repo: REPO, branch: 'main' }], follow: true, release_commits: { [REPO]: A },
          deploy_commits: { [REPO]: B }, last_deploy_commits: { [REPO]: A }, failed_commits: null,
        },
      ])
    } finally {
      await db.$client.close()
    }
  })

  // The same refusal covers a newer server's database and an install that
  // lost its own migration files, so the message names both.
  it('refuses a database recording a migration this build does not ship', async () => {
    await freshDataDir()
    await openDb()
    const db = await getDb()
    await db.$client.query(
      'INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ($1, $2, $3)',
      ['x', Date.UTC(2099, 0, 1), '20990101000000_from_the_future'],
    )
    await closeDb()
    const refused = openDb()
    await expect(refused).rejects.toBeInstanceOf(DbRefusal)
    await expect(refused).rejects.toThrow(/20990101000000_from_the_future.*upgrade yaac.*rebuild or reinstall/)
  })

  // Generating a new key would leave every stored credential unreadable,
  // which reads as signed out with nothing said. A fresh install with no
  // secrets still generates one when it first needs it.
  it('refuses a database holding secrets once their key is gone, unless a key is configured', async () => {
    await freshDataDir()
    await openDb()
    await expect(fs.access(secretKeyPath())).rejects.toThrow()
    await (await getDb()).$client.query(
      'INSERT INTO tool_credentials (owner, tool, sealed_credential) VALUES ($1, $2, $3)',
      [BUILT_IN_USER_ID, 'claude', 'sealed'],
    )
    await closeDb()

    const refused = openDb()
    await expect(refused).rejects.toBeInstanceOf(DbRefusal)
    await expect(refused).rejects.toThrow(`${secretKeyPath()} is absent or empty and neither YAAC_SECRETS nor YAAC_SECRET is set`)
    await closeDb()

    vi.stubEnv('YAAC_SECRET', 'k'.repeat(40))
    await openDb()
    await closeDb()
    vi.stubEnv('YAAC_SECRET', '')
    await fs.writeFile(secretKeyPath(), 'restored\n')
    await openDb()
  })

  it('reopens against the new dir when setDataDir changes it', async () => {
    await freshDataDir()
    await openDb()
    const first = await getDb()
    await first.insert(preferences).values({ owner: BUILT_IN_USER_ID, key: 'k', value: 'v' })
    await freshDataDir() // createTempDataDir calls setDataDir
    await openDb()
    const second = await getDb()
    expect(second).not.toBe(first)
    expect(await second.select({ key: preferences.key, value: preferences.value }).from(preferences)).toEqual([])
  })
})

describe('pingDb', () => {
  // A handle whose instance has gone (closed here, aborted in production)
  // stays cached, so every later query fails; the ping must say so.
  it('answers on a live handle and rejects once the instance is gone', async () => {
    await freshDataDir()
    await pingDb()
    await (await getDb()).$client.close()
    await expect(pingDb()).rejects.toThrow('PGlite is closed')
  })
})

describe('closeDb', () => {
  it('checkpoints so the data survives a reopen (re-migrate is a no-op)', async () => {
    await freshDataDir()
    await openDb()
    const db = await getDb()
    await db.insert(preferences).values({ owner: BUILT_IN_USER_ID, key: 'k', value: 'v' })
    await closeDb()
    await openDb()
    const reopened = await getDb()
    expect(reopened).not.toBe(db)
    expect(await reopened.select({ key: preferences.key, value: preferences.value }).from(preferences)).toEqual([{ key: 'k', value: 'v' }])
  })

  it('is idempotent and safe with nothing open', async () => {
    await closeDb()
    await freshDataDir()
    await openDb()
    await closeDb()
    await closeDb()
  })
})
