/**
 * The proxy's live view of the objects it is told through, and its writes
 * to the ones it reports through (see objects.ts for the shapes).
 *
 * Three informers on the proxy's own in-cluster client feed `ProxyObjects`:
 * the credentials Secret, the per-project secrets Secrets and the
 * per-worktree registration ConfigMaps, each selected by its
 * `yaac.proxy-input` label. A replaced pod restores itself from the
 * informers' initial lists, so nothing here persists anything — the pod is
 * stateless by construction (docs/worktree-egress.md).
 *
 * Fail-closed is preserved: until every initial list has landed, `ready()`
 * is false and the readiness probe keeps the pod out of its Service, so no
 * worktree is ever served from an empty registration map.
 *
 * `ProxyObjects` is pure (maps and handlers over decoded objects) and
 * unit-tested with a fake informer; the wiring to the real client-node
 * informers is `startObjectWatch`, covered by e2e.
 */

import { makeInformer, PatchStrategy, setHeaderOptions, type KubernetesObject } from '@kubernetes/client-node'
import { inClusterClient, superviseInformer } from './pod-watch'
import {
  CA_SECRET_NAME,
  CREDENTIALS_SECRET_NAME,
  EMPTY_CREDENTIALS,
  LABEL_PROXY_INPUT,
  LABEL_WORKTREE_ID,
  REFRESHED_SECRET_NAME,
  STATE_CONFIGMAP_NAME,
  decodeCredentials,
  decodeProjectSecrets,
  decodeRegistration,
  type ClaudeOAuthBundle,
  type CodexOAuthBundle,
  type ProxyCredentials,
  type RawObject,
  type RefreshedBundles,
  type SshKeyEntry,
  type WorktreeRegistration,
} from './objects'

export interface ProxyObjectsDeps {
  /** Replace the ssh-agent's identities — the credentials handler's side
   *  effect, injected so the maps can be tested without an agent. */
  loadSshKeys: (entries: SshKeyEntry[]) => Promise<void>
  /** A worktree's registration changed (or went, on `null`): the listener
   *  prunes its blocked-host record against the new allowlist. */
  onRegistration?: (worktreeId: string, registration: WorktreeRegistration | null) => void
  log?: (message: string) => void
}

/** Whether `candidate` is a strictly fresher credential than `current`. */
function claudeIsNewer(candidate: ClaudeOAuthBundle, current: ClaudeOAuthBundle): boolean {
  return candidate.accessToken !== current.accessToken && candidate.expiresAt > current.expiresAt
}

function codexIsNewer(candidate: CodexOAuthBundle, current: CodexOAuthBundle): boolean {
  if (candidate.accessToken === current.accessToken) return false
  const a = Date.parse(candidate.lastRefresh)
  const b = Date.parse(current.lastRefresh)
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b
  return candidate.expiresAt > current.expiresAt
}

export class ProxyObjects {
  private creds: ProxyCredentials = EMPTY_CREDENTIALS
  /** `<projectSlug>/<NAME>` -> value, across every project's Secret. */
  private readonly secrets = new Map<string, string>()
  /** Which refs each secrets object contributed, so a delete or an update
   *  of one project's object forgets exactly that project's refs. */
  private readonly refsByObject = new Map<string, string[]>()
  private readonly registrations = new Map<string, WorktreeRegistration>()
  /** Object name -> worktree id, so a DELETE (which may arrive without
   *  data) still evicts the right registration. */
  private readonly worktreeByObject = new Map<string, string>()
  /**
   * OAuth bundles captured from a worktree's refresh and not yet echoed back
   * in the credentials Secret. Served in preference to the pushed bundle
   * while they are newer — a codex rotation is single-use, so serving the
   * pushed (spent) token in the window between capture and adoption would
   * sign the worktree out. Dropped the moment the pushed bundle catches up.
   */
  private captured: RefreshedBundles = {}
  /** The ssh set the agent was last loaded from, so a token-only rotation
   *  (or the adopt echo) does not empty and refill the agent under an
   *  in-flight ssh operation. */
  private loadedSsh: string | null = null
  private readonly seeded = new Set<string>()
  private readonly loadSshKeys: ProxyObjectsDeps['loadSshKeys']
  private readonly onRegistration: ProxyObjectsDeps['onRegistration']
  private readonly log: (message: string) => void

