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
  })

  describe('claude tool', () => {
    it('omits prompt flags', () => {
      const cmd = buildAgentCmd('claude', 'sess-1', '')
      expect(cmd).toBe('claude --dangerously-skip-permissions --session-id sess-1')
    })

    it('includes session-id and add-dir flags', () => {
      const cmd = buildAgentCmd('claude', 'abc', '--add-dir /add-dir/tmp')
      expect(cmd).toBe('claude --dangerously-skip-permissions --session-id abc --add-dir /add-dir/tmp')
    })
  })
})
