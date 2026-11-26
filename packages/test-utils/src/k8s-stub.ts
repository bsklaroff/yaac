/**
 * Stand-in for `@kubernetes/client-node` in unit runs, with an in-memory
 * cluster behind the generic object client.
 *
 * The real package takes ~2.8s to import, and roughly half the
 * `unit:server` files reach it through the `#drivers/k8s/substrate` barrel.
 * Every object read and write the k8s driver makes goes through
 * `KubernetesObjectApi`, so this stub answers those from `fakeCluster`:
 * a test seeds the objects the code should find, runs it for real, and
 * asserts on what the code left in the cluster (or on `fakeCluster.calls`).
 * The setup file resets it before every test.
 *
 * The fake is deliberately simple: a server-side apply replaces the stored
 * object rather than merging field ownership, a strategic merge patch
 * merges lists of named objects by name and nothing else, and selectors
 * support the
 * forms yaac uses (`k=v`, `k!=v`, `k`, `!k`, `k in (…)`, and dotted-path
 * field selectors).
 *
 * Informers throw, and so does a watch unless the test sets
 * `fakeCluster.onWatch`, so a unit test that wants them fails loudly. A
 * file that needs the real client overrides this with
 * `vi.mock('@kubernetes/client-node', importOriginal)`.
 */

function unavailable(what: string): never {
  throw new Error(
    `${what} is stubbed in unit tests: this path wants a real apiserver. Seed `
    + '`fakeCluster` instead, or opt this file back into the real client with '
    + "vi.mock('@kubernetes/client-node', async (importOriginal) => …). See "
    + 'packages/test-utils/src/k8s-stub.ts.',
  )
}

/** client-node's error for a non-2xx answer; `instanceof` works against the stub. */
export class ApiException<T = unknown> extends Error {
  constructor(public code: number, message: string, public body: T, public headers: Record<string, string> = {}) {
    super(`HTTP-Code: ${String(code)}\nMessage: ${message}\nBody: ${JSON.stringify(body)}`)
  }
}

/** An ApiException as the API server would send it. */
export function apiError(code: number, message = `status ${String(code)}`): ApiException {
  return new ApiException(code, 'Unsuccessful HTTP Request', { kind: 'Status', code, message })
}

const PatchStrategy = {
  JsonPatch: 'application/json-patch+json',
  MergePatch: 'application/merge-patch+json',
  StrategicMergePatch: 'application/strategic-merge-patch+json',
  ServerSideApply: 'application/apply-patch+yaml',
} as const

export interface FakeObject {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    [key: string]: unknown
  }
  [key: string]: unknown
}

type Verb = 'apply' | 'create' | 'read' | 'list' | 'patch' | 'delete'

/** One request the code made, in order. `body` is the manifest or patch sent. */
export interface FakeCall {
  verb: Verb
  apiVersion: string
  kind: string
  name?: string
  namespace?: string
  body?: Record<string, unknown>
  labelSelector?: string
  fieldSelector?: string
  /** The subresource a patch went to (`resize`, `status`). */
  subresource?: string
}

const clone = <T>(v: T): T => structuredClone(v)

function keyOf(kind: string, name: string, namespace?: string): string {
  return `${kind}|${namespace ?? ''}|${name}`
}

function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch)
  const out: Record<string, unknown> = target && typeof target === 'object' && !Array.isArray(target)
    ? { ...(target as Record<string, unknown>) }
    : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else out[k] = mergePatch(out[k], v)
  }
  return out
}

/** A merge patch, except that a list whose items all carry a `name` merges
 *  into the stored list item by item, as Kubernetes merges `containers`. */
function strategicMerge(target: unknown, patch: unknown): unknown {
  const named = (v: unknown): v is Array<{ name: string }> => Array.isArray(v) && v.length > 0
    && v.every((i) => i !== null && typeof i === 'object' && typeof (i as { name?: unknown }).name === 'string')
  if (named(patch) && named(target)) {
    const out = target.map((item) => {
      const change = patch.find((p) => p.name === item.name)
      return change === undefined ? clone(item) : strategicMerge(item, change)
    })
    return [...out, ...patch.filter((p) => !target.some((t) => t.name === p.name)).map(clone)]
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch)
  const out: Record<string, unknown> = target && typeof target === 'object' && !Array.isArray(target)
    ? { ...(target as Record<string, unknown>) }
    : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else out[k] = strategicMerge(out[k], v)
  }
  return out
}