  constructor(deps: ProxyObjectsDeps) {
    this.loadSshKeys = deps.loadSshKeys
    this.onRegistration = deps.onRegistration
    this.log = deps.log ?? ((m) => { console.log(m) })
  }

  // ── Reads ──────────────────────────────────────────────────────────

  get credentials(): ProxyCredentials {
    return this.creds
  }

  /** The Claude OAuth bundle to swap in: a captured rotation while it is
   *  newer than what the server pushed, the pushed bundle otherwise. */
  claudeOAuthBundle(): ClaudeOAuthBundle | null {
    const pushed = this.creds.claude?.kind === 'oauth' ? this.creds.claude.bundle : null
    if (this.captured.claude && (!pushed || claudeIsNewer(this.captured.claude, pushed))) {
      return this.captured.claude
    }
    return pushed
  }

  codexOAuthBundle(): CodexOAuthBundle | null {
    const pushed = this.creds.codex?.kind === 'oauth' ? this.creds.codex.bundle : null
    if (this.captured.codex && (!pushed || codexIsNewer(this.captured.codex, pushed))) {
      return this.captured.codex
    }
    return pushed
  }

  secret(ref: string): string | undefined {
    return this.secrets.get(ref)
  }

  registration(worktreeId: string): WorktreeRegistration | undefined {
    return this.registrations.get(worktreeId)
  }

  registeredWorktreeIds(): string[] {
    return [...this.registrations.keys()]
  }

  /** Every initial list has landed — the pod may serve. */
  ready(): boolean {
    return (['credentials', 'secrets', 'registration'] as const).every((k) => this.seeded.has(k))
  }

  // ── Writes from the informers ──────────────────────────────────────

  markSeeded(kind: 'credentials' | 'secrets' | 'registration'): void {
    this.seeded.add(kind)
  }

  /**
   * The credentials Secret changed (or went, on `gone`): replace the whole
   * set — it is one install-wide thing — and reload the agent when the ssh
   * keys moved.
   *
   * By name as well as by label, on every verb: the label is what the
   * informer selects on, but only one object is the credentials Secret,
   * and the writer's invariant is worth holding on the reader too — a
   * stray labelled object must neither fill the set nor, on its deletion,
   * blank it.
   */
  applyCredentials(secret: RawObject, gone = false): Promise<void> {
    if (secret.metadata?.name !== CREDENTIALS_SECRET_NAME) {
      this.log(`[proxy] ignoring a credentials-labelled object that is not ${CREDENTIALS_SECRET_NAME}: ${secret.metadata?.name ?? '?'}`)
      return Promise.resolve()
    }
    this.creds = gone ? EMPTY_CREDENTIALS : decodeCredentials(secret)
    // The pushed bundle caught up with (or passed) a captured rotation: the
    // capture has been adopted and is no longer the newer of the two.
    const claude = this.creds.claude?.kind === 'oauth' ? this.creds.claude.bundle : null
    if (this.captured.claude && (!claude || !claudeIsNewer(this.captured.claude, claude))) {
      delete this.captured.claude
    }
    const codex = this.creds.codex?.kind === 'oauth' ? this.creds.codex.bundle : null
    if (this.captured.codex && (!codex || !codexIsNewer(this.captured.codex, codex))) {
      delete this.captured.codex
    }
    const authed = (['claude', 'codex', 'opencode', 'pi'] as const).filter((t) => this.creds[t] !== null)
    this.log(`[proxy] credentials: ${authed.length ? authed.join(', ') : 'no tools'} signed in, `
      + `${this.creds.git.length} git token(s), ${this.creds.ssh.length} ssh key(s)`)
    const ssh = JSON.stringify(this.creds.ssh)
    if (ssh === this.loadedSsh) return Promise.resolve()
    this.loadedSsh = ssh
    return this.loadSshKeys(this.creds.ssh).catch((err: unknown) => {
      // Next time the set changes it is loaded again; until then the agent
      // holds whatever the failed reload left.
      this.loadedSsh = null
      this.log(`[proxy] ssh-agent reload failed: ${String(err)}`)
    })
  }

