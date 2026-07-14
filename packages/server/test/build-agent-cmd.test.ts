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

    // pi's command routes stderr through sed so the first line matching its
    // fresh-run "Warning: No project session found with id ..." warning is
    // dropped from the pane. On a PTY pi color-wraps the line, so the leading
    // `(\x1b\[[0-9;]*m)*` absorbs the SGR escapes (see buildAgentCmd).
    const wrapped = (piCmd: string) =>
      `${piCmd} 2> >(sed -u -E "0,/^(\\x1b\\[[0-9;]*m)*Warning: No project session found with id .*creating a new session with that id\\./{//d}" >&2)`

    it('uses --approve, the default provider model, and --session-id when none is given', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', '')
      expect(cmd).toBe(wrapped(`pi --approve --model ${defaultModel} --session-id sess-1`))
    })

    it('uses the given provider default model', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', '', false, 'anthropic')
      expect(cmd).toBe(wrapped(`pi --approve --model ${anthropicModel} --session-id sess-1`))
    })

    it('addresses the session by id when resuming (same command as create)', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', '', true, 'anthropic')
      expect(cmd).toBe(wrapped(`pi --approve --model ${anthropicModel} --session-id sess-1`))
    })

    it('drops add-dir flags (pi has no --add-dir)', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', '--add-dir /add-dir/tmp')
      expect(cmd).toBe(wrapped(`pi --approve --model ${defaultModel} --session-id sess-1`))
    })

    it('filters the fresh-run warning without single quotes (survives respawn wrapper)', () => {
      const cmd = buildAgentCmd('pi', 'sess-1', '')
      // Must never contain a single quote: it is embedded in tmux
      // `respawn-window '<cmd>'`, itself passed through the host `sh -c`. The
      // sed pattern uses `.*` instead of the literal quotes around the id so
      // the whole command stays single-quote-free.
      expect(cmd).not.toContain("'")
      // Anchored at `^` (after any leading SGR color codes pi adds on a PTY) so
      // a genuine error is never swallowed, and `0,/re/{//d}` deletes only the
      // first occurrence.
      expect(cmd).toContain('2> >(sed -u -E "0,/^(\\x1b\\[[0-9;]*m)*Warning: ')
      expect(cmd).toContain('creating a new session with that id\\./{//d}" >&2)')
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