/**
 * Apply a JSON patch (RFC 6902) of `test` and `remove` operations, the two
 * the code sends. A failed `test`, or a path that is not there, is the API
 * server's 422.
 */
function jsonPatch(target: FakeObject, ops: Array<{ op: string; path: string; value?: unknown }>): FakeObject {
  const out = clone(target)
  for (const { op, path, value } of ops) {
    const keys = path.split('/').slice(1).map((k) => k.replaceAll('~1', '/').replaceAll('~0', '~'))
    const last = keys.pop() ?? ''
    let parent: unknown = out
    for (const k of keys) parent = (parent as Record<string, unknown> | undefined)?.[k]
    const holder = parent !== null && typeof parent === 'object' ? parent as Record<string, unknown> : {}
    if (!(last in holder)) throw apiError(422, `the server rejected our request: no value at ${path}`)
    if (op === 'test') {
      if (JSON.stringify(holder[last]) !== JSON.stringify(value)) {
        throw apiError(422, `the server rejected our request: test failed at ${path}`)
      }
    } else if (op === 'remove') {
      delete holder[last]
    } else {
      unavailable(`a JSON patch "${op}"`)
    }
  }
  return out
}

function matchesLabels(labels: Record<string, string>, selector: string): boolean {
  const terms = selector.match(/[^,(]+(\([^)]*\))?/g) ?? []
  return terms.map((t) => t.trim()).filter(Boolean).every((term) => {
    const set = /^(\S+)\s+(in|notin)\s+\(([^)]*)\)$/.exec(term)
    if (set) {
      const values = set[3].split(',').map((v) => v.trim())
      const has = set[1] in labels && values.includes(labels[set[1]])
      return set[2] === 'in' ? has : !has
    }
    const ne = /^([^!=]+)!=(.*)$/.exec(term)
    if (ne) return labels[ne[1]] !== ne[2]
    const eq = /^([^!=]+)==?(.*)$/.exec(term)
    if (eq) return labels[eq[1]] === eq[2]
    if (term.startsWith('!')) return !(term.slice(1) in labels)
    return term in labels
  })
}

function matchesFields(obj: FakeObject, selector: string): boolean {
  return selector.split(',').every((term) => {
    const [, path, op, want] = /^([^!=]+)(!=|==?)(.*)$/.exec(term.trim()) ?? []
    let v: unknown = obj
    for (const part of path.split('.')) v = (v as Record<string, unknown> | undefined)?.[part]
    const got = typeof v === 'string' ? v : JSON.stringify(v) ?? ''
    return op === '!=' ? got !== want : got === want
  })
}

/** The in-memory cluster the stubbed object client reads and writes. */
class FakeCluster {
  private store = new Map<string, FakeObject>()
  private interceptors: Array<(call: FakeCall) => unknown> = []
  private holds: Array<{ match: (req: { method: string; path: string }) => boolean; released: Promise<void> }> = []
  private missingKinds = new Set<string>()
  private nextUid = 1
  calls: FakeCall[] = []
  /** Logs `readNamespacedPodLog` returns, by pod name. */
  podLogs = new Map<string, string>()
  /**
   * Answers to GETs of paths that are not objects (a node's Summary, by its
   * node-proxy path), by path. An `ApiException` answer fails the request.
   */
  paths = new Map<string, unknown>()
  /** Every such GET, as `path?query`. */
  pathGets: string[] = []
  /** When set, the version probe (`ensureKubernetes`) fails with it. */
  unreachable: Error | null = null
  /** What `KubeConfig.getCurrentContext()` answers. */
  kubeContext: string | undefined = 'kind-yaac'
  /** When set, `KubeConfig.loadFromDefault()` fails with it, as for a malformed file. */
  kubeconfigError: Error | null = null
  /** When set, answers `Watch.watch` (path, query, event callback). */
  onWatch: ((path: string, query: Record<string, unknown>, onEvent: (type: string, obj: unknown) => void)
    => { abort: () => void }) | null = null