  /** A project's secrets Secret changed or went. */
  applyProjectSecrets(secret: RawObject, gone = false): void {
    const name = secret.metadata?.name
    if (!name) return
    for (const ref of this.refsByObject.get(name) ?? []) this.secrets.delete(ref)
    this.refsByObject.delete(name)
    if (gone) return
    const values = decodeProjectSecrets(secret)
    for (const [ref, value] of Object.entries(values)) this.secrets.set(ref, value)
    this.refsByObject.set(name, Object.keys(values))
    this.log(`[proxy] secrets: ${Object.keys(values).length} value(s) from ${name}`)
  }

  /** A registration ConfigMap changed or went. */
  applyRegistration(cm: RawObject, gone = false): void {
    const name = cm.metadata?.name
    if (!name) return
    const previous = this.worktreeByObject.get(name)
    const decoded = gone ? null : decodeRegistration(cm)
    if (previous !== undefined && previous !== decoded?.worktreeId) {
      this.registrations.delete(previous)
      this.worktreeByObject.delete(name)
      this.onRegistration?.(previous, null)
      this.log(`[proxy] deregistered worktree ${previous.slice(0, 8)}...`)
    }
    if (!decoded) {
      if (!gone) this.log(`[proxy] ignoring malformed registration ${name}`)
      return
    }
    const { worktreeId, registration } = decoded
    const isNew = !this.registrations.has(worktreeId)
    this.registrations.set(worktreeId, registration)
    this.worktreeByObject.set(name, worktreeId)
    this.onRegistration?.(worktreeId, registration)
    if (isNew) {
      const redirects = Object.keys(registration.upstreamRedirects ?? {}).length
      this.log(`[proxy] registered worktree ${worktreeId.slice(0, 8)}... `
        + `(${registration.rules.length} rules, ${registration.allowedHosts.length} allowed host patterns`
        + `${redirects > 0 ? `, ${redirects} upstream redirects` : ''})`)
    }
  }

  /** A rotation this proxy just captured from a worktree's refresh. */
  capture(bundles: RefreshedBundles): void {
    this.captured = { ...this.captured, ...bundles }
  }
}

// ── Informer wiring (in-cluster only) ─────────────────────────────────

type Client = ReturnType<typeof inClusterClient>

function selector(input: 'credentials' | 'secrets' | 'registration'): string {
  return `${LABEL_PROXY_INPUT}=${input}`
}

/**
 * Feed `objects` from three informers for the proxy's lifetime. Each
 * informer's own (re)list diffs against its store and emits `delete` for
 * anything that vanished while it was disconnected, so the maps cannot
 * accumulate ghosts.
 */
