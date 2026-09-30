import { exec, execFile, type ExecFileOptions } from 'node:child_process'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
// Used as the install's identity, not for storage (see dataDirHash).
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { getDataDir } from '@yaac/shared/paths'
import { testEnv } from '@yaac/shared/env'

/**
 * Output a child may buffer. Node's 1 MiB default is too small for a large
 * `-o json` listing or an exec'd `cat`, and overrunning it fails the call.
 */
const MAX_EXEC_BUFFER = 64 << 20

const execFileRaw = promisify(execFile)
const execAsync = promisify(exec)

/** Promisified `execFile` with {@link MAX_EXEC_BUFFER} as the default. */
export function execFileAsync(
  file: string,
  args: readonly string[],
  opts: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileRaw(file, args, { maxBuffer: MAX_EXEC_BUFFER, ...opts, encoding: 'utf8' })
}

/**
 * Namespace that holds every yaac Kubernetes object. Tests override it with
 * `YAAC_K8S_NAMESPACE` to isolate each run (packages/test-utils/src/setup.ts).
 */
export function k8sNamespace(): string {
  return testEnv.k8sNamespace
}

/**
 * Hash of the data dir, used as a label value to scope queries to this
 * install (label values cannot contain `/`). Hashes the install root rather
 * than a storage tier so it stays stable if storage locations change.
 */
export function dataDirHash(): string {
  return crypto.createHash('sha256').update(getDataDir()).digest('hex').slice(0, 16)
}

/**
 * Stderr patterns for transient kubectl / API-server failures (apiserver
 * restarts, etcd hiccups, connection races) that are worth retrying.
 */
const TRANSIENT_KUBECTL_PATTERNS = [
  'connection refused',
  'econnrefused',
  'econnreset',
  'tls handshake timeout',
  'i/o timeout',
  'context deadline exceeded',
  'etcdserver: request timed out',
  'etcdserver: leader changed',
  'the server is currently unable to handle the request',
  'temporarily unavailable',
  'too many requests',
  'error dialing backend',
  // `kubectl exec job/<name>` briefly fails with this while the pod starts.
  'unable to upgrade connection',
]

export function isTransientKubectlError(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return TRANSIENT_KUBECTL_PATTERNS.some((p) => lower.includes(p))
}

/** True when kubectl stderr indicates the target object does not exist. */
export function isNotFoundKubectlError(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return lower.includes('(notfound)') || lower.includes('not found')
}

/**
 * True when kubectl says the object, or its whole resource type, does not
 * exist (e.g. a Calico CRD on a provider-managed cluster), as opposed to
 * failing to ask. Callers such as the `--byo` gates treat absence as a
 * fact, so an RBAC denial or timeout must not count as absence. Takes the
 * whole error because execFile puts some failures only in `message`.
 */
export function isKubectlAbsentError(err: unknown): boolean {
  const text = [
    (err as { stderr?: string })?.stderr ?? '',
    err instanceof Error ? err.message : String(err),
  ].join(' ')

  // A broken webhook fails with e.g. `failed calling webhook …: service
  // "calico-apiserver" not found`. That `not found` is about the webhook,
  // not the object, so rule it out before the patterns below.
  if (/failed calling webhook|internal error occurred/i.test(text)) return false

  // kubectl's messages for absence:
  //   Error from server (NotFound): daemonsets.apps "calico-node" not found
  //   error: the server doesn't have a resource type "felixconfigurations"
  //   error: no matches for kind "FelixConfiguration" in version "…"
  //   Error from server (NotFound): the server could not find the requested resource
  if (/\(notfound\)/i.test(text)) return true
  if (/"[^"]*"\s+not found/i.test(text)) return true
  const lower = text.toLowerCase()
  return lower.includes("the server doesn't have a resource type")
    || lower.includes('no matches for kind')
    || lower.includes('could not find the requested resource')
}

/**
 * The one line of a kubectl failure worth showing a user. kubectl prints
 * klog retry noise (`E0806 12:00:00.000000 1234 memcache.go:265] ...`)
 * before its own diagnosis, so klog lines are skipped.
 */
