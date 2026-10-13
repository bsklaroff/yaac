import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { claudeProjectDirName, codexRolloutParent, codexRolloutThreadId } from '#project-paths'

/** Opens `file` for reading, as a caller hands `codexRolloutParent`. */
const opener = (file: string) => () => fs.open(file, 'r')

describe('claudeProjectDirName', () => {
  it('punches every non-alphanumeric out of the cwd', () => {
    expect(claudeProjectDirName('/workspace')).toBe('-workspace')
    expect(claudeProjectDirName('/home/me/.yaac/projects/p_1/workspaces/abc'))
      .toBe('-home-me--yaac-projects-p-1-workspaces-abc')
  })

  it('cuts a long one at 200 and appends claude\'s own hash of the whole path', () => {
    // Observed from claude 2.1.282 run in this cwd.
    const cwd = `/tmp/claude-1000/-workspace/26a9c9fd-de5b-4db5-a741-c3522285d032/scratchpad/cc/${'a'.repeat(120)}/with.dots_and space/${'b'.repeat(100)}`
    expect(claudeProjectDirName(cwd)).toBe(
      `-tmp-claude-1000--workspace-26a9c9fd-de5b-4db5-a741-c3522285d032-scratchpad-cc-${'a'.repeat(120)}--yck5ws`,
    )
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

  async function rollout(meta: Record<string, unknown>, type = 'session_meta'): Promise<string> {
    const file = path.join(dir, `r-${String(Math.random()).slice(2)}.jsonl`)
    // Real first lines are around 20 KB because of the base instructions.
    const payload = { id: 'child', base_instructions: 'x'.repeat(30_000), ...meta }
    await fs.writeFile(file, `${JSON.stringify({ type, payload })}\n{"type":"event_msg"}\n`)
    return file
  }

  it('names a spawned child\'s parent, and a fork\'s origin', async () => {
    const child = await rollout({ source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } } })
    expect(await codexRolloutParent(opener(child))).toBe('parent')
    const fork = await rollout({ source: 'cli', forked_from_id: 'origin' })
    expect(await codexRolloutParent(opener(fork))).toBe('origin')
  })

  it('has none for a root thread, another first line, or no file', async () => {
    expect(await codexRolloutParent(opener(await rollout({ source: 'cli' })))).toBeUndefined()
    expect(await codexRolloutParent(opener(await rollout({ forked_from_id: 'x' }, 'turn_context')))).toBeUndefined()
    expect(await codexRolloutParent(opener(path.join(dir, 'missing.jsonl')))).toBeUndefined()
  })
})
