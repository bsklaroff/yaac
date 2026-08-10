import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('#domain/worktrees/list', () => ({ listActiveWorktrees: vi.fn() }))
vi.mock('#records/worktree-store', () => ({ setWorktreeTitle: vi.fn() }))
vi.mock('#notify', () => ({ notifyWorktreeListChanged: vi.fn() }))
vi.mock('#log', () => ({ serverLog: vi.fn() }))
// The one boundary this feature has: every download and every inference is a
// subprocess. Faking it here lets the summarizer and the pinned llama.cpp
// runtime behind it run for real.
vi.mock('#platform/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof shellModule>()),
  execFileAsync: vi.fn(),
}))

import { reconcileGeneratedTitles } from '#domain/titles'
import { _resetTitleGenerationForTests } from '#domain/titles/title-generation'
import { _resetTitleSummarizerForTests } from '#domain/titles/title-summarizer'
// Setup values: the pinned release tag names the asset we expect fetched,
// and the title cap bounds what may be persisted.
import { LLAMA_CPP_TAG } from '#domain/titles/llama-cpp'
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import { listActiveWorktrees } from '#domain/worktrees/list'
import { setWorktreeTitle } from '#records/worktree-store'
import { notifyWorktreeListChanged } from '#notify'
import { execFileAsync } from '#platform/shell'
import type * as shellModule from '#platform/shell'
import { serverLog } from '#log'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type { WorktreeListEntry } from '@yaac/shared/types'

const mockList = vi.mocked(listActiveWorktrees)
const mockSetTitle = vi.mocked(setWorktreeTitle)
const mockNotify = vi.mocked(notifyWorktreeListChanged)
const mockExec = vi.mocked(execFileAsync)
const mockLog = vi.mocked(serverLog)

const MODEL_FILE = 'Qwen2.5-0.5B-Instruct-IQ4_XS.gguf'
const PROMPT = 'please refactor the widget factory into a proper plugin system'
const TITLE = 'Refactor widget factory into plugins'

/** Let the detached generation tasks finish. They probe the real filesystem
 *  for the cached binary and model, so a single tick is not enough. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 1))
}

interface ExecCall { file: string; args: string[]; opts?: { env?: Record<string, string> } }

let dataDir: string
let homeDir: string
let calls: ExecCall[]
/** Model stdout for one inference, keyed on the templated input it was given. */
let reply: (input: string) => Promise<string>
const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!
const archDesc = Object.getOwnPropertyDescriptor(process, 'arch')!

/** `sh -c …` commands the feature shelled out for downloads. */
const downloads = (): string[] => calls.filter((c) => c.file === 'sh').map((c) => c.args[1])
/** llama-completion invocations (everything that isn't a download). */
const inferences = (): ExecCall[] => calls.filter((c) => c.file !== 'sh')
/** The templated payload the model was asked to title. */
const payloadOf = (call: ExecCall): string => call.args[call.args.indexOf('-p') + 1]

function stubPlatform(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
}

function session(overrides: Partial<WorktreeListEntry> = {}): WorktreeListEntry {
  return {
    worktreeId: 's1',
    projectSlug: 'p',
    tool: 'claude',
    status: 'waiting',
    createdAt: '2026-01-01 00:00:00',
    prompt: PROMPT,
    blockedHosts: [],
    forwardedPorts: [],
    unforwardedPorts: [],
    agentSessions: [],
    ...overrides,
  }
}

function listOf(...worktrees: WorktreeListEntry[]): void {
  mockList.mockResolvedValue({ worktrees, stale: [], gitAuthFailures: {} })
}

