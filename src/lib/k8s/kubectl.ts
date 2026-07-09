import { exec, execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { getDataDir } from '@/shared/paths'
import { testEnv } from '@/shared/env'

export const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

/**
 * Namespace that holds every yaac kubernetes object (session Jobs, the
 * proxy Deployment/Service, the CA ConfigMap, the auth Secret).
 * `YAAC_K8S_NAMESPACE` is a test-only hook so e2e runs can isolate their
 * objects in per-test-file namespaces (see TEST_NAMESPACE in
 * test/helpers/setup.ts).
 */
export function k8sNamespace(): string {
  return testEnv.k8sNamespace
}

/**
 * Hash of the data dir used as a label value. Kubernetes label values
 * cannot contain `/`, so the raw path (today's `yaac.data-dir` podman
 * label) can't be carried over — the hash keeps the same property of
 * scoping queries to this yaac install while staying label-safe.
 */
export function dataDirHash(): string {
  return crypto.createHash('sha256').update(getDataDir()).digest('hex').slice(0, 16)
}

/**
 * Stderr patterns that indicate a transient kubectl / API-server failure
 * worth retrying. These are NOT "the object is actually gone" — they're
 * apiserver restarts, etcd hiccups, and connection races that usually
 * resolve on their own.
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
  // `kubectl exec job/<name>` resolves the job's pod first; during pod
  // startup/replacement the exec subresource briefly 404s with this even
  // though the pod is coming up.
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

export interface KubectlExecOptions {
  timeout?: number
  maxAttempts?: number
  /** Base delay in ms; each attempt doubles up to 3200ms. */
  baseDelay?: number
  /** Data piped to kubectl stdin (e.g. `apply -f -` manifests). */
  input?: string
}

/**
 * The shared attempt loop behind both kubectl runners: retry `run` while
 * `stderrOf(err)` matches a transient API-server error, backing off
 * `baseDelay * 2^(attempt-1)` capped at 3200ms. Non-transient failures
 * (and the final attempt) rethrow the original error.
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
 * Run `kubectl` with retries on transient API-server errors. Non-transient
 * failures throw immediately, preserving the original error. The `-n
 * <namespace>` flag is NOT added implicitly — callers pass it so that
 * cluster-scoped calls (namespaces, version) stay valid.
 */
export async function kubectlWithRetry(
  args: string[],
  opts: KubectlExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return retryTransient(
    () => opts.input !== undefined
      ? execFileWithInput('kubectl', args, opts.input, opts.timeout)
      : execFileAsync('kubectl', args, opts.timeout ? { timeout: opts.timeout } : {}),
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
      timeout ? { timeout } : {},
      (err, stdout, stderr) => {
        if (err instanceof Error) {
          reject(Object.assign(err, { stdout, stderr }))
        } else {
          resolve({ stdout, stderr })
        }
      },
    )
    child.stdin?.end(input)
  })
}

/**
 * Async kubectl exec with retries, matching `kubectlWithRetry`'s retry
 * behavior but accepting a full shell command string so callers that rely
 * on shell features (sh -c "...", single-quoted args) don't have to split
 * args manually. Runs in the Node event loop — does not block the daemon's
 * HTTP server.
 */
export async function shellKubectlWithRetry(
  command: string,
  opts: KubectlExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const execOpts: { timeout?: number } = opts.timeout ? { timeout: opts.timeout } : {}
  return retryTransient(
    async () => {
      const res = await execAsync(command, execOpts)
      return { stdout: res.stdout.toString(), stderr: res.stderr.toString() }
    },
    opts,
    (err) => ((err as { stderr?: Buffer | string })?.stderr ?? '').toString()
      + ((err as Error)?.message ?? ''),
  )
}

/**
 * `kubectl ... -o json` parsed. Returns null when the object is absent
 * instead of throwing, so callers can express "get if exists" without
 * try/catch noise.
 */
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

/**
 * `kubectl apply -f -` with a manifest object piped on stdin. Server-side
 * idempotent — the canonical "ensure this object exists with this spec".
 */
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
