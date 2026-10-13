/**
 * Shared harness for the two `*-stacking` test files. They run the real image
 * code (chain resolution, tag hashing, engine routing) against a temp data
 * dir, faking only the local registry and the builder pod, which records a
 * `build <tag> [args]` row in `operations` for each layer it builds.
 */
import { beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { fakeRegistry } from '#test/support/fake-registry'
// Type-only: `load` imports the values after vi.resetModules().
import type * as imageTags from '#drivers/k8s/cluster/image-tags'
import type * as buildCoordinator from '#drivers/k8s/images/build-coordinator'

/** The 16-hex-char content hash every layer tag ends in. */
export const HASH_RE = '[0-9a-f]{16}'

type ImagesModules = typeof imageTags & typeof buildCoordinator

export interface StackingHarness {
  /** Real temp data dir for this test; write Dockerfiles under it before `load`. */
  readonly dataDir: string
  /** Ordered `build <tag> [k=v,…]` rows in build order. */
  readonly operations: string[]
  /**
   * Declare which tags the local registry holds. `yaac cluster install`
   * builds the yaac-shipped layers, so a build expected to succeed must
   * stage them.
   */
  stageRegistry(tags: readonly string[]): void
  /** Import the feature fresh against the fakes below. Call after staging files. */
  load(): Promise<ImagesModules>
}

/**
 * Register the per-test data dir and fakes, and return the handle the test
 * drives. Call once inside a `describe`.
 */
export function setupStackingHarness(): StackingHarness {
  const operations: string[] = []
  const state = { dataDir: '' }

  beforeEach(async () => {
    operations.length = 0
    fakeRegistry.install()
    state.dataDir = await createTempDataDir()
  })

  afterEach(async () => {
    vi.doUnmock('#drivers/k8s/images/builder-pod')
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await cleanupTempDir(state.dataDir)
  })

  async function load(): Promise<ImagesModules> {
    // Fresh modules, so the coordinator's per-run caches start empty. The
    // reset also clears the data-dir setting, so it is re-applied below.
    vi.resetModules()

    // Untrusted layers build in a builder pod; the fake records each.
    vi.doMock('#drivers/k8s/images/builder-pod', () => ({
      BuilderPodLease: class {
        acquire(): Promise<string> { return Promise.resolve('builder-pod') }
        release(): Promise<void> { return Promise.resolve() }
      },
      buildLayerInPod: vi.fn(
        (layer: { tag: string; buildArgs?: Record<string, string> }) => {
          const pairs = Object.entries(layer.buildArgs ?? {}).map(([k, v]) => `${k}=${v}`)
          const suffix = pairs.length ? ` [${pairs.join(',')}]` : ''
          operations.push(`build ${layer.tag}${suffix}`)
          return Promise.resolve()
        },
      ),
    }))

    // Dynamic imports, so the fresh modules pick up the doMock above.
    // eslint-disable-next-line no-restricted-syntax
    const paths = await import('@yaac/shared/project-paths')
    paths.setDataDir(state.dataDir)
    // eslint-disable-next-line no-restricted-syntax
    const tags = await import('#drivers/k8s/cluster/image-tags')
    // eslint-disable-next-line no-restricted-syntax
    const coordinator = await import('#drivers/k8s/images/build-coordinator')
    return { ...tags, ...coordinator }
  }

  return {
    get dataDir() { return state.dataDir },
    operations,
    stageRegistry(tags: readonly string[]) {
      for (const tag of tags) fakeRegistry.tags.add(tag)
    },
    load,
  }
}
