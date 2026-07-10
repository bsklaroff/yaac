import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/server/log', () => ({ serverLog: vi.fn() }))

import {
  TITLE_MODEL_URL,
  shouldGenerateTitle,
  summarizeTitle,
  _setTitleRunnerFactoryForTests,
  _resetTitleSummarizerForTests,
} from '@/server/title-summarizer'
import { serverLog } from '@/server/log'

const mockLog = vi.mocked(serverLog)

/** Stub runner whose outputs and call log the test controls. */
function stubRunner(reply: (text: string) => string = () => 'A Short Title') {
  const inputs: string[] = []
  const factory = vi.fn(() => Promise.resolve((text: string) => {
    inputs.push(text)
    return Promise.resolve(reply(text))
  }))
  _setTitleRunnerFactoryForTests(factory)
  return { inputs, factory }
}

describe('title summarizer', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _resetTitleSummarizerForTests()
  })
  afterEach(() => {
    _resetTitleSummarizerForTests()
    vi.useRealTimers()
  })

  it('pins the chosen model + quant (Qwen2.5-0.5B-Instruct IQ4_XS)', () => {
    expect(TITLE_MODEL_URL).toContain('Qwen2.5-0.5B-Instruct-IQ4_XS.gguf')
  })

  describe('shouldGenerateTitle', () => {
    it('rejects a missing or empty prompt', () => {
      expect(shouldGenerateTitle(undefined)).toBe(false)
      expect(shouldGenerateTitle('')).toBe(false)
      expect(shouldGenerateTitle('   ')).toBe(false)
    })

    it('rejects prompts that already fit the sidebar (≤48 chars normalized)', () => {
      expect(shouldGenerateTitle('x'.repeat(48))).toBe(false)
      expect(shouldGenerateTitle('x'.repeat(49))).toBe(true)
      // Whitespace collapses before measuring.
      expect(shouldGenerateTitle(`fix   ${'\n '.repeat(40)}   it`)).toBe(false)
    })
  })

  describe('summarizeTitle', () => {
    it('feeds the instruction-templated prompt to the model', async () => {
      const { inputs } = stubRunner(() => 'Refactor widget factory plugin')
      await expect(summarizeTitle('please refactor the widget factory into a plugin')).resolves
        .toBe('Refactor widget factory plugin')
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatch(/^Write a short, specific title/)
      expect(inputs[0]).toContain('please refactor the widget factory into a plugin')
    })

    it('truncates a huge first message to a bounded payload', async () => {
      const { inputs } = stubRunner()
      await summarizeTitle('y'.repeat(5000))
      // The first message is appended after the instruction, past a blank line.
      const payload = inputs[0].split('\n\n').slice(1).join('\n\n')
      expect(payload).toBe('y'.repeat(1000))
    })

    it('strips wrapping quotes and trailing periods, and normalizes', async () => {
      const { inputs } = stubRunner(() => ' "Fix  the \n parser bug." ')
      await expect(summarizeTitle(
        'the parser has a bug with nested arrays, please fix it and add a regression test',
      )).resolves.toBe('Fix the parser bug')
      expect(inputs).toHaveLength(1)
    })

    it('caps output at the shared title length limit', async () => {
      stubRunner(() => 'w'.repeat(300))
      await expect(summarizeTitle('w'.repeat(300))).resolves.toBe('w'.repeat(120))
    })

    it('returns undefined for unusable (empty/quotes-only) output', async () => {
      stubRunner(() => ' "..." ')
      await expect(summarizeTitle('z'.repeat(60))).resolves.toBeUndefined()
    })

    it('rejects hallucinated titles sharing no content word with the prompt', async () => {
      stubRunner(() => 'adolescent symphony')
      await expect(summarizeTitle(
        'refactor the widget factory into a proper plugin system with lifecycle hooks',
      )).resolves.toBeUndefined()
    })

    it('keeps imperfect but on-topic titles (substring match, e.g. action/actions)', async () => {
      stubRunner(() => 'github action workflow set up')
      await expect(summarizeTitle(
        'set up a github actions workflow that runs lint and unit tests on every pull request',
      )).resolves.toBe('github action workflow set up')
    })

    it('keeps titles made only of short words (nothing to judge them by)', async () => {
      stubRunner(() => 'Fix it now')
      await expect(summarizeTitle(
        'the build is failing on macos with a linker error about missing symbols, figure out why',
      )).resolves.toBe('Fix it now')
    })

    it('serializes concurrent calls (spawns must not stack model loads)', async () => {
      let inFlight = 0
      let maxInFlight = 0
      const factory = vi.fn(() => Promise.resolve(async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight -= 1
        return 'T'.repeat(10)
      }))
      _setTitleRunnerFactoryForTests(factory)

      await Promise.all([summarizeTitle('a'.repeat(60)), summarizeTitle('b'.repeat(60))])
      expect(maxInFlight).toBe(1)
      expect(factory).toHaveBeenCalledTimes(1)
    })

    it('sets up once and reuses the runner across calls', async () => {
      const { factory } = stubRunner()
      await summarizeTitle('a'.repeat(60))
      await summarizeTitle('b'.repeat(60))
      expect(factory).toHaveBeenCalledTimes(1)
    })

    it('logs a setup failure once and fast-fails within the backoff window', async () => {
      const factory = vi.fn(() => Promise.reject(new Error('curl: (6) Could not resolve host')))
      _setTitleRunnerFactoryForTests(factory)

      await expect(summarizeTitle('a'.repeat(60))).resolves.toBeUndefined()
      expect(factory).toHaveBeenCalledTimes(1)
      expect(mockLog).toHaveBeenCalledTimes(1)
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[titles] model setup failed'))

      await expect(summarizeTitle('b'.repeat(60))).resolves.toBeUndefined()
      expect(factory).toHaveBeenCalledTimes(1)
      expect(mockLog).toHaveBeenCalledTimes(1)
    })

    it('retries the setup after the backoff window elapses', async () => {
      vi.useFakeTimers()
      const factory = vi.fn(() => Promise.reject(new Error('offline')))
      _setTitleRunnerFactoryForTests(factory)

      await summarizeTitle('a'.repeat(60))
      vi.advanceTimersByTime(10 * 60_000)
      await summarizeTitle('b'.repeat(60))
      expect(factory).toHaveBeenCalledTimes(2)
    })

    it('logs and returns undefined when inference itself throws (runner stays cached)', async () => {
      const run = vi.fn(() => Promise.reject(new Error('llama-completion exited 1')))
      const factory = vi.fn(() => Promise.resolve(run))
      _setTitleRunnerFactoryForTests(factory)

      await expect(summarizeTitle('a'.repeat(60))).resolves.toBeUndefined()
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[titles] inference failed'))

      await expect(summarizeTitle('b'.repeat(60))).resolves.toBeUndefined()
      expect(factory).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenCalledTimes(2)
    })
  })
})