  reset(): void {
    this.store.clear()
    this.interceptors = []
    this.holds = []
    this.missingKinds.clear()
    this.calls = []
    this.podLogs.clear()
    this.paths.clear()
    this.pathGets = []
    this.unreachable = null
    this.kubeContext = 'kind-yaac'
    this.kubeconfigError = null
    this.onWatch = null
    this.nextUid = 1
  }

  /** Put objects in the cluster without recording a call. */
  seed(...objects: Array<Omit<FakeObject, 'metadata'> & { metadata: Partial<FakeObject['metadata']> & { name: string } }>): void {
    for (const obj of objects) this.put(clone(obj) as FakeObject)
  }

  /** Take an object out of the cluster without recording a call, as
   *  something outside the code under test would (a pod evicted). */
  remove(kind: string, name: string, namespace?: string): void {
    this.store.delete(keyOf(kind, name, namespace))
  }

  /** The stored object of `kind` named `name`, if any. */
  get<T = FakeObject>(kind: string, name: string, namespace?: string): T | undefined {
    const hit = namespace !== undefined
      ? this.store.get(keyOf(kind, name, namespace))
      : [...this.store.values()].find((o) => o.kind === kind && o.metadata.name === name)
    return hit ? clone(hit) as T : undefined
  }

  /** Every stored object, optionally of one kind. */
  objects<T = FakeObject>(kind?: string): T[] {
    return [...this.store.values()].filter((o) => !kind || o.kind === kind).map((o) => clone(o) as T)
  }

  /** The calls of one verb, optionally for one kind. */
  callsOf(verb: Verb, kind?: string): FakeCall[] {
    return this.calls.filter((c) => c.verb === verb && (!kind || c.kind === kind))
  }

  /**
   * Run `fn` before every request. Throwing fails the request (e.g.
   * `throw apiError(403)`); returning a value answers it with that value
   * (e.g. a list holding a malformed object). Either way nothing is stored.
   */
  intercept(fn: (call: FakeCall) => unknown): void {
    this.interceptors.push(fn)
  }

  /**
   * Hold back the requests `match` picks, by HTTP method and the stubbed
   * path (the target as JSON), until the returned function is called, as a
   * slow API server would: each is answered, and lands, only then.
   */
  hold(match: (req: { method: string; path: string }) => boolean): () => void {
    let release = (): void => {}
    this.holds.push({ match, released: new Promise((resolve) => { release = resolve }) })
    return release
  }

  /** @internal Settles once no hold keeps `req` back. */
  async heldBack(req: { method: string; path: string }): Promise<void> {
    await Promise.all(this.holds.filter((h) => h.match(req)).map((h) => h.released))
  }

  /** Make a kind behave as if its API group is not installed (404 on every call). */
  removeKind(kind: string): void {
    this.missingKinds.add(kind)
  }

  private put(obj: FakeObject): void {
    const old = this.store.get(keyOf(obj.kind, obj.metadata.name, obj.metadata.namespace))
    obj.metadata.uid ??= old?.metadata.uid ?? `uid-${String(this.nextUid++)}`
    obj.metadata.creationTimestamp ??= old?.metadata.creationTimestamp ?? new Date().toISOString()
    this.store.set(keyOf(obj.kind, obj.metadata.name, obj.metadata.namespace), obj)
  }

