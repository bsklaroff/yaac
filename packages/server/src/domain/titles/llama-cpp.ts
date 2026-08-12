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
 *
 * Extraction is followed by a smoke check, because "the file is there" and
 * "the file runs" are different questions here: the archive's binaries link
 * against the system OpenMP runtime, which it does not bundle. A host
 * without it downloads and extracts perfectly and then fails every single
 * inference — so the check runs once per setup and turns that into one loud,
 * backed-off setup error instead of a silent per-session failure forever.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileAsync } from '#lib/shell'
import { serverLog } from '#log'
import { serverLocalPath } from '@yaac/shared/paths'

/** Pinned llama.cpp release tag; CPU archives exist for linux/macOS × x64/arm64. */
export const LLAMA_CPP_TAG = 'b9940'

/** The one system library the ubuntu CPU archive links against but does not
 *  ship. Absent, the loader kills every binary in the release before `main`. */
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
 * Ensure the pinned llama.cpp release is present AND runnable, downloading
 * it once (~10-16MB from github.com). Returns the `llama-completion` binary
 * path. The archive's shared libraries live beside the binaries, so the whole
 * extracted directory is kept. Extraction goes through a tmp dir with a
 * final rename, so a torn download never half-populates the target.
 *
 * Throws when the runtime cannot be made to run, so setup failure is one
 * loud, backed-off error rather than an inference failure per session.
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
 * Loader environment for the release: its shared libraries sit beside the
 * binaries instead of on the system search path, so every invocation has to
 * point the loader at that directory (LD_ on linux, DYLD_ on macOS).
 */
function llamaEnv(dir: string): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-process-env -- env forwarded wholesale to the subprocess, adding the loader path for the archive's bundled shared libs
  return { ...process.env, LD_LIBRARY_PATH: dir, DYLD_LIBRARY_PATH: dir }
}

/** Run the cheapest thing the binary can do. `undefined` means it loads;
 *  otherwise the loader/runtime failure, which names the missing library. */
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
 * Verify the extracted runtime actually executes, repairing the one failure
 * that is fixable without root: a host missing the OpenMP runtime. The
 * library is fetched from the distro's own mirror and dropped beside the
 * archive's bundled `.so`s, where `llamaEnv` already points the loader — a
 * user-owned cache write, no `sudo` and no system state touched.
 *
 * Anything else (or a host with no apt) throws, which is the point: the
 * caller's backoff then reports one actionable setup error and retries
 * later, so a manual install is picked up without a server restart.
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
      // Fall through to the actionable error below — a host without apt, or
      // an index too stale to resolve the package, is not recoverable here.
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
 * Ensure a GGUF model is present under `<dataDir>/models`, downloading it
 * once (tmp + rename, so a torn download is never mistaken for a model).
 * SERVER-LOCAL: the title model is loaded by the server's own llama.cpp.
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
