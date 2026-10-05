import { execFile, type ExecFileOptions } from 'node:child_process'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { ApiException, HttpMethod, PatchStrategy, type KubernetesObject } from '@kubernetes/client-node'
// Used as the install's identity, not for storage (see dataDirHash).
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { getDataDir } from '@yaac/shared/paths'
import { testEnv } from '@yaac/shared/env'
import { getObjectApi, getVersionApi } from './client'

/**
 * Object reads and writes against the API server, for any kind, as raw
 * JSON (see `ObjectClient`). Failures are client-node's typed
 * `ApiException`s; only transient ones are retried, inside the client.
 */

/**
 * Output a child may buffer. Node's 1 MiB default is too small for an
 * exec'd `cat`, and overrunning it fails the call.
 */
const MAX_EXEC_BUFFER = 64 << 20

const execFileRaw = promisify(execFile)

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

/** The field manager every yaac write is recorded under. */
const FIELD_MANAGER = 'yaac'

/** Names one object. `namespace` is omitted for cluster-scoped kinds. */
export interface ObjectRef {
  apiVersion: string
  kind: string
  name: string
  namespace?: string
}

function header(ref: ObjectRef): KubernetesObject {
  return {
    apiVersion: ref.apiVersion,
    kind: ref.kind,
    metadata: { name: ref.name, ...(ref.namespace ? { namespace: ref.namespace } : {}) },
  }
}

/**
 * Server-side apply `manifest` as yaac's field manager, forcing ownership
 * of any field it sends. A field yaac stops sending is removed only if
 * yaac's apply owned it: a field first set by client-side `kubectl apply`
 * or by a merge patch stays. An atomic list (e.g. a NetworkPolicy's
 * `spec.ingress`) is replaced whole.
 */
export async function applyObject(manifest: object): Promise<void> {
  const apply = async () => await getObjectApi().send(HttpMethod.PATCH, manifest, 'read', {
    query: { fieldManager: FIELD_MANAGER, force: 'true' },
    body: manifest,
    contentType: PatchStrategy.ServerSideApply,
  }) as AppliedObject
  if (await adoptClientSideFields(manifest, await apply())) await apply()
}

/** The parts of an applied object `adoptClientSideFields` reads. */
interface AppliedObject {
  metadata?: {
    annotations?: Record<string, string>
    managedFields?: Array<{ manager?: string; operation?: string; fieldsV1?: object }>
  }
}

const CLIENT_SIDE_MANAGER = 'kubectl-client-side-apply'
const LAST_APPLIED_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration'

/**
 * Hand the fields an older install's client-side `kubectl apply` owns to
 * yaac's apply, so a field yaac no longer sends is pruned instead of
 * staying co-owned forever, and drop the stale last-applied annotation
 * (on a Secret, a frozen copy of old data). This is what
 * `kubectl apply --server-side` does when it migrates an object. True when
 * it rewrote anything, so the caller re-applies to prune now.
 * docs/legacy-compat-shims.md.
 */
async function adoptClientSideFields(spec: KubernetesObject, applied: AppliedObject): Promise<boolean> {
  const entries = applied.metadata?.managedFields ?? []
  const legacy = entries.find((e) => e.manager === CLIENT_SIDE_MANAGER)
  if (!legacy) return false
  const ours = entries.find((e) => e.manager === FIELD_MANAGER && e.operation === 'Apply')
  const merged = ours
    ? entries
      .filter((e) => e !== legacy)
      .map((e) => (e === ours ? { ...e, fieldsV1: mergeFields(e.fieldsV1 ?? {}, legacy.fieldsV1 ?? {}) } : e))
    : entries.map((e) => (e === legacy ? { ...e, manager: FIELD_MANAGER, operation: 'Apply' } : e))
  const ops: object[] = [{ op: 'replace', path: '/metadata/managedFields', value: merged }]
  if (applied.metadata?.annotations?.[LAST_APPLIED_ANNOTATION] !== undefined) {
    ops.push({ op: 'remove', path: `/metadata/annotations/${LAST_APPLIED_ANNOTATION.replace('/', '~1')}` })
  }
  await getObjectApi().send(HttpMethod.PATCH, spec, 'read', { body: ops, contentType: PatchStrategy.JsonPatch })
  return true
}

/** Union of two managedFields field sets (nested `f:`/`k:` key trees). */
function mergeFields(a: object, b: object): object {
  const out: Record<string, object> = { ...(a as Record<string, object>) }
  for (const [k, v] of Object.entries(b as Record<string, object>)) out[k] = k in out ? mergeFields(out[k], v) : v
  return out
}

/** Create `manifest`; fails with 409 if the object exists. */
export async function createObject(manifest: object): Promise<void> {
  await getObjectApi().send(HttpMethod.POST, manifest, 'create', {
    query: { fieldManager: FIELD_MANAGER },
    body: manifest,
  })
}