  /** @internal Entry point for the object-client stub. */
  request(call: FakeCall): unknown {
    this.calls.push(clone(call))
    if (this.missingKinds.has(call.kind)) {
      throw apiError(404, 'the server could not find the requested resource')
    }
    for (const fn of this.interceptors) {
      const answer = fn(call)
      if (answer !== undefined) return clone(answer)
    }
    const key = call.name !== undefined ? keyOf(call.kind, call.name, call.namespace) : ''
    const existing = this.store.get(key)
    const notFound = (): never => {
      throw apiError(404, `${call.kind.toLowerCase()} "${call.name ?? ''}" not found`)
    }
    switch (call.verb) {
      case 'apply': {
        this.put(clone(call.body) as FakeObject)
        return clone(this.store.get(key))
      }
      case 'create': {
        if (existing) throw apiError(409, `${call.kind.toLowerCase()} "${call.name ?? ''}" already exists`)
        this.put(clone(call.body) as FakeObject)
        return clone(this.store.get(key))
      }
      case 'read':
        return existing ? clone(existing) : notFound()
      case 'patch': {
        if (!existing) return notFound()
        this.put(Array.isArray(call.body)
          ? jsonPatch(existing, call.body as Parameters<typeof jsonPatch>[1])
          : (call.subresource !== undefined ? strategicMerge : mergePatch)(existing, call.body) as FakeObject)
        return clone(this.store.get(key))
      }
      case 'delete':
        if (!existing) return notFound()
        this.store.delete(key)
        return { kind: 'Status', status: 'Success' }
      case 'list':
        return {
          apiVersion: call.apiVersion,
          kind: `${call.kind}List`,
          metadata: { resourceVersion: '1' },
          items: [...this.store.values()]
            .filter((o) => o.kind === call.kind)
            .filter((o) => call.namespace === undefined || o.metadata.namespace === call.namespace)
            .filter((o) => !call.labelSelector || matchesLabels(o.metadata.labels ?? {}, call.labelSelector))
            .filter((o) => !call.fieldSelector || matchesFields(o, call.fieldSelector))
            .map(clone),
        }
    }
  }
}

export const fakeCluster = new FakeCluster()

interface Spec {
  apiVersion: string
  kind: string
  metadata?: { name?: string; namespace?: string }
}

/** A request as client-node's HTTP layer would carry it. */
class FakeRequest {
  query: Record<string, string> = {}
  headers: Record<string, string> = {}
  body?: string
  constructor(public path: string, public method: string) {}
  setQueryParam(k: string, v: string): void { this.query[k] = v }
  setHeaderParam(k: string, v: string): void { this.headers[k] = v }
  setBody(body: string): void { this.body = body }
  setSignal(): void { /* nothing aborts an answer */ }
}

const response = (status: number, data: unknown, headers: Record<string, string> = {}) => ({
  httpStatusCode: status,
  headers,
  body: { text: () => Promise.resolve(data === undefined ? '' : JSON.stringify(data)) },
})

/**
 * Answer a request from `fakeCluster`. The stubbed `specUriPath` encodes
 * the target in the path, so no discovery is needed; an API error becomes
 * an HTTP error response, as the API server would send it.
 */
function respond(req: FakeRequest): ReturnType<typeof response> {
  // `ObjectClient.getPath` sends a real path; the stubbed `specUriPath` sends JSON.
  if (req.path.startsWith('/')) {
    const query = new URLSearchParams(req.query).toString()
    fakeCluster.pathGets.push(query ? `${req.path}?${query}` : req.path)
    const answer = fakeCluster.paths.get(req.path)
    if (answer instanceof ApiException) return response(answer.code, answer.body, answer.headers)
    return answer === undefined
      ? response(404, { kind: 'Status', code: 404, message: `no answer seeded for ${req.path}` })
      : response(200, answer)
  }
  // A subresource is appended to the object's path (`<json>/resize`).
  const end = req.path.lastIndexOf('}') + 1
  const subresource = req.path.slice(end + 1) || undefined
  const at = JSON.parse(req.path.slice(0, end)) as Pick<FakeCall, 'apiVersion' | 'kind' | 'name' | 'namespace'>
  const body = req.body === undefined ? undefined : JSON.parse(req.body) as Record<string, unknown>
  const contentType = req.headers['Content-Type']
  let call: FakeCall
  if (req.method === 'GET') {
    call = at.name !== undefined
      ? { verb: 'read', ...at }
      : {
          verb: 'list', ...at,
          ...(req.query.labelSelector ? { labelSelector: req.query.labelSelector } : {}),
          ...(req.query.fieldSelector ? { fieldSelector: req.query.fieldSelector } : {}),
        }
  } else if (req.method === 'POST') {
    call = { verb: 'create', ...at, name: (body?.metadata as { name?: string } | undefined)?.name, body }
  } else if (req.method === 'PATCH') {
    // A strategic merge patch only to a subresource (`resizePodCpu`).
    const strategic = contentType === PatchStrategy.StrategicMergePatch && subresource !== undefined
    if (contentType !== PatchStrategy.ServerSideApply && contentType !== PatchStrategy.MergePatch
      && contentType !== PatchStrategy.JsonPatch && !strategic) {
      unavailable(`a ${String(contentType)} patch`)
    }
    call = {
      verb: contentType === PatchStrategy.ServerSideApply ? 'apply' : 'patch', ...at, body,
      ...(subresource !== undefined ? { subresource } : {}),
    }
  } else {
    call = { verb: 'delete', ...at }
  }
  try {
    return response(200, fakeCluster.request(call))
  } catch (err) {
    if (err instanceof ApiException) return response(err.code, err.body, err.headers)
    throw err
  }
}