export function kubectlErrorSummary(err: unknown): string {
  const raw = [
    (err as { stderr?: string })?.stderr ?? '',
    err instanceof Error ? err.message : String(err),
  ].join('\n')
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  const klog = /^[EIWF]\d{4}\s/
  const best = lines.find((l) => !klog.test(l) && !l.startsWith('Command failed:'))
    ?? lines.find((l) => !klog.test(l))
    ?? lines[0]
    ?? 'unknown error'
  return best.length > 140 ? `${best.slice(0, 140)}…` : best
}

export interface KubectlExecOptions {
  timeout?: number
  maxAttempts?: number
  /** Base delay in ms; each attempt doubles up to 3200ms. */
  baseDelay?: number
  /** Data piped to kubectl stdin (e.g. `apply -f -` manifests). */
  input?: string
}

/**
 * Retry `run` while `stderrOf(err)` looks transient, with exponential
 * backoff capped at 3200ms. Other failures, and the last attempt, rethrow
 * the original error.
 */
export async function retryTransient<T>(
  run: () => Promise<T>,
  opts: Pick<KubectlExecOptions, 'maxAttempts' | 'baseDelay'>,
  stderrOf: (err: unknown) => string,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5
  const baseDelay = opts.baseDelay ?? 200

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run()
    } catch (err: unknown) {
      if (attempt < maxAttempts && isTransientKubectlError(stderrOf(err))) {
        const delay = Math.min(baseDelay * 2 ** (attempt - 1), 3200)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw new Error('retryTransient: unexpected fall-through')
}

/**
 * Run `kubectl` with retries on transient API-server errors. Callers pass
 * `-n <namespace>` themselves, so cluster-scoped calls work too.
 */
export async function kubectlWithRetry(
  args: string[],
  opts: KubectlExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return retryTransient(
    () => opts.input !== undefined
      ? execFileWithInput('kubectl', args, opts.input, opts.timeout)
      : execFileAsync('kubectl', args, { timeout: opts.timeout }),
    opts,
    (err) => (err as { stderr?: string })?.stderr ?? '',
  )
}

function execFileWithInput(
  bin: string,
  args: string[],
  input: string,
  timeout?: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { maxBuffer: MAX_EXEC_BUFFER, timeout },
      (err, stdout, stderr) => {
        if (err instanceof Error) {
          reject(Object.assign(err, { stdout, stderr }))
        } else {
          resolve({ stdout, stderr })
        }
      },
    )
    // Writing to a dead child's stdin raises EPIPE, and an unhandled stream
    // error would crash the server (e.g. during shutdown, which kills these
    // children mid-write). The exec callback already reports the failure.
    child.stdin?.on('error', () => { /* reported via the exec callback */ })
    child.stdin?.end(input)
  })
}

/**
 * Like `kubectlWithRetry`, but takes a full shell command string for
 * callers that rely on shell quoting.
 */
export async function shellKubectlWithRetry(
  command: string,
  opts: KubectlExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return retryTransient(
    async () => {
      const res = await execAsync(command, { maxBuffer: MAX_EXEC_BUFFER, timeout: opts.timeout })
      return { stdout: res.stdout.toString(), stderr: res.stderr.toString() }
    },
    opts,
    (err) => ((err as { stderr?: Buffer | string })?.stderr ?? '').toString()
      + ((err as Error)?.message ?? ''),
  )
}

/** `kubectl ... -o json`, parsed; null when the object does not exist. */
export async function kubectlGetJson<T>(args: string[], opts: KubectlExecOptions = {}): Promise<T | null> {
  try {
    const { stdout } = await kubectlWithRetry([...args, '-o', 'json'], opts)
    return JSON.parse(stdout) as T
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? ''
    if (isNotFoundKubectlError(stderr)) return null
    throw err
  }
}

/** `kubectl apply -f -` with the manifest piped on stdin. */
export async function kubectlApply(manifest: object, opts: KubectlExecOptions = {}): Promise<void> {
  await kubectlWithRetry(['apply', '-f', '-'], { ...opts, input: JSON.stringify(manifest) })
}

/**
 * Verify the cluster API server answers. Throws with install/start
 * instructions when kubectl is missing or the cluster is unreachable.
 */
export async function ensureKubernetes(): Promise<void> {
  try {
    await kubectlWithRetry(['version', '--output', 'json'], { timeout: 10_000, maxAttempts: 2 })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      'Kubernetes cluster is not reachable. yaac needs kubectl pointed at a '
      + 'local single-node cluster (e.g. kind). Run "yaac cluster check" for '
      + `setup instructions.\n${detail}`,
    )
  }
}
