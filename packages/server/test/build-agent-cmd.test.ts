import { describe, it, expect } from 'vitest'
import { buildAgentCmd } from '#session-create'
import { PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/pi-providers'

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

  describe('pi tool', () => {
    const defaultModel = piProviderInfo(PI_DEFAULT_PROVIDER).defaultModel
    const anthropicModel = piProviderInfo('anthropic').defaultModel

    it('uses --approve and the default provider model when none is given', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', '')
      expect(cmd).toBe(`pi --approve --model ${defaultModel}`)
    })

    it('uses the given provider default model', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', '', false, 'anthropic')
      expect(cmd).toBe(`pi --approve --model ${anthropicModel}`)
    })

    it('appends -c when resuming', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', '', true, 'anthropic')
      expect(cmd).toBe(`pi --approve --model ${anthropicModel} -c`)
    })

    it('drops add-dir flags (pi has no --add-dir)', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', '--add-dir /add-dir/tmp')
      expect(cmd).toBe(`pi --approve --model ${defaultModel}`)
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
})
