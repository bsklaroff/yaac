/**
 * Pinned llama.cpp runtime for local model inference. Downloads the
 * platform's CPU release archive from GitHub once into ~/.cache/yaac, fetches
 * GGUF models into `<dataDir>/models`, and runs one-shot greedy completions
 * with `llama-completion` (a short-lived subprocess per call).
 *
 * The tag is pinned because T5 encoder-decoder support is not tested
 * upstream and has regressed silently; re-check title quality when bumping.
 *
 * After extraction a smoke check runs the binary, since the archive links
 * against a system OpenMP runtime it doesn't ship. Without the check, such a
 * host would fail every inference silently instead of reporting one setup
 * error.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileAsync } from '#lib/shell'
import { serverLog } from '#log'
import { serverLocalPath } from '@yaac/shared/paths'

/** Pinned llama.cpp release tag; CPU archives exist for linux/macOS × x64/arm64. */
export const LLAMA_CPP_TAG = 'b9940'

/** The system library the ubuntu CPU archive links against but doesn't ship.
 *  Without it, no binary in the release starts. */
const OPENMP_SONAME = 'libgomp.so.1'

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Directory the pinned release archive extracts to (binaries + shared libs). */
export function llamaCppDir(): string {
  return path.join(os.homedir(), '.cache', 'yaac', 'llama-cpp', `llama-${LLAMA_CPP_TAG}`)
}

/**
 * Ensure the pinned llama.cpp release is present and runnable, downloading
 * it once (~10-16MB) via a tmp dir and rename so a torn download never
 * half-populates the target. Returns the `llama-completion` path. Throws if
 * the runtime can't run, so the caller reports one backed-off setup error.
 */
export async function ensureLlamaCpp(): Promise<string> {
  const dir = llamaCppDir()
  const bin = path.join(dir, 'llama-completion')
  if (!(await fileExists(bin))) {
    const osName = process.platform === 'darwin' ? 'macos' : 'ubuntu'
    const archName = process.arch === 'arm64' ? 'arm64' : 'x64'
    const url = 'https://github.com/ggml-org/llama.cpp/releases/download/'
      + `${LLAMA_CPP_TAG}/llama-${LLAMA_CPP_TAG}-bin-${osName}-${archName}.tar.gz`
    const tmp = `${dir}.tmp`
    await execFileAsync('sh', ['-c',
      `rm -rf '${tmp}' && mkdir -p '${tmp}' && curl -fsSL '${url}' | tar -xz -C '${tmp}' `
      + `&& rm -rf '${dir}' && mv '${tmp}/llama-${LLAMA_CPP_TAG}' '${dir}' && rm -rf '${tmp}'`,
    ], { timeout: 300_000 })
  }
  await ensureRuntimeRuns(bin)
  return bin
}

/**
 * Loader environment for the release, whose shared libraries sit beside the
 * binaries rather than on the system search path.
 */
function llamaEnv(dir: string): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-process-env -- env forwarded wholesale to the subprocess, adding the loader path for the archive's bundled shared libs
  return { ...process.env, LD_LIBRARY_PATH: dir, DYLD_LIBRARY_PATH: dir }
}

/** Run `--version`. Returns undefined if the binary loads, else the error
 *  message (which names any missing library). */
async function runFailure(bin: string): Promise<string | undefined> {
  try {
    await execFileAsync(bin, ['--version'], {
      timeout: 60_000,
      env: llamaEnv(path.dirname(bin)),
    })
    return undefined
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Verify the runtime executes. A missing OpenMP runtime is repaired without
 * root by fetching the library from the distro mirror into the archive
 * directory, where `llamaEnv` points the loader.
 *
 * Anything else throws; the caller's backoff reports one actionable error
 * and retries later, so a manual install is picked up without a restart.
 */
async function ensureRuntimeRuns(bin: string): Promise<void> {
  const failure = await runFailure(bin)
  if (failure === undefined) return
  const dir = path.dirname(bin)
  if (failure.includes(OPENMP_SONAME) && process.platform === 'linux') {
    try {
      await vendorOpenMpRuntime(dir)
      if (await runFailure(bin) === undefined) {
        serverLog(`[titles] vendored ${OPENMP_SONAME} into ${dir} (host has no OpenMP runtime)`)
        return
      }
    } catch {
      // No apt, or a stale index: fall through to the error below.
    }
    throw new Error(
      `llama.cpp cannot load ${OPENMP_SONAME} and it could not be fetched automatically. `
      + 'Install the OpenMP runtime: "sudo apt install libgomp1" (Debian/Ubuntu) '
      + 'or "sudo dnf install libgomp" (Fedora/RHEL).',
    )
  }
  throw new Error(`llama.cpp at ${bin} does not run: ${failure}`)
}

/**
 * Fetch `libgomp1` from the distro mirror and copy the shared object into
 * `dir`. `apt-get download` needs no privileges (it writes the .deb to the
 * cwd, hence the scratch dir), and `cp` dereferences the package's
 * `libgomp.so.1 -> libgomp.so.1.0.0` symlink so the copy is a real file.
 */
async function vendorOpenMpRuntime(dir: string): Promise<void> {
  const tmp = `${dir}.openmp.tmp`
  await execFileAsync('sh', ['-c',
    `rm -rf '${tmp}' && mkdir -p '${tmp}' && cd '${tmp}' `
    + '&& apt-get download libgomp1 && dpkg-deb -x ./*.deb x '
    + `&& cp x/usr/lib/*/${OPENMP_SONAME}* '${dir}/' && rm -rf '${tmp}'`,
  ], { timeout: 120_000 })
}

/**
 * Ensure a GGUF model is present under the server-local `<dataDir>/models`,
 * downloading it once (tmp + rename, so a torn download is never used).
 */
export async function ensureGgufModel(url: string, filename: string): Promise<string> {
  const modelsDir = serverLocalPath('models')
  const target = path.join(modelsDir, filename)
  if (await fileExists(target)) return target

  await execFileAsync('sh', ['-c',
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
): Promise<string> {
  const { stdout } = await execFileAsync(bin, [
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
    env: llamaEnv(path.dirname(bin)),
  })
  return stdout.replace(/\[end of text\]\s*$/, '').trim()
}
