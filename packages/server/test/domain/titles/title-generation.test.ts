import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// The real store supplies the candidate rows; only the title writer is
// stubbed, so calls to it can be asserted.
vi.mock('#db/workspace-store', async (importOriginal) => ({
  ...(await importOriginal<typeof storeModule>()),
  setWorkspaceTitle: vi.fn(),
}))
// Every download and inference is a subprocess. Faking execFileAsync lets
// the summarizer and llama.cpp setup logic run for real.
vi.mock('#lib/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof shellModule>()),
  execFileAsync: vi.fn(),
}))

import { reconcileGeneratedTitles } from '#domain/titles'
import { _resetTitleGenerationForTests } from '#domain/titles/title-generation'
import { _resetTitleSummarizerForTests } from '#domain/titles/title-summarizer'
import { LLAMA_CPP_TAG } from '#domain/titles/llama-cpp'
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import { getProjectWorkspaceRows, setWorkspaceTitle } from '#db/workspace-store'
import {
  applyWorkspaceEvent,
  getQueuedWorkspaceRow,
  insertDraftWorkspace,
  insertQueuedWorkspace,
  listDraftWorkspaceRows,
  updateDraftWorkspace,
  updateQueuedWorkspace,
} from '#db'
import type * as storeModule from '#db/workspace-store'
import { closeDb } from '#db/client'
import { execFileAsync } from '#lib/shell'
import type * as shellModule from '#lib/shell'
import { serverLog } from '#log'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockSetTitle = vi.mocked(setWorkspaceTitle)
const mockExec = vi.mocked(execFileAsync)
const mockLog = vi.mocked(serverLog)

const MODEL_FILE = 'Qwen2.5-0.5B-Instruct-IQ4_XS.gguf'
const PROMPT = 'please refactor the widget factory into a proper plugin system'
const TITLE = 'Refactor widget factory into plugins'

/** Let the detached generation tasks finish. They probe the real
 *  filesystem, so a single tick is not enough. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 1))
}

interface ExecCall { file: string; args: string[]; opts?: { env?: Record<string, string> } }

let dataDir: string
let homeDir: string
let calls: ExecCall[]
/** Model stdout for one inference, keyed on the templated input it was given. */
let reply: (input: string) => Promise<string>
/** Whether the host has the OpenMP runtime the release links against. When
 *  false, every binary fails in the loader, as on a minimal Ubuntu. */
let openMpPresent: boolean
/** Whether the rootless `apt-get download libgomp1` repair can succeed. */
let aptAvailable: boolean
const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!
const archDesc = Object.getOwnPropertyDescriptor(process, 'arch')!

/** Every `sh -c …` command run. */
const shCommands = (): string[] => calls.filter((c) => c.file === 'sh').map((c) => c.args[1])
/** The release and model downloads, excluding the OpenMP repair. */
const downloads = (): string[] => shCommands().filter((c) => !c.includes('libgomp1'))
/** The rootless `libgomp1` fetch run when the smoke check fails. */
const openMpFetches = (): string[] => shCommands().filter((c) => c.includes('libgomp1'))
/** The post-extraction `--version` smoke check. */
const smokeChecks = (): ExecCall[] =>
  calls.filter((c) => c.file !== 'sh' && c.args[0] === '--version')
/** llama-completion inference calls (not shell-outs or smoke checks). */
const inferences = (): ExecCall[] =>
  calls.filter((c) => c.file !== 'sh' && c.args[0] !== '--version')
/** The templated payload the model was asked to title. */
const payloadOf = (call: ExecCall): string => call.args[call.args.indexOf('-p') + 1]

function stubPlatform(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
}

interface Seeded { projectSlug: string; workspaceId: string; prompt?: string; title?: string; stopped?: boolean }

function session(overrides: Partial<Seeded> = {}): Seeded {
  return { projectSlug: 'p', workspaceId: 's1', prompt: PROMPT, ...overrides }
}

/** Record each workspace as a create does: its row, then its first
 *  conversation with the opening message. */
async function seed(...workspaces: Seeded[]): Promise<void> {
  const real = await vi.importActual<typeof storeModule>('#db/workspace-store')
  for (const { projectSlug, workspaceId, prompt, title, stopped } of workspaces) {
    await applyWorkspaceEvent({ type: 'workspace-created', projectSlug, workspaceId })
    await applyWorkspaceEvent({
      type: 'sessions-launched', projectSlug, workspaceId,
      sessions: [{ agentSessionId: `${workspaceId}-a`, tool: 'claude', firstPrompt: prompt }],
    })
    if (title !== undefined) await real.setWorkspaceTitle(projectSlug, workspaceId, title)
    if (stopped) await applyWorkspaceEvent({ type: 'workspace-stopped', projectSlug, workspaceId })
  }
}

