/**
 * The proxy's live view of its input objects, and its writes to its output
 * objects (shapes in objects.ts; design in docs/workspace-egress.md).
 *
 * Three informers, selected by the `yaac.proxy-input` label, feed
 * `ProxyObjects`: the credentials Secret, the per-project secrets Secrets and
 * the per-workspace registration ConfigMaps. The pod keeps no state of its
 * own; a replacement rebuilds everything from the initial lists. Until all
 * three lists have landed, `ready()` is false and the readiness probe keeps
 * the pod out of its Service.
 */

import { PatchStrategy, setHeaderOptions, type KubernetesObject } from '@kubernetes/client-node'
import { inClusterClient, makeInformer, superviseInformer } from './pod-watch'
import { agentIdentities, type AgentIdentity } from './agent-keys'
import {
  CA_SECRET_NAME,
  CREDENTIALS_SECRET_NAME,
  EMPTY_CREDENTIALS,
  LABEL_PROXY_INPUT,
  LABEL_WORKSPACE_ID,
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
  type ProxyRegistration,
} from './objects'

export interface ProxyObjectsDeps {
  /** Replace the ssh-agent's identities (injected for tests). */
  loadSshKeys: (identities: AgentIdentity[]) => Promise<void>
  /** A workspace's registration changed (or went, on `null`): the listener
   *  prunes its blocked-host record against the new allowlist. */
  onRegistration?: (workspaceId: string, registration: ProxyRegistration | null) => void
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
  /** `<projectId>/<NAME>` -> value, across every project's Secret. */
  private readonly secrets = new Map<string, string>()
  /** The refs each secrets object contributed, so an update or delete
   *  forgets exactly those. */
  private readonly refsByObject = new Map<string, string[]>()
  private readonly registrations = new Map<string, ProxyRegistration>()
  /** Object name -> workspace id, so a DELETE (which may arrive without
   *  data) still evicts the right registration. */
  private readonly workspaceByObject = new Map<string, string>()
  /**
   * OAuth bundles captured from a workspace's refresh that the credentials
   * Secret does not reflect yet. Served while newer than the pushed bundle,
   * because a codex refresh token is single-use and the pushed one is spent.
   */
  private captured: RefreshedBundles = {}
  /** The identities last loaded into the agent, so unrelated credential
   *  changes don't reload it under an in-flight ssh operation. */
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

  /** The Claude OAuth bundle to inject: a newer captured one, else the
   *  pushed one. */
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

  registration(workspaceId: string): ProxyRegistration | undefined {
    return this.registrations.get(workspaceId)
  }