export function startObjectWatch(objects: ProxyObjects, client: Client = inClusterClient()): void {
  const ns = client.namespace
  const secretsPath = `/api/v1/namespaces/${ns}/secrets`
  const configMapsPath = `/api/v1/namespaces/${ns}/configmaps`

  // client-node applies labelSelector to the WATCH only, so each list must
  // carry it too or the seed would pull in every object in the namespace.
  const credentials = makeInformer(
    client.kubeConfig, secretsPath,
    () => client.core.listNamespacedSecret({ namespace: ns, labelSelector: selector('credentials') }),
    selector('credentials'),
  )
  const feedCredentials = (obj: KubernetesObject): void => { void objects.applyCredentials(obj as RawObject) }
  credentials.on('add', feedCredentials)
  credentials.on('update', feedCredentials)
  credentials.on('delete', (obj) => { void objects.applyCredentials(obj as RawObject, true) })

  const secrets = makeInformer(
    client.kubeConfig, secretsPath,
    () => client.core.listNamespacedSecret({ namespace: ns, labelSelector: selector('secrets') }),
    selector('secrets'),
  )
  secrets.on('add', (obj) => { objects.applyProjectSecrets(obj as RawObject) })
  secrets.on('update', (obj) => { objects.applyProjectSecrets(obj as RawObject) })
  secrets.on('delete', (obj) => { objects.applyProjectSecrets(obj as RawObject, true) })

  const registrations = makeInformer(
    client.kubeConfig, configMapsPath,
    () => client.core.listNamespacedConfigMap({ namespace: ns, labelSelector: selector('registration') }),
    selector('registration'),
  )
  registrations.on('add', (obj) => { objects.applyRegistration(obj as RawObject) })
  registrations.on('update', (obj) => { objects.applyRegistration(obj as RawObject) })
  registrations.on('delete', (obj) => { objects.applyRegistration(obj as RawObject, true) })

  superviseInformer(credentials, 'credentials', () => objects.markSeeded('credentials'))
  superviseInformer(secrets, 'secrets', () => objects.markSeeded('secrets'))
  superviseInformer(registrations, 'registrations', () => objects.markSeeded('registration'))
}

/**
 * Cache-miss fallback for a registration: a Job created microseconds after
 * its ConfigMap can have its first packet beat the watch event, and a watch
 * mid-restart misses a create for up to its backoff. One list by label
 * before failing closed; a miss is remembered briefly so an unregistered
 * pod's every connection does not become an API call.
 */
const registrationMisses = new Map<string, number>()
const REGISTRATION_MISS_TTL_MS = 5_000

export async function fetchRegistration(
  objects: ProxyObjects,
  worktreeId: string,
  client: Client = inClusterClient(),
): Promise<WorktreeRegistration | undefined> {
  const missedAt = registrationMisses.get(worktreeId)
  if (missedAt !== undefined && Date.now() - missedAt < REGISTRATION_MISS_TTL_MS) return undefined
  const list = await client.core.listNamespacedConfigMap({
    namespace: client.namespace,
    labelSelector: `${selector('registration')},${LABEL_WORKTREE_ID}=${worktreeId}`,
  })
  for (const cm of list.items) objects.applyRegistration(cm as RawObject)
  const found = objects.registration(worktreeId)
  if (!found) registrationMisses.set(worktreeId, Date.now())
  return found
}

// ── The proxy's own writes ─────────────────────────────────────────────

const MERGE_PATCH = setHeaderOptions('Content-Type', PatchStrategy.MergePatch)

/** Merge `data` into the refreshed-bundles Secret (other keys untouched). */
export async function writeRefreshed(data: Record<string, string>, client: Client = inClusterClient()): Promise<void> {
  await client.core.patchNamespacedSecret(
    { name: REFRESHED_SECRET_NAME, namespace: client.namespace, body: { data } },
    MERGE_PATCH,
  )
}

export async function writeCa(data: Record<string, string>, client: Client = inClusterClient()): Promise<void> {
  await client.core.patchNamespacedSecret(
    { name: CA_SECRET_NAME, namespace: client.namespace, body: { data } },
    MERGE_PATCH,
  )
}

export async function writeState(data: Record<string, string>, client: Client = inClusterClient()): Promise<void> {
  await client.core.patchNamespacedConfigMap(
    { name: STATE_CONFIGMAP_NAME, namespace: client.namespace, body: { data } },
    MERGE_PATCH,
  )
}

/** One read of an output object at boot — the CA to keep serving, the
 *  records and captured rotations the last pod left. Absent reads as empty. */
export async function readOutputObject(
  kind: 'secret' | 'configmap',
  name: string,
  client: Client = inClusterClient(),
): Promise<RawObject> {
  const req = { name, namespace: client.namespace }
  const obj = kind === 'secret'
    ? await client.core.readNamespacedSecret(req)
    : await client.core.readNamespacedConfigMap(req)
  return obj as RawObject
}
