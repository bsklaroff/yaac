import { describe, it, expect } from 'vitest'
import { buildAgentCmd } from '@/daemon/session-create'

describe('buildAgentCmd', () => {
  describe('codex tool', () => {
    it('omits prompt arguments', () => {
      const cmd = buildAgentCmd('codex', 'sess-1', '')
      expect(cmd).toBe('codex --yolo')
    })

    it('includes add-dir flags', () => {
      const cmd = buildAgentCmd('codex', 'sess-1', '--add-dir /add-dir/tmp')
      expect(cmd).toBe('codex --yolo --add-dir /add-dir/tmp')
    })

    it('inserts the resume subcommand when resuming', () => {
      const cmd = buildAgentCmd('codex', 'sess-1', '', true)
      expect(cmd).toBe('codex --yolo resume sess-1')
    })

    it('combines resume with add-dir flags', () => {
      const cmd = buildAgentCmd('codex', 'abc', '--add-dir /add-dir/tmp', true)
      expect(cmd).toBe('codex --yolo resume abc --add-dir /add-dir/tmp')
    })
  })

  describe('claude tool', () => {
    it('omits prompt flags', () => {
      const cmd = buildAgentCmd('claude', 'sess-1', '')
      expect(cmd).toBe('CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --session-id sess-1')
    })

    it('includes session-id and add-dir flags', () => {
      const cmd = buildAgentCmd('claude', 'abc', '--add-dir /add-dir/tmp')
      expect(cmd).toBe('CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --session-id abc --add-dir /add-dir/tmp')
    })

    it('swaps --session-id for --resume when resuming', () => {
      const cmd = buildAgentCmd('claude', 'sess-1', '', true)
      expect(cmd).toBe('CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume sess-1')
    })

    it('combines resume with add-dir flags', () => {
      const cmd = buildAgentCmd('claude', 'abc', '--add-dir /add-dir/tmp', true)
      expect(cmd).toBe('CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume abc --add-dir /add-dir/tmp')
    })
  })

  describe('seed prompt file (plan-mode sessions)', () => {
    it('claude and codex take the prompt as a positional $(cat …) arg', () => {
      expect(buildAgentCmd('claude', 'sid', '', false, '/tmp/yaac-seed-prompt.txt')).toBe(
        'CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --session-id sid '
        + '"$(cat /tmp/yaac-seed-prompt.txt)"',
      )
      expect(buildAgentCmd('codex', 'sid', '', false, '/tmp/yaac-seed-prompt.txt')).toBe(
        'codex --yolo "$(cat /tmp/yaac-seed-prompt.txt)"',
      )
    })

    it('opencode takes it via --prompt', () => {
      expect(buildAgentCmd('opencode', 'sid', '', false, '/tmp/yaac-seed-prompt.txt')).toBe(
        'opencode --port 4096 --hostname 127.0.0.1 --prompt "$(cat /tmp/yaac-seed-prompt.txt)"',
      )
    })

    it('omitting the file leaves commands unchanged', () => {
      expect(buildAgentCmd('claude', 'sid', '')).not.toContain('cat')
    })
  })
})
