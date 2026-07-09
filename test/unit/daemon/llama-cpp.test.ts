import { describe, it, expect, vi, afterEach } from 'vitest'
import path from 'node:path'
import {
  LLAMA_CPP_TAG,
  llamaCppDir,
  ensureLlamaCpp,
  ensureGgufModel,
  runCompletion,
  type LlamaCppDeps,
} from '@/daemon/llama-cpp'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'

function stubDeps(overrides: Partial<LlamaCppDeps> = {}): LlamaCppDeps & {
  run: ReturnType<typeof vi.fn>
} {
  return {
    run: vi.fn(() => Promise.resolve({ stdout: '', stderr: '' })) as never,
    fileExists: () => Promise.resolve(false),
    homedir: () => '/home/u',
    platform: 'linux',
    arch: 'arm64',
    ...overrides,
  } as LlamaCppDeps & { run: ReturnType<typeof vi.fn> }
}

describe('llama-cpp runtime', () => {
  describe('llamaCppDir', () => {
    it('is a pinned-tag dir under ~/.cache/yaac', () => {
      expect(llamaCppDir(stubDeps())).toBe(
        `/home/u/.cache/yaac/llama-cpp/llama-${LLAMA_CPP_TAG}`)
    })
  })

  describe('ensureLlamaCpp', () => {
    it('returns the cached binary without downloading', async () => {
      const deps = stubDeps({ fileExists: () => Promise.resolve(true) })
      const bin = await ensureLlamaCpp(deps)
      expect(bin).toBe(path.join(llamaCppDir(deps), 'llama-completion'))
      expect(deps.run).not.toHaveBeenCalled()
    })

    it('downloads the pinned release asset for the platform', async () => {
      const deps = stubDeps()
      await ensureLlamaCpp(deps)
      expect(deps.run).toHaveBeenCalledTimes(1)
      const [file, args] = deps.run.mock.calls[0] as [string, string[]]
      expect(file).toBe('sh')
      const cmd = args[1]
      expect(cmd).toContain(
        `releases/download/${LLAMA_CPP_TAG}/llama-${LLAMA_CPP_TAG}-bin-ubuntu-arm64.tar.gz`)
      // Torn downloads must never half-populate the target dir.
      expect(cmd).toContain('.tmp')
      expect(cmd).toContain('mv ')
    })

    it('maps darwin/x64 to the macos-x64 asset', async () => {
      const deps = stubDeps({ platform: 'darwin', arch: 'x64' })
      await ensureLlamaCpp(deps)
      const [, args] = deps.run.mock.calls[0] as [string, string[]]
      expect(args[1]).toContain(`llama-${LLAMA_CPP_TAG}-bin-macos-x64.tar.gz`)
    })
  })

  describe('ensureGgufModel', () => {
    let tmpDir: string
    afterEach(async () => cleanupTempDir(tmpDir))

    it('returns the cached model without downloading', async () => {
      tmpDir = await createTempDataDir()
      const deps = stubDeps({ fileExists: () => Promise.resolve(true) })
      const p = await ensureGgufModel('https://example.com/m.gguf', 'm.gguf', deps)
      expect(p).toBe(path.join(tmpDir, 'models', 'm.gguf'))
      expect(deps.run).not.toHaveBeenCalled()
    })

    it('downloads via tmp + rename into <dataDir>/models', async () => {
      tmpDir = await createTempDataDir()
      const deps = stubDeps()
      const p = await ensureGgufModel('https://example.com/m.gguf', 'm.gguf', deps)
      expect(p).toBe(path.join(tmpDir, 'models', 'm.gguf'))
      const [, args] = deps.run.mock.calls[0] as [string, string[]]
      expect(args[1]).toContain('https://example.com/m.gguf')
      expect(args[1]).toContain(`-o '${p}.tmp'`)
      expect(args[1]).toContain(`mv '${p}.tmp' '${p}'`)
    })
  })

  describe('runCompletion', () => {
    it('spawns a one-shot greedy completion and strips the end marker', async () => {
      const deps = stubDeps()
      deps.run.mockResolvedValue({ stdout: ' a short title [end of text]\n\n', stderr: '' })
      const out = await runCompletion('/opt/llama/llama-completion', '/m.gguf', 'prompt!', 16, deps)
      expect(out).toBe('a short title')
      const [file, args, opts] = deps.run.mock.calls[0] as [
        string, string[], { env: Record<string, string> },
      ]
      expect(file).toBe('/opt/llama/llama-completion')
      expect(args).toEqual([
        '-m', '/m.gguf', '-p', 'prompt!', '-n', '16', '--temp', '0', '--no-display-prompt',
      ])
      // The archive's shared libs sit beside the binary.
      expect(opts.env.LD_LIBRARY_PATH).toBe('/opt/llama')
      expect(opts.env.DYLD_LIBRARY_PATH).toBe('/opt/llama')
    })

    it('propagates a subprocess failure', async () => {
      const deps = stubDeps()
      deps.run.mockRejectedValue(new Error('spawn ENOENT'))
      await expect(runCompletion('/b', '/m', 'p', 16, deps)).rejects.toThrow('spawn ENOENT')
    })
  })
})
