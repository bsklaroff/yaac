import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  _resetCodexRolloutReadsForTests,
  codexRolloutParent,
  codexRolloutThreadId,
  getCodexRolloutSettings,
} from '#runtime/agents/codex'
import type { SandboxFile } from '#runtime/agents/sandbox-fs'

/** A file as the readers take it: its dir plus its name. */
const at = (file: string): SandboxFile => ({ projectId: 'demo', dir: path.dirname(file), rel: path.basename(file) })


describe('getCodexRolloutSettings', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-posture-'))
    _resetCodexRolloutReadsForTests()
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  let n = 0
  const rollout = async (entries: unknown[]): Promise<string> => {
    const jsonl = path.join(dir, `rollout-${String(n++)}.jsonl`)
    await fs.writeFile(jsonl, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    return jsonl
  }

  // Profiles codex 0.159.3 writes: full access is `disabled`; a managed
  // profile is workspace-write if it grants a write, else read-only.
  const FULL = { type: 'disabled' }
  const WORKSPACE = {
    type: 'managed',
    file_system: {
      type: 'restricted',
      entries: [
        { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
        { path: { type: 'path', path: '/workspace' }, access: 'write' },
      ],
    },
  }
  const READ_ONLY = {
    type: 'managed',
    file_system: { type: 'restricted', entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }] },
  }
  const settings = (s: Record<string, unknown>): Record<string, unknown> => ({
    approval_policy: 'on-request',
    approvals_reviewer: 'user',
    permission_profile: WORKSPACE,
    collaboration_mode: { mode: 'default' },
    ...s,
  })
  const turnContext = (s: Record<string, unknown> = {}): unknown =>
    ({ type: 'turn_context', payload: { model: 'gpt-6-astra', ...settings(s) } })
  const applied = (s: Record<string, unknown> = {}): unknown => ({
    type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_id: 't', thread_settings: settings(s) },
  })

  it('inverts every codex launch the posture table makes', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ approval_policy: 'never', permission_profile: FULL }, 'bypass'],
      [{ approvals_reviewer: 'auto_review' }, 'auto'],
      [{}, 'accept-edits'],
      [{ permission_profile: READ_ONLY }, 'read-only'],
    ]
    for (const [s, mode] of cases) {
      expect((await getCodexRolloutSettings(at(await rollout([turnContext(s)]))))?.permissionMode).toBe(mode)
    }
  })

  // `/permissions` or Shift+Tab writes a settings event at once; the newest
  // entry wins.
  it('follows a mid-session change without waiting for the next turn', async () => {
    const jsonl = await rollout([
      turnContext(),
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
      { ...applied({ approval_policy: 'never', permission_profile: FULL }) as object, timestamp: '2026-09-24T20:21:41.151Z' },
    ])
    // The timestamp tells this run's settings from ones a restart resumed.
    await expect(getCodexRolloutSettings(at(jsonl)))
      .resolves.toEqual({ permissionMode: 'bypass', atMs: Date.parse('2026-09-24T20:21:41.151Z') })

    // Plan mode only instructs the model; it does not change the sandbox.
    await fs.appendFile(jsonl, JSON.stringify(applied({
      approval_policy: 'never', permission_profile: FULL, collaboration_mode: { mode: 'plan' },
    })) + '\n')
    expect((await getCodexRolloutSettings(at(jsonl)))?.permissionMode).toBe('bypass')
  })

  // Unknown settings map to the loosest posture that is no looser than them.
  it('reads settings past the launch table as the nearest posture no looser', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ permission_profile: FULL }, 'bypass'],
      [{ approval_policy: 'never' }, 'accept-edits'],
      [{ approval_policy: 'never', permission_profile: READ_ONLY }, 'read-only'],
      [{ approvals_reviewer: 'auto_review', permission_profile: READ_ONLY }, 'auto'],
    ]
    for (const [s, mode] of cases) {
      expect((await getCodexRolloutSettings(at(await rollout([turnContext(s)]))))?.permissionMode).toBe(mode)
    }
  })

  // Unrecognized settings yield nothing, not an older entry's posture.
  it('answers nothing for settings no posture stands for', async () => {
    const jsonl = await rollout([turnContext(), applied({ approval_policy: { granular: {} } })])
    await expect(getCodexRolloutSettings(at(jsonl))).resolves.toBeUndefined()
  })

  // codex writes the level as `effort` in each turn context (checked against
  // codex-cli 0.159.3) and as `reasoning_effort` in a settings change.
  it('reads the effort beside the posture, from either entry', async () => {
    const turn = await rollout([turnContext({ effort: 'xhigh' })])
    expect(await getCodexRolloutSettings(at(turn))).toMatchObject({ permissionMode: 'accept-edits', effort: 'xhigh' })
    const changed = await rollout([turnContext({ effort: 'xhigh' }), applied({ reasoning_effort: 'low' })])
    expect((await getCodexRolloutSettings(at(changed)))?.effort).toBe('low')
    // Not a level's shape: dropped, as anything in the workspace can write it.
    const forged = await rollout([turnContext({ effort: 'x"y' })])
    expect(await getCodexRolloutSettings(at(forged))).not.toHaveProperty('effort')
  })

  it('reads nothing from a rollout that is not there', async () => {
    await expect(getCodexRolloutSettings(at(path.join(dir, 'missing.jsonl')))).resolves.toBeUndefined()
  })
})

describe('codexRolloutThreadId', () => {
  it('reads the thread id out of codex\'s rollout name, plain or compressed', () => {
    const id = '01a0ec4b-6990-7182-92ca-65550d232d3c'
    expect(codexRolloutThreadId(`rollout-2026-09-29T08-32-40-${id}.jsonl`)).toBe(id)
    expect(codexRolloutThreadId(`rollout-2026-09-29T08-32-40-${id}.jsonl.zst`)).toBe(id)
    expect(codexRolloutThreadId(`${id}.jsonl`)).toBeUndefined()
    expect(codexRolloutThreadId('rollout-thread-42.jsonl')).toBeUndefined()
  })
})

describe('codexRolloutParent', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-lineage-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  async function rollout(meta: Record<string, unknown>, type = 'session_meta'): Promise<SandboxFile> {
    const file = path.join(dir, `r-${String(Math.random()).slice(2)}.jsonl`)
    // Real first lines are around 20 KB because of the base instructions.
    const payload = { id: 'child', base_instructions: 'x'.repeat(30_000), ...meta }
    await fs.writeFile(file, `${JSON.stringify({ type, payload })}\n{"type":"event_msg"}\n`)
    return at(file)
  }

  it('names a spawned child\'s parent, and a fork\'s origin', async () => {
    expect(await codexRolloutParent(await rollout({
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
    }))).toBe('parent')
    expect(await codexRolloutParent(await rollout({ source: 'cli', forked_from_id: 'origin' }))).toBe('origin')
  })

  it('has none for a root thread, another first line, or no file', async () => {
    expect(await codexRolloutParent(await rollout({ source: 'cli' }))).toBeUndefined()
    expect(await codexRolloutParent(await rollout({ forked_from_id: 'x' }, 'turn_context'))).toBeUndefined()
    expect(await codexRolloutParent(at(path.join(dir, 'missing.jsonl')))).toBeUndefined()
  })
})
