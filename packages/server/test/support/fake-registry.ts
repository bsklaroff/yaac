import crypto from 'node:crypto'
import { vi } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { REGISTRY_NAMESPACE, registryHost } from '#drivers/k8s/cluster/registry'

/** The real `fetch`, captured before any test stubs it. */
const realFetch = globalThis.fetch

/** The ConfigMap install records mirror digests in (`recordMirrorDigest`). */
const MIRROR_DIGESTS = 'yaac-mirror-digests'

/**
 * A fake main registry at the network boundary, for unit tests of code
 * that asks the registry which tags it holds. `install()` points the
 * registry client at the in-cluster Service (`YAAC_IN_CLUSTER`), so no
 * port-forward is spawned, and stubs `fetch` to answer `/v2/` and manifest
 * HEADs, by tag or by digest. Like registry:2, it keeps serving a manifest
 * a tag moved off until `collect()`. Requests to any other URL reach the
 * real `fetch`. Call `install()` from a `beforeEach`; it starts empty and
 * reachable.
 */
export const fakeRegistry = {
  /** `repo:tag` strings the registry holds. */
  tags: new Set<string>(),
  /** The digest a held tag names, when pushed with one; else `digestOf`
   *  derives it from the tag. */
  digests: new Map<string, string>(),
  /** `repo@digest` of manifests no tag names any more, until `collect()`. */
  untagged: new Set<string>(),
  /** When set, the registry holds every tag asked about. */
  holdsAll: false,
  /** When set, every request fails the way an unreachable registry's does. */
  down: false,
  /** Each `repo:tag` or `repo@digest` a manifest HEAD asked about, in order. */
  lookups: [] as string[],

  /** The manifest digest `repo:tag` names. */
  digestOf(tag: string): string {
    return fakeRegistry.digests.get(tag)
      ?? `sha256:${crypto.createHash('sha256').update(tag).digest('hex')}`
  },

  /** Whether the registry answers for `repo:tag` or `repo@digest`. */
  holds(ref: string): boolean {
    if (fakeRegistry.holdsAll) return true
    const at = ref.indexOf('@')
    if (at < 0) return fakeRegistry.tags.has(ref)
    return fakeRegistry.untagged.has(ref) || [...fakeRegistry.tags].some((tag) =>
      tag.startsWith(`${ref.slice(0, at)}:`) && fakeRegistry.digestOf(tag) === ref.slice(at + 1))
  },

  /** Push `tag` as `digest` (else the derived one), leaving the manifest it
   *  named before untagged. */
  push(tag: string, digest?: string): void {
    if (fakeRegistry.tags.has(tag)) {
      fakeRegistry.untagged.add(`${tag.slice(0, tag.lastIndexOf(':'))}@${fakeRegistry.digestOf(tag)}`)
    }
    fakeRegistry.tags.add(tag)
    if (digest) fakeRegistry.digests.set(tag, digest)
    else fakeRegistry.digests.delete(tag)
  },

  /** Garbage-collect: drop every manifest no tag names. */
  collect(): void {
    fakeRegistry.untagged.clear()
  },

  /** Write `value` as install's record for mirror `tag`. */
  record(tag: string, value: string): void {
    const record = fakeCluster.get<{ data?: Record<string, string> }>('ConfigMap', MIRROR_DIGESTS, REGISTRY_NAMESPACE)
    fakeCluster.seed({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: MIRROR_DIGESTS, namespace: REGISTRY_NAMESPACE },
      data: { ...record?.data, [tag.replace(/[/:]/g, '_')]: value },
    })
  },

  /** Hold pinned mirror `tags` as install leaves them: pushed, with the
   *  digest each names recorded beside the registry. */
  mirror(...tags: string[]): void {
    for (const tag of tags) {
      fakeRegistry.push(tag)
      fakeRegistry.record(tag, fakeRegistry.digestOf(tag))
    }
  },

  install(): void {
    fakeRegistry.tags.clear()
    fakeRegistry.digests.clear()
    fakeRegistry.untagged.clear()
    fakeRegistry.holdsAll = false
    fakeRegistry.down = false
    fakeRegistry.lookups.length = 0
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    const origin = `http://${registryHost()}`
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith(origin)) return realFetch(input, init)
      if (fakeRegistry.down) return Promise.reject(new TypeError('fetch failed'))
      const route = url.slice(origin.length)
      const manifest = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(route)
      if (!manifest) return Promise.resolve(new Response(null, { status: route === '/v2/' ? 200 : 404 }))
      const [, repo, reference] = manifest
      const ref = reference.startsWith('sha256:') ? `${repo}@${reference}` : `${repo}:${reference}`
      fakeRegistry.lookups.push(ref)
      if (!fakeRegistry.holds(ref)) return Promise.resolve(new Response(null, { status: 404 }))
      const digest = ref.includes('@') ? reference : fakeRegistry.digestOf(ref)
      return Promise.resolve(new Response(null, { status: 200, headers: { 'docker-content-digest': digest } }))
    })
  },
}