/** Pre-create the pinned binary and model so a run takes the cached path. */
async function seedCache(): Promise<string> {
  const dir = path.join(homeDir, '.cache', 'yaac', 'llama-cpp', `llama-${LLAMA_CPP_TAG}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'llama-completion'), '')
  await fs.mkdir(path.join(dataDir, 'server-local', 'models'), { recursive: true })
  await fs.writeFile(path.join(dataDir, 'server-local', 'models', MODEL_FILE), '')
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
    // Pin the platform so asset names do not depend on the test machine.
    stubPlatform('linux', 'arm64')

    calls = []
    reply = () => Promise.resolve(TITLE)
    openMpPresent = true
    aptAvailable = true
    mockSetTitle.mockResolvedValue(undefined)
    mockExec.mockImplementation(((file: string, args: string[], opts?: { env?: Record<string, string> }) => {
      calls.push({ file, args, opts })
      if (file === 'sh') {
        if (args[1].includes('libgomp1')) {
          if (!aptAvailable) return Promise.reject(new Error('sh: apt-get: not found'))
          // The repair puts the library beside the bundled .so files.
          openMpPresent = true
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      }
      // The loader fails every binary before main.
      if (!openMpPresent) {
        return Promise.reject(new Error(`Command failed: ${file} ${args.join(' ')}\n${file}: `
          + 'error while loading shared libraries: libgomp.so.1: cannot open shared '
          + 'object file: No such file or directory\n'))
      }
      if (args[0] === '--version') return Promise.resolve({ stdout: 'version: 9940', stderr: '' })
      return reply(payloadOf({ file, args })).then((stdout) => ({ stdout, stderr: '' }))
    }) as never)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', platformDesc)
    Object.defineProperty(process, 'arch', archDesc)
    await closeDb()
    await cleanupTempDir(dataDir)
    await fs.rm(homeDir, { recursive: true, force: true })
  })

  it('fetches the pinned runtime and model and titles the first message', async () => {
    await seed(session())
    await reconcileGeneratedTitles()
    await flush()

    // Extracted via a tmp dir and rename, so a torn download never
    // half-populates the target.
    const [release, model] = downloads()
    expect(release).toContain(
      `releases/download/${LLAMA_CPP_TAG}/llama-${LLAMA_CPP_TAG}-bin-ubuntu-arm64.tar.gz`)
    expect(release).toContain('.tmp')
    expect(release).toContain('mv ')
    // Qwen2.5-0.5B-Instruct at IQ4_XS, fetched into server-local/models.
    const target = path.join(dataDir, 'server-local', 'models', MODEL_FILE)
    expect(model).toContain('huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF')
    expect(model).toContain(`-o '${target}.tmp'`)
    expect(model).toContain(`mv '${target}.tmp' '${target}'`)

    // One greedy completion using the model's chat template.
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

    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', TITLE, { ifUntitled: true })
  })

  it('reuses a cached runtime and model instead of downloading', async () => {
    const bin = await seedCache()
    await seed(session())
    await reconcileGeneratedTitles()
    await flush()

    expect(downloads()).toEqual([])
    expect(inferences()).toHaveLength(1)
    expect(inferences()[0].file).toBe(bin)
    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', TITLE, { ifUntitled: true })
  })

  it('fetches the macOS asset on darwin/x64', async () => {
    stubPlatform('darwin', 'x64')
    await seed(session())
    await reconcileGeneratedTitles()
    await flush()
    expect(downloads()[0]).toContain(`llama-${LLAMA_CPP_TAG}-bin-macos-x64.tar.gz`)
  })

  it('strips the end-of-text marker, wrapping quotes and trailing periods, then normalizes', async () => {
    await seedCache()
    reply = () => Promise.resolve(' "Fix  the \n parser bug." [end of text]\n\n')
    await seed(session({ prompt: 'the parser has a bug with nested arrays, please fix it and add a regression test' }))
    await reconcileGeneratedTitles()
    await flush()
    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', 'Fix the parser bug', { ifUntitled: true })
  })

  it('caps a runaway title at the shared title length limit', async () => {
    await seedCache()
    reply = () => Promise.resolve('w'.repeat(300))
    await seed(session({ prompt: 'w'.repeat(300) }))
    await reconcileGeneratedTitles()
    await flush()
    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', 'w'.repeat(MAX_TITLE_LENGTH), { ifUntitled: true })
  })

  it('truncates a huge first message to a bounded payload', async () => {
    await seedCache()
    reply = () => Promise.resolve('yyyy padding title')
    await seed(session({ prompt: 'y'.repeat(5000) }))
    await reconcileGeneratedTitles()
    await flush()
    // The message is appended after the instruction, past a blank line.
    const message = payloadOf(inferences()[0]).split('\n\n').slice(1).join('\n\n')
    expect(message).toBe('y'.repeat(1000))
  })

  it('keeps the prompt fallback for unusable or hallucinated output', async () => {
    await seedCache()
    // Quotes-only output normalizes to nothing; "adolescent symphony" shares
    // no content word with its prompt.
    reply = (input) => Promise.resolve(input.includes('parser') ? ' "..." ' : 'adolescent symphony')
    await seed(
      session({ workspaceId: 'empty', prompt: 'the parser has a bug with nested arrays, please fix it today' }),
      session({ workspaceId: 'halluc', prompt: PROMPT }),
    )
    await reconcileGeneratedTitles()
    await flush()

    expect(inferences()).toHaveLength(2)
    expect(mockSetTitle).not.toHaveBeenCalled()
  })

  it('keeps on-topic titles matched by substring, and ones made only of short words', async () => {
    await seedCache()
    reply = (input) => Promise.resolve(input.includes('github')
      // "action" matches "actions" by substring containment.
      ? 'github action workflow set up'
      // No content word (4+ chars) to check, so it is kept.
      : 'Fix it now')
    await seed(
      session({ workspaceId: 'gha', prompt: 'set up a github actions workflow that runs lint and unit tests on every pull request' }),
      session({ workspaceId: 'link', projectSlug: 'q', prompt: 'the build is failing on macos with a linker error about missing symbols, figure out why' }),
    )
    await reconcileGeneratedTitles()
    await flush()

    expect(mockSetTitle).toHaveBeenCalledWith('p', 'gha', 'github action workflow set up', { ifUntitled: true })
    expect(mockSetTitle).toHaveBeenCalledWith('q', 'link', 'Fix it now', { ifUntitled: true })
  })

  it('serializes inference across workspaces and sets the runtime up once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    reply = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return TITLE
    }
    await seed(session(), session({ workspaceId: 's2', projectSlug: 'q' }))
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
    await seed(session())
    await reconcileGeneratedTitles()
    await flush()
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('skips titled, promptless, and stopped workspaces, and prompts short enough to label themselves', async () => {
    await seedCache()
    await seed(
      session({ workspaceId: 'titled', title: 'My session' }),
      session({ workspaceId: 'no-prompt', prompt: undefined }),
      session({ workspaceId: 'short', prompt: 'x'.repeat(48) }),
      session({ workspaceId: 'stopped', stopped: true }),
    )
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toEqual([])
    expect(mockSetTitle).not.toHaveBeenCalled()
  })

  it('attempts each session once per server run, even after a later tick', async () => {
    await seedCache()
    await seed(session())
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toHaveLength(1)

    // Still untitled on a later tick (title cleared, or generation failed):
    // no second attempt.
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toHaveLength(1)
  })

  it('does not double-fire while a generation is still in flight', async () => {
    await seedCache()
    let release!: (title: string) => void
    reply = () => new Promise<string>((r) => { release = r })
    await seed(session())

    await reconcileGeneratedTitles()
    await flush()
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toHaveLength(1)

    release(TITLE)
    await flush()
    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', TITLE, { ifUntitled: true })
  })

  // A draft gets one attempt per saved prompt, unless the user titled it.
  it('titles a draft workspace, and again once its prompt is edited', async () => {
    await seedCache()
    const draft = await insertDraftWorkspace('p', {
      prompt: PROMPT, tool: 'claude', mode: 'tui', permissionMode: 'manual',
    })
    await insertDraftWorkspace('p', { prompt: 'short enough', tool: 'claude', mode: 'tui', permissionMode: 'manual' })
    await insertDraftWorkspace('p', { prompt: PROMPT, tool: 'claude', mode: 'tui', permissionMode: 'manual', title: 'Mine' })
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toHaveLength(1)
    const titleOf = async (): Promise<string | undefined> =>
      (await listDraftWorkspaceRows()).find((d) => d.id === draft.id)?.generatedTitle
    expect(await titleOf()).toBe(TITLE)

    const edited = `${PROMPT}, and document the widget registry`
    reply = () => Promise.resolve('Document widget registry')
    await updateDraftWorkspace('p', draft.id, { prompt: edited, tool: 'claude', mode: 'tui', permissionMode: 'manual' })
    await reconcileGeneratedTitles()
    await flush()
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toHaveLength(2)
    expect(payloadOf(inferences()[1])).toContain(edited)
    expect(await titleOf()).toBe('Document widget registry')
    // Drafts are titled in their own row, not through the workspace writer.
    expect(mockSetTitle).not.toHaveBeenCalled()
  })

  it('titles a queued workspace, and again once its prompt is edited', async () => {
    await seedCache()
    const settings = {
      prompt: PROMPT, tool: 'claude', model: 'opus', mode: 'tui', permissionMode: 'manual', branch: 'main',
    } as const
    const entry = await insertQueuedWorkspace('p', { parentWorkspaceId: 'w' }, settings)
    await insertQueuedWorkspace('p', { parentWorkspaceId: 'w' }, { ...settings, title: 'Mine' })
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toHaveLength(1)
    const titleOf = async (): Promise<string | undefined> => (await getQueuedWorkspaceRow(entry.id))?.generatedTitle
    expect(await titleOf()).toBe(TITLE)

    const edited = `${PROMPT}, and document the widget registry`
    reply = () => Promise.resolve('Document widget registry')
    await updateQueuedWorkspace(entry.id, { ...settings, prompt: edited })
    await reconcileGeneratedTitles()
    await flush()
    expect(inferences()).toHaveLength(2)
    expect(await titleOf()).toBe('Document widget registry')
    expect(mockSetTitle).not.toHaveBeenCalled()
  })

  it('keeps a rename that lands while the model is still running', async () => {
    const real = await vi.importActual<typeof storeModule>('#db/workspace-store')
    mockSetTitle.mockImplementation(real.setWorkspaceTitle)
    await seedCache()
    let release!: (title: string) => void
    reply = () => new Promise<string>((r) => { release = r })
    await seed(session())

    await reconcileGeneratedTitles()
    await flush()
    await real.setWorkspaceTitle('p', 's1', 'my rename')
    release(TITLE)
    await flush()

    expect((await getProjectWorkspaceRows('p')).get('s1')?.title).toBe('my rename')
  })

  it('vendors the OpenMP runtime into the cache when the host lacks it', async () => {
    const bin = await seedCache()
    openMpPresent = false // a minimal Ubuntu: extraction succeeds, nothing runs
    await seed(session())
    await reconcileGeneratedTitles()
    await flush()

    // Fetched rootlessly from the distro mirror into the archive's lib dir,
    // which is already on the loader path.
    const [repair] = openMpFetches()
    expect(repair).toContain('apt-get download libgomp1')
    expect(repair).toContain('dpkg-deb -x')
    expect(repair).toContain(`cp x/usr/lib/*/libgomp.so.1* '${path.dirname(bin)}/'`)
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[titles] vendored libgomp.so.1'))

    // Re-checked after the repair, then used to title the session.
    expect(smokeChecks()).toHaveLength(2)
    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', TITLE, { ifUntitled: true })
  })

  it('reports one actionable error when the runtime cannot run and cannot be repaired', async () => {
    await seedCache()
    openMpPresent = false
    aptAvailable = false // no apt, or an index too stale to resolve it
    await seed(session(), session({ workspaceId: 's2', projectSlug: 'q' }))
    await reconcileGeneratedTitles()
    await flush()

    // The smoke check yields one setup error naming the fix, instead of an
    // inference failure per session.
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[titles] model setup failed'))
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('sudo apt install libgomp1'))
    expect(inferences()).toEqual([])
    expect(mockSetTitle).not.toHaveBeenCalled()
  })

  it('logs a setup failure once and fast-fails the rest of the backoff window', async () => {
    mockExec.mockRejectedValue(new Error('curl: (6) Could not resolve host'))
    await seed(session(), session({ workspaceId: 's2', projectSlug: 'q' }))
    await reconcileGeneratedTitles()
    await flush()

    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[titles] model setup failed'))
    expect(mockSetTitle).not.toHaveBeenCalled()
    // The second session fast-fails during the backoff.
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('retries the setup after the backoff window elapses', async () => {
    // Fake only Date; faked timers would stall the real filesystem probes.
    vi.useFakeTimers({ toFake: ['Date'] })
    mockExec.mockRejectedValue(new Error('offline'))
    await seed(session())
    await reconcileGeneratedTitles()
    await flush()
    expect(mockExec).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 10 * 60_000 + 1)
    _resetTitleGenerationForTests() // a later tick, same server run
    await reconcileGeneratedTitles()
    await flush()
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('logs an inference failure and keeps the runtime cached for the next session', async () => {
    await seedCache()
    reply = () => Promise.reject(new Error('llama-completion exited 1'))
    await seed(session(), session({ workspaceId: 's2', projectSlug: 'q' }))
    await reconcileGeneratedTitles()
    await flush()

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[titles] inference failed'))
    expect(mockSetTitle).not.toHaveBeenCalled()
    // Setup succeeded, so both workspaces reached the model.
    expect(inferences()).toHaveLength(2)
  })

  it('logs a persist failure without an unhandled rejection', async () => {
    await seedCache()
    mockSetTitle.mockRejectedValue(new Error('EACCES'))
    await seed(session())
    await reconcileGeneratedTitles()
    await flush()
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[titles] p/s1:'))
  })
})