/** The parts of client-node's request configuration `ObjectClient` uses. */
const fakeConfiguration = {
  baseServer: { makeRequestContext: (path: string, method: string) => new FakeRequest(path, method) },
  authMethods: {},
  httpApi: {
    send: (req: FakeRequest) => ({ toPromise: () => fakeCluster.heldBack(req).then(() => respond(req)) }),
  },
}

/**
 * The generic object client's base class. Requests go through the fake
 * configuration above, whatever configuration the caller passes.
 */
class KubernetesObjectApiStub {
  protected configuration = fakeConfiguration
  static makeApiClient(): KubernetesObjectApiStub { return new KubernetesObjectApiStub() }
  protected setDefaultNamespace(): string { return 'default' }
  protected specUriPath(spec: Spec, action: string): Promise<string> {
    return Promise.resolve(JSON.stringify({
      apiVersion: spec.apiVersion,
      kind: spec.kind,
      ...(spec.metadata?.namespace ? { namespace: spec.metadata.namespace } : {}),
      ...(action === 'read' ? { name: spec.metadata?.name } : {}),
    }))
  }
}

class CoreV1ApiStub {
  readNamespacedPodLog(req: { name: string }): Promise<string> {
    return Promise.resolve(fakeCluster.podLogs.get(req.name) ?? '')
  }
}
class BatchV1ApiStub {}

class VersionApiStub {
  getCode(): Promise<{ gitVersion: string }> {
    return fakeCluster.unreachable ? Promise.reject(fakeCluster.unreachable) : Promise.resolve({ gitVersion: 'v1.33.0' })
  }
}

class KubeConfigStub {
  loadFromDefault(): void {
    // No kubeconfig is read: the stub is already "loaded", unless told to fail.
    if (fakeCluster.kubeconfigError) throw fakeCluster.kubeconfigError
  }
  makeApiClient<T>(Api: new () => T): T { return new Api() }
  getCurrentCluster(): never { return unavailable('KubeConfig.getCurrentCluster()') }
  getCurrentContext(): string | undefined { return fakeCluster.kubeContext }
  applyToHTTPSOptions(): never { return unavailable('KubeConfig.applyToHTTPSOptions()') }
}

class WatchStub {
  watch(
    path: string, query: Record<string, unknown>, onEvent: (type: string, obj: unknown) => void,
  ): Promise<{ abort: () => void }> {
    if (!fakeCluster.onWatch) unavailable('Watch.watch()')
    return Promise.resolve(fakeCluster.onWatch(path, query, onEvent))
  }
}

/**
 * The module shape `vi.mock` installs: the runtime values the server
 * imports from client-node.
 */
export function k8sClientStub(): Record<string, unknown> {
  return {
    ApiException,
    BatchV1Api: BatchV1ApiStub,
    HttpMethod: { GET: 'GET', POST: 'POST', PATCH: 'PATCH', DELETE: 'DELETE' },
    CoreV1Api: CoreV1ApiStub,
    KubeConfig: KubeConfigStub,
    KubernetesObjectApi: KubernetesObjectApiStub,
    PatchStrategy,
    VersionApi: VersionApiStub,
    Watch: WatchStub,
    makeInformer: () => unavailable('makeInformer()'),
  }
}
