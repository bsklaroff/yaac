import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

/**
 * The Codex SessionStart hook script lives inline in
 * `src/daemon/session-create.ts` (written into the container's codex
 * dir on each session start). It reads Codex's hook-input JSON on
 * stdin, extracts `transcript_path`, and symlinks it into
 * `.yaac-transcripts/<YAAC_SESSION_ID>.jsonl` so yaac can find the
 * transcript for each session.
 *
 * We reproduce the exact script contents here and run it against a
 * temp dir rather than inside a container — the script's behaviour
 * only depends on `sh`, `sed`, `python3`, and `ln`, all available on
 * the test host. If we regress the inlined version in
 * session-create.ts, update this constant.
 */
const HOOK_SCRIPT = [
  '#!/bin/sh',
  'INPUT=$(cat)',
  'TRANSCRIPT=$(echo "$INPUT" | sed -n \'s/.*"transcript_path"\\s*:\\s*"\\([^"]*\\)".*/\\1/p\')',
  'if [ -n "$TRANSCRIPT" ] && [ -n "$YAAC_SESSION_ID" ]; then',
  '  LINK_DIR="$YAAC_LINK_DIR"',
  '  mkdir -p "$LINK_DIR"',
  '  REL=$(python3 -c "import os.path; print(os.path.relpath(\'$TRANSCRIPT\', \'$LINK_DIR\'))")',
  '  ln -sf "$REL" "$LINK_DIR/$YAAC_SESSION_ID.jsonl"',
  'fi',
].join('\n') + '\n'

// We override LINK_DIR so the test doesn't need to create
// /home/yaac/.codex/.yaac-transcripts.

describe('codex SessionStart hook script', () => {
  let tmpDir: string
  let scriptPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-codex-hook-'))
    scriptPath = path.join(tmpDir, 'hook.sh')
    await fs.writeFile(scriptPath, HOOK_SCRIPT, { mode: 0o755 })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function runHook(
    stdin: string,
    env: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile('sh', [scriptPath], {
        env: { ...process.env, ...env },
      }, (err, stdout, stderr) => {
        if (err) reject(err instanceof Error ? err : new Error('hook script failed'))
        else resolve({ stdout, stderr })
      })
      child.stdin?.end(stdin)
    })
  }

  it('creates a relative symlink at $LINK_DIR/<YAAC_SESSION_ID>.jsonl', async () => {
    const transcript = path.join(tmpDir, 'sessions', '2026', '04', '15', 'rollout.jsonl')
    await fs.mkdir(path.dirname(transcript), { recursive: true })
    await fs.writeFile(transcript, '{"type":"event_msg"}\n')
    const linkDir = path.join(tmpDir, 'links')

    const input = JSON.stringify({
      session_id: 'codex-internal-id',
      transcript_path: transcript,
      cwd: '/workspace',
      hook_event_name: 'SessionStart',
    })
    await runHook(input, {
      YAAC_SESSION_ID: 'abcd1234',
      YAAC_LINK_DIR: linkDir,
    })

    const linkPath = path.join(linkDir, 'abcd1234.jsonl')
    const target = await fs.readlink(linkPath)
    // Symlink target should be relative from LINK_DIR back to the transcript.
    expect(target).toContain('sessions/2026/04/15/rollout.jsonl')
    expect(target.startsWith('/')).toBe(false)

    // And the symlink should resolve to the real file content.
    const content = await fs.readFile(linkPath, 'utf8')
    expect(content).toContain('event_msg')
  })

  it('does nothing when YAAC_SESSION_ID is unset', async () => {
    const transcript = path.join(tmpDir, 'rollout.jsonl')
    await fs.writeFile(transcript, '{}\n')
    const linkDir = path.join(tmpDir, 'no-sid-links')

    // Explicitly override YAAC_SESSION_ID to empty — the helper's env
    // merge otherwise inherits whatever process.env has.
    const input = JSON.stringify({ transcript_path: transcript })
    await runHook(input, { YAAC_LINK_DIR: linkDir, YAAC_SESSION_ID: '' })

    await expect(fs.access(linkDir)).rejects.toThrow()
  })

  it('does nothing when transcript_path is missing from the input', async () => {
    const linkDir = path.join(tmpDir, 'no-path-links')
    const input = JSON.stringify({ session_id: 'codex-internal-id' })
    await runHook(input, {
      YAAC_SESSION_ID: 'abcd1234',
      YAAC_LINK_DIR: linkDir,
    })
    await expect(fs.access(linkDir)).rejects.toThrow()
  })

  it('replaces an existing symlink (ln -sf behaviour)', async () => {
    const t1 = path.join(tmpDir, 't1.jsonl')
    const t2 = path.join(tmpDir, 't2.jsonl')
    await fs.writeFile(t1, 'first\n')
    await fs.writeFile(t2, 'second\n')
    const linkDir = path.join(tmpDir, 'links')

    await runHook(JSON.stringify({ transcript_path: t1 }), {
      YAAC_SESSION_ID: 'sid',
      YAAC_LINK_DIR: linkDir,
    })
    await runHook(JSON.stringify({ transcript_path: t2 }), {
      YAAC_SESSION_ID: 'sid',
      YAAC_LINK_DIR: linkDir,
    })

    const content = await fs.readFile(path.join(linkDir, 'sid.jsonl'), 'utf8')
    expect(content).toBe('second\n')
  })
})

// Guard against the inlined script drifting from this test's copy.
describe('codex hook script in session-create.ts matches the unit test copy', () => {
  it('has not drifted', async () => {
    const src = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'src', 'daemon', 'session-create.ts'),
      'utf8',
    )
    // Script is written as a joined string array — reconstruct the
    // relevant portion and assert it matches our harness's copy sans
    // the LINK_DIR override.
    // The script is JS-quoted in the source (single-quoted array entries,
    // with \' escapes for inner single-quotes), so match on raw bytes.
    expect(src).toContain('TRANSCRIPT=$(echo "$INPUT" | sed -n ')
    expect(src).toContain('/home/yaac/.codex/.yaac-transcripts')
    expect(src).toContain('ln -sf "$REL" "$LINK_DIR/$YAAC_SESSION_ID.jsonl"')
  })
})