  registeredWorkspaceIds(): string[] {
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
   * The credentials Secret changed (or was deleted, if `gone`): replace the
   * whole set, and reload the ssh-agent if its identities changed. Objects
   * with the label but the wrong name are ignored.
   */
  applyCredentials(secret: RawObject, gone = false): Promise<void> {
    if (secret.metadata?.name !== CREDENTIALS_SECRET_NAME) {
      this.log(`[proxy] ignoring a credentials-labelled object that is not ${CREDENTIALS_SECRET_NAME}: ${secret.metadata?.name ?? '?'}`)
      return Promise.resolve()
    }
    this.creds = gone ? EMPTY_CREDENTIALS : decodeCredentials(secret)
    // Drop captured bundles the pushed ones have caught up with.
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
    const identities = agentIdentities(this.creds.ssh)
    const ssh = JSON.stringify(identities)
    if (ssh === this.loadedSsh) return Promise.resolve()
    this.loadedSsh = ssh
    return this.loadSshKeys(identities).catch((err: unknown) => {
      // Retried on the next change.
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
    const previous = this.workspaceByObject.get(name)
    const decoded = gone ? null : decodeRegistration(cm)
    if (previous !== undefined && previous !== decoded?.workspaceId) {
      this.registrations.delete(previous)
      this.workspaceByObject.delete(name)
      this.onRegistration?.(previous, null)
      this.log(`[proxy] deregistered workspace ${previous.slice(0, 8)}...`)
    }
    if (!decoded) {
      if (!gone) this.log(`[proxy] ignoring malformed registration ${name}`)
      return
    }
    const { workspaceId, registration } = decoded
    const isNew = !this.registrations.has(workspaceId)
    this.registrations.set(workspaceId, registration)
    this.workspaceByObject.set(name, workspaceId)
    this.onRegistration?.(workspaceId, registration)
    if (isNew) {
      const redirects = Object.keys(registration.upstreamRedirects ?? {}).length
      this.log(`[proxy] registered workspace ${workspaceId.slice(0, 8)}... `
        + `(${registration.rules.length} rules, ${registration.allowedHosts.length} allowed host patterns`
        + `${redirects > 0 ? `, ${redirects} upstream redirects` : ''})`)
    }
  }

  /** A rotation this proxy just captured from a workspace's refresh. */
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
 * Feed `objects` from three informers for the proxy's lifetime. Each relist
 * emits `delete` for objects that vanished meanwhile.
 */
export function startObjectWatch(objects: ProxyObjects, client: Client = inClusterClient()): void {
  const ns = client.namespace
  const secretsPath = `/api/v1/namespaces/${ns}/secrets`
  const configMapsPath = `/api/v1/namespaces/${ns}/configmaps`

  // client-node applies the selector to the watch only; lists need it too.
  const credentials = makeInformer(
    client.kubeConfig, secretsPath,
    () => client.core.listNamespacedSecret({ namespace: ns, labelSelector: selector('credentials') }),
    selector('credentials'),
  )
  const feedCredentials = (obj: KubernetesObject): void => { void objects.applyCredentials(obj) }
  credentials.on('add', feedCredentials)
  credentials.on('update', feedCredentials)
  credentials.on('delete', (obj) => { void objects.applyCredentials(obj, true) })

  const secrets = makeInformer(
    client.kubeConfig, secretsPath,
    () => client.core.listNamespacedSecret({ namespace: ns, labelSelector: selector('secrets') }),
    selector('secrets'),
  )
  secrets.on('add', (obj) => { objects.applyProjectSecrets(obj) })
  secrets.on('update', (obj) => { objects.applyProjectSecrets(obj) })
  secrets.on('delete', (obj) => { objects.applyProjectSecrets(obj, true) })

  const registrations = makeInformer(
    client.kubeConfig, configMapsPath,
    () => client.core.listNamespacedConfigMap({ namespace: ns, labelSelector: selector('registration') }),
    selector('registration'),
  )
  registrations.on('add', (obj) => { objects.applyRegistration(obj) })
  registrations.on('update', (obj) => { objects.applyRegistration(obj) })
  registrations.on('delete', (obj) => { objects.applyRegistration(obj, true) })

  superviseInformer(credentials, 'credentials', () => objects.markSeeded('credentials'))
  superviseInformer(secrets, 'secrets', () => objects.markSeeded('secrets'))
  superviseInformer(registrations, 'registrations', () => objects.markSeeded('registration'))
}

/**
 * Cache-miss fallback for a registration, for a pod whose first packet beats
 * the ConfigMap's watch event (or arrives while the watch restarts). Lists
 * once by label before failing closed; misses are cached briefly so an
 * unregistered pod doesn't cost an API call per connection.
 */
const registrationMisses = new Map<string, number>()
const REGISTRATION_MISS_TTL_MS = 5_000

export async function fetchRegistration(
  objects: ProxyObjects,
  workspaceId: string,
  client: Client = inClusterClient(),
): Promise<ProxyRegistration | undefined> {
  const missedAt = registrationMisses.get(workspaceId)
  if (missedAt !== undefined && Date.now() - missedAt < REGISTRATION_MISS_TTL_MS) return undefined
  const list = await client.core.listNamespacedConfigMap({
    namespace: client.namespace,
    labelSelector: `${selector('registration')},${LABEL_WORKSPACE_ID}=${workspaceId}`,
  })
  for (const cm of list.items) objects.applyRegistration(cm)
  const found = objects.registration(workspaceId)
  if (!found) registrationMisses.set(workspaceId, Date.now())
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

/** Read an output object at boot, to pick up the CA, records and captured
 *  bundles the previous pod left. */
export async function readOutputObject(
  kind: 'secret' | 'configmap',
  name: string,
  client: Client = inClusterClient(),
): Promise<RawObject> {
  const req = { name, namespace: client.namespace }
  const obj = kind === 'secret'
    ? await client.core.readNamespacedSecret(req)
    : await client.core.readNamespacedConfigMap(req)
  return obj
}
