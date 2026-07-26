/**
 * Pinned llama.cpp runtime for local model inference. Fetches the
 * platform's CPU release archive from GitHub once (the ensurePinnedBinary
 * download-and-pin convention: ~/.cache/yaac, pinned tag, curl | tar),
 * fetches GGUF models into `<dataDir>/models`, and runs one-shot greedy
 * completions via the `llama-completion` binary. Each completion is a
 * short-lived subprocess, so nothing stays resident between calls.
 *
 * The tag is pinned (not "latest") deliberately: T5 encoder-decoder
 * support in llama.cpp is not CI-protected upstream and has regressed
 * silently before, so bumps must re-verify title output quality.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileAsync } from '#platform/k8s/kubectl'
import { getDataDir } from '@yaac/shared/paths'

/** Pinned llama.cpp release tag; CPU archives exist for linux/macOS × x64/arm64. */
export const LLAMA_CPP_TAG = 'b9940'

export interface LlamaCppDeps {
  /** execFile-style runner, injectable for tests. */
  run: typeof execFileAsync
  fileExists: (p: string) => Promise<boolean>
  homedir: () => string
  platform: NodeJS.Platform
  arch: string
}

const defaultDeps: LlamaCppDeps = {
  run: execFileAsync,
  fileExists: async (p: string) => {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  },
  homedir: os.homedir,
  platform: process.platform,
  arch: process.arch,
}

/** Directory the pinned release archive extracts to (binaries + shared libs). */
export function llamaCppDir(deps: LlamaCppDeps = defaultDeps): string {
  return path.join(deps.homedir(), '.cache', 'yaac', 'llama-cpp', `llama-${LLAMA_CPP_TAG}`)
}

/**
 * Ensure the pinned llama.cpp release is present, downloading it once
 * (~10-16MB from github.com). Returns the `llama-completion` binary path.
 * The archive's shared libraries live beside the binaries, so the whole
 * extracted directory is kept. Extraction goes through a tmp dir with a
 * final rename, so a torn download never half-populates the target.
 */
export async function ensureLlamaCpp(deps: LlamaCppDeps = defaultDeps): Promise<string> {
  const dir = llamaCppDir(deps)
  const bin = path.join(dir, 'llama-completion')
  if (await deps.fileExists(bin)) return bin

  const osName = deps.platform === 'darwin' ? 'macos' : 'ubuntu'
  const archName = deps.arch === 'arm64' ? 'arm64' : 'x64'
  const url = 'https://github.com/ggml-org/llama.cpp/releases/download/'
    + `${LLAMA_CPP_TAG}/llama-${LLAMA_CPP_TAG}-bin-${osName}-${archName}.tar.gz`
  const tmp = `${dir}.tmp`
  await deps.run('sh', ['-c',
    `rm -rf '${tmp}' && mkdir -p '${tmp}' && curl -fsSL '${url}' | tar -xz -C '${tmp}' `
    + `&& rm -rf '${dir}' && mv '${tmp}/llama-${LLAMA_CPP_TAG}' '${dir}' && rm -rf '${tmp}'`,
  ], { timeout: 300_000 })
  return bin
}

/**
 * Ensure a GGUF model is present under `<dataDir>/models`, downloading it
 * once (tmp + rename, so a torn download is never mistaken for a model).
 */
export async function ensureGgufModel(
  url: string,
  filename: string,
  deps: LlamaCppDeps = defaultDeps,
): Promise<string> {
  const modelsDir = path.join(getDataDir(), 'models')
  const target = path.join(modelsDir, filename)
  if (await deps.fileExists(target)) return target

  await deps.run('sh', ['-c',
    `mkdir -p '${modelsDir}' && curl -fsSL -o '${target}.tmp' '${url}' `
    + `&& mv '${target}.tmp' '${target}'`,
  ], { timeout: 600_000 })
  return target
}

/**
 * Run one greedy chat completion and return the generated text (the
 * `[end of text]` marker llama-completion appends is stripped). Applies the
 * model's own chat template via `--jinja`, runs a single predefined user turn
 * (`-st`), then exits — nothing stays loaded. `--simple-io` keeps the output
 * clean when spawned as a subprocess.
 */
export async function runChatCompletion(
  bin: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  deps: LlamaCppDeps = defaultDeps,
): Promise<string> {
  const dir = path.dirname(bin)
  const { stdout } = await deps.run(bin, [
    '-m', model,
    '--jinja', '-st',
    '-sys', system,
    '-p', user,
    '-n', String(maxTokens),
    '--temp', '0',
    '--no-display-prompt',
    '--simple-io',
  ], {
    timeout: 120_000,
    // eslint-disable-next-line no-process-env -- env forwarded wholesale to the subprocess, adding the loader path for the archive's bundled shared libs (LD_ for linux, DYLD_ for macOS)
    env: { ...process.env, LD_LIBRARY_PATH: dir, DYLD_LIBRARY_PATH: dir },
  })
  return stdout.replace(/\[end of text\]\s*$/, '').trim()
}
