import { describe, it, expect } from 'vitest'
import { MODEL_RE } from '#types'

describe('MODEL_RE', () => {
  it('accepts model ids, aliases, and provider/model paths', () => {
    for (const m of [
      'claude-opus-4-8', 'opus', 'claude-sonnet-5', 'us.anthropic.claude-fable-5:0',
      'anthropic/claude-opus-4-8', 'fireworks/accounts/fireworks/models/kimi-k2p6',
    ]) {
      expect(MODEL_RE.test(m)).toBe(true)
    }
  })

  // The value is embedded bare in an agent launch command that travels inside
  // a single-quoted `respawn-window '<cmd>'` wrapper, so anything that could
  // break out of it — or out of the shell around it — has to be refused here.
  it('rejects values unsafe for the single-quoted respawn wrapper', () => {
    for (const m of ["o'pus", 'a model', 'x;y', 'a$b', '-opus', '', 'a`b', 'a[1m]']) {
      expect(MODEL_RE.test(m)).toBe(false)
    }
  })
})