/** The object, or null when it, or its whole resource type, does not exist. */
export async function readObject<T = KubernetesObject>(ref: ObjectRef): Promise<T | null> {
  try {
    return await getObjectApi().send(HttpMethod.GET, header(ref), 'read') as T
  } catch (err) {
    if (isAbsent(err)) return null
    throw err
  }
}

/** Objects of a kind, in one namespace or (omitted) the whole cluster. */
export async function listObjects<T = KubernetesObject>(
  apiVersion: string,
  kind: string,
  opts: { namespace?: string; labelSelector?: string; fieldSelector?: string } = {},
): Promise<T[]> {
  const list = await getObjectApi().send(HttpMethod.GET, {
    apiVersion, kind, metadata: opts.namespace ? { namespace: opts.namespace } : {},
  }, 'list', {
    query: {
      ...(opts.labelSelector ? { labelSelector: opts.labelSelector } : {}),
      ...(opts.fieldSelector ? { fieldSelector: opts.fieldSelector } : {}),
    },
  }) as { items?: T[] }
  return list.items ?? []
}

/** JSON merge patch (RFC 7386): a `null` value deletes the field. */
export async function patchObject(ref: ObjectRef, patch: { metadata?: object; [key: string]: unknown }): Promise<void> {
  await getObjectApi().send(HttpMethod.PATCH, header(ref), 'read', {
    query: { fieldManager: FIELD_MANAGER },
    body: patch,
    contentType: PatchStrategy.MergePatch,
  })
}

/**
 * Delete the object; absent is success. With `wait`, resolve only once it
 * is gone (finalizers run, pods terminated), so its name can be reused.
 */
export async function deleteObject(
  ref: ObjectRef,
  opts: { wait?: boolean; timeoutMs?: number; gracePeriodSeconds?: number } = {},
): Promise<void> {
  try {
    await getObjectApi().send(HttpMethod.DELETE, header(ref), 'read', {
      body: {
        propagationPolicy: 'Background',
        ...(opts.gracePeriodSeconds !== undefined ? { gracePeriodSeconds: opts.gracePeriodSeconds } : {}),
      },
    })
  } catch (err) {
    if (isAbsent(err)) return
    throw err
  }
  if (!opts.wait) return
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
  while (await readObject(ref)) {
    if (Date.now() > deadline) {
      throw new Error(
        `${ref.kind} ${ref.name} is still being deleted after ${String((opts.timeoutMs ?? 120_000) / 1000)}s; `
        + 'a finalizer may be holding it',
      )
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** Delete every object of a kind matching `labelSelector`. */
export async function deleteObjects(
  apiVersion: string,
  kind: string,
  opts: { namespace?: string; labelSelector: string; wait?: boolean },
): Promise<void> {
  const items = await listObjects(apiVersion, kind, opts)
  await Promise.all(items.map((item) => deleteObject({
    apiVersion,
    kind,
    name: item.metadata?.name ?? '',
    namespace: item.metadata?.namespace,
  }, { wait: opts.wait })))
}

/** The API server's HTTP status for a failed call, if it answered. */
export function apiStatus(err: unknown): number | undefined {
  return err instanceof ApiException ? err.code : undefined
}

/**
 * True when the object, or its whole resource type, does not exist (e.g. a
 * Calico CRD on a provider-managed cluster), as opposed to failing to ask.
 * Callers such as the `--byo` gates treat absence as a fact, so an RBAC
 * denial (403) or a broken webhook (500) does not count. client-node
 * reports a kind missing from a group it could discover as a plain Error.
 */
export function isAbsent(err: unknown): boolean {
  return apiStatus(err) === 404
    || (err instanceof Error && err.message.startsWith('Unrecognized API version and kind'))
}

/** The one line of an API failure worth showing a user. A network failure
 *  is a bare `fetch failed` whose cause says what went wrong; a refused
 *  connection to every address of a hostname is an AggregateError with an
 *  empty message, so its code stands in. */
export function k8sErrorSummary(err: unknown): string {
  let line = err instanceof Error ? err.message : String(err)
  if (err instanceof Error && err.cause instanceof Error) {
    line += `: ${err.cause.message || String((err.cause as { code?: unknown }).code)}`
  }
  if (err instanceof ApiException) {
    const body = (typeof err.body === 'string' ? safeJson(err.body) : err.body) as { message?: string } | undefined
    line = `${String(err.code)}: ${body?.message ?? 'no message'}`
  }
  line = line.split('\n')[0] ?? line
  return line.length > 140 ? `${line.slice(0, 140)}…` : line
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

/**
 * Verify the cluster API server answers. Throws with setup instructions
 * when the kubeconfig is missing or the cluster is unreachable.
 */
export async function ensureKubernetes(): Promise<void> {
  try {
    await getVersionApi().getCode()
  } catch (err) {
    throw new Error(
      'Kubernetes cluster is not reachable. yaac needs a kubeconfig pointed at a '
      + 'local single-node cluster (e.g. kind). Run "yaac cluster check" for '
      + `setup instructions.\n${k8sErrorSummary(err)}`,
    )
  }
}