/** Pre-create the pinned binary and model so a run takes the cached path. */
async function seedCache(): Promise<string> {
  const dir = path.join(homeDir, '.cache', 'yaac', 'llama-cpp', `llama-${LLAMA_CPP_TAG}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'llama-completion'), '')
  await fs.mkdir(path.join(dataDir, 'models'), { recursive: true })
  await fs.writeFile(path.join(dataDir, 'models', MODEL_FILE), '')
  return path.join(dir, 'llama-completion')
}

describe('reconcileGeneratedTitles', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    _resetTitleGenerationForTests()
    _resetTitleSummarizerForTests()
    vi.stubEnv('YAAC_AUTO_TITLES', undefined)
    dataDir = await createTempDataDir()
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-home-'))
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
    // Pin the release matrix so asset-name assertions don't depend on the
    // machine running the suite.
    stubPlatform('linux', 'arm64')

    calls = []
    reply = () => Promise.resolve(TITLE)
    mockSetTitle.mockResolvedValue(undefined)
    mockExec.mockImplementation(((file: string, args: string[], opts?: { env?: Record<string, string> }) => {
      calls.push({ file, args, opts })
      if (file === 'sh') return Promise.resolve({ stdout: '', stderr: '' })
      return reply(payloadOf({ file, args })).then((stdout) => ({ stdout, stderr: '' }))
    }) as never)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', platformDesc)
    Object.defineProperty(process, 'arch', archDesc)
    await cleanupTempDir(dataDir)
    await fs.rm(homeDir, { recursive: true, force: true })
  })

  it('fetches the pinned runtime and model, titles the first message, and notifies', async () => {
    listOf(session())
    await reconcileGeneratedTitles()
    await flush()

    // The pinned llama.cpp release for this platform, extracted via a tmp
    // dir + rename so a torn download never half-populates the target.
    const [release, model] = downloads()
    expect(release).toContain(
      `releases/download/${LLAMA_CPP_TAG}/llama-${LLAMA_CPP_TAG}-bin-ubuntu-arm64.tar.gz`)
    expect(release).toContain('.tmp')
    expect(release).toContain('mv ')
    // The model pin: Qwen2.5-0.5B-Instruct at IQ4_XS, fetched into <dataDir>/models.
    const target = path.join(dataDir, 'models', MODEL_FILE)
    expect(model).toContain('huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF')
    expect(model).toContain(`-o '${target}.tmp'`)
    expect(model).toContain(`mv '${target}.tmp' '${target}'`)

    // One greedy, one-shot completion through the model's own chat template.
    const bin = path.join(homeDir, '.cache', 'yaac', 'llama-cpp', `llama-${LLAMA_CPP_TAG}`, 'llama-completion')
    const [call] = inferences()
    expect(call.file).toBe(bin)
    expect(call.args).toEqual([
      '-m', target, '--jinja', '-st',
      '-sys', "You write concise, specific titles for a developer tool's session list.",
      '-p', expect.stringContaining(PROMPT) as unknown as string,
      '-n', '32', '--temp', '0', '--no-display-prompt', '--simple-io',
    ])
    expect(payloadOf(call)).toMatch(/^Write a short, specific title/)
    // The archive's shared libs sit beside the binary.
    expect(call.opts?.env?.LD_LIBRARY_PATH).toBe(path.dirname(bin))
    expect(call.opts?.env?.DYLD_LIBRARY_PATH).toBe(path.dirname(bin))

    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', TITLE)
    expect(mockNotify).toHaveBeenCalledTimes(1)
  })

  it('reuses a cached runtime and model instead of downloading', async () => {
    const bin = await seedCache()
    listOf(session())
    await reconcileGeneratedTitles()
    await flush()

    expect(downloads()).toEqual([])
    expect(inferences()).toHaveLength(1)
    expect(inferences()[0].file).toBe(bin)
    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', TITLE)
  })

  it('fetches the macOS asset on darwin/x64', async () => {
    stubPlatform('darwin', 'x64')
    listOf(session())
    await reconcileGeneratedTitles()
    await flush()
    expect(downloads()[0]).toContain(`llama-${LLAMA_CPP_TAG}-bin-macos-x64.tar.gz`)
  })

  it('strips the end-of-text marker, wrapping quotes and trailing periods, then normalizes', async () => {
    await seedCache()
    reply = () => Promise.resolve(' "Fix  the \n parser bug." [end of text]\n\n')
    listOf(session({ prompt: 'the parser has a bug with nested arrays, please fix it and add a regression test' }))
    await reconcileGeneratedTitles()
    await flush()
    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', 'Fix the parser bug')
  })

  it('caps a runaway title at the shared title length limit', async () => {
    await seedCache()
    reply = () => Promise.resolve('w'.repeat(300))
    listOf(session({ prompt: 'w'.repeat(300) }))
    await reconcileGeneratedTitles()
    await flush()
    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', 'w'.repeat(MAX_TITLE_LENGTH))
  })

  it('truncates a huge first message to a bounded payload', async () => {
    await seedCache()
    reply = () => Promise.resolve('yyyy padding title')
    listOf(session({ prompt: 'y'.repeat(5000) }))
    await reconcileGeneratedTitles()
    await flush()
    // The message is appended after the instruction, past a blank line.
    const message = payloadOf(inferences()[0]).split('\n\n').slice(1).join('\n\n')
    expect(message).toBe('y'.repeat(1000))
  })

  it('keeps the prompt fallback for unusable or hallucinated output', async () => {
    await seedCache()
    // Quotes-only output normalizes to nothing; "adolescent symphony" shares
    // no content word with its prompt and would be worse than the fallback.
    reply = (input) => Promise.resolve(input.includes('parser') ? ' "..." ' : 'adolescent symphony')
    listOf(
      session({ worktreeId: 'empty', prompt: 'the parser has a bug with nested arrays, please fix it today' }),
      session({ worktreeId: 'halluc', prompt: PROMPT }),
    )
    await reconcileGeneratedTitles()
    await flush()

    expect(inferences()).toHaveLength(2)
    expect(mockSetTitle).not.toHaveBeenCalled()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('keeps on-topic titles matched by substring, and ones made only of short words', async () => {
    await seedCache()
    reply = (input) => Promise.resolve(input.includes('github')
      // "action" matches "actions" by substring containment.
      ? 'github action workflow set up'
      // No content word (4+ chars) to judge by — kept as-is.
      : 'Fix it now')
    listOf(
      session({ worktreeId: 'gha', prompt: 'set up a github actions workflow that runs lint and unit tests on every pull request' }),
      session({ worktreeId: 'link', projectSlug: 'q', prompt: 'the build is failing on macos with a linker error about missing symbols, figure out why' }),
    )
    await reconcileGeneratedTitles()
    await flush()

    expect(mockSetTitle).toHaveBeenCalledWith('p', 'gha', 'github action workflow set up')
    expect(mockSetTitle).toHaveBeenCalledWith('q', 'link', 'Fix it now')
  })

  it('serializes inference across worktrees and sets the runtime up once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    reply = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return TITLE
    }
    listOf(session(), session({ worktreeId: 's2', projectSlug: 'q' }))
    await reconcileGeneratedTitles()
    await new Promise((r) => setTimeout(r, 50))

    // Concurrent spawns would stack model-load memory.
    expect(maxInFlight).toBe(1)
    expect(inferences()).toHaveLength(2)
    // Runtime + model fetched once, not per session.
    expect(downloads()).toHaveLength(2)
    expect(mockSetTitle).toHaveBeenCalledTimes(2)
  })

  it('is a no-op when YAAC_AUTO_TITLES=0', async () => {
    vi.stubEnv('YAAC_AUTO_TITLES', '0')
    await reconcileGeneratedTitles()
    expect(mockList).not.toHaveBeenCalled()
  })

  it('skips titled worktrees, promptless ones, and prompts short enough to label themselves', async () => {
    await seedCache()
    listOf(
      session({ worktreeId: 'titled', title: 'My session' }),
      session({ worktreeId: 'no-prompt', prompt: undefined }),
      session({ worktreeId: 'short', prompt: 'x'.repeat(48) }),
    )
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toEqual([])
    expect(mockSetTitle).not.toHaveBeenCalled()
  })

  it('attempts each session once per server run, even after a later tick', async () => {
    await seedCache()
    listOf(session())
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toHaveLength(1)

    // Still untitled on a later tick (the user cleared the generated title,
    // or generation failed) — no second attempt.
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toHaveLength(1)
  })

  it('does not double-fire while a generation is still in flight', async () => {
    await seedCache()
    let release!: (title: string) => void
    reply = () => new Promise<string>((r) => { release = r })
    listOf(session())

    await reconcileGeneratedTitles()
    await flush()
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toHaveLength(1)

    release(TITLE)
    await flush()
    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', TITLE)
  })

  it('logs a setup failure once and fast-fails the rest of the backoff window', async () => {
    mockExec.mockRejectedValue(new Error('curl: (6) Could not resolve host'))
    listOf(session(), session({ worktreeId: 's2', projectSlug: 'q' }))
    await reconcileGeneratedTitles()
    await flush()

    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[titles] model setup failed'))
    expect(mockSetTitle).not.toHaveBeenCalled()
    // The second session fast-fails on the backoff mark: one attempt total.
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('retries the setup after the backoff window elapses', async () => {
    // Only the clock is faked: the flow awaits real filesystem probes, which
    // faked timers would never let settle.
    vi.useFakeTimers({ toFake: ['Date'] })
    mockExec.mockRejectedValue(new Error('offline'))
    listOf(session())
    await reconcileGeneratedTitles()
    await flush()
    expect(mockExec).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 10 * 60_000 + 1)
    _resetTitleGenerationForTests() // a later tick, same server run
    listOf(session())
    await reconcileGeneratedTitles()
    await flush()
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('logs an inference failure and keeps the runtime cached for the next session', async () => {
    await seedCache()
    reply = () => Promise.reject(new Error('llama-completion exited 1'))
    listOf(session(), session({ worktreeId: 's2', projectSlug: 'q' }))
    await reconcileGeneratedTitles()
    await flush()

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[titles] inference failed'))
    expect(mockSetTitle).not.toHaveBeenCalled()
    // Setup succeeded, so both worktrees reached the model.
    expect(inferences()).toHaveLength(2)
  })

  it('logs a persist failure without an unhandled rejection', async () => {
    await seedCache()
    mockSetTitle.mockRejectedValue(new Error('EACCES'))
    listOf(session())
    await reconcileGeneratedTitles()
    await flush()
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[titles] p/s1:'))
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('swallows a session-list failure', async () => {
    mockList.mockRejectedValue(new Error('server starting'))
    await expect(reconcileGeneratedTitles()).resolves.toBeUndefined()
  })
})
