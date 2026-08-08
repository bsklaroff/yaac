/**
 * Stand-in for `@kubernetes/client-node` in unit runs.
 *
 * The real package is 967 ESM files behind one barrel and costs ~2.8s to
 * evaluate. `#platform/k8s` reaches it through three modules (the API
 * handles, the informer registry, the readiness watch), and its barrel
 * re-exports those, so *every* test file that imports any server feature
 * pays that 2.8s before its first assertion — roughly half of the
 * `unit:server` files, and by far the largest single cost in the unit run.
 *
 * Unit tests never drive the client: they are hermetic and mock the process
 * boundary (kubectl, spawn, podman), so the library is imported and then
 * never meaningfully called. This gives them the identities their subjects
 * import without the graph behind them.
 *
 * Everything that would actually talk to an apiserver throws instead of
 * returning an empty result. A unit test reaching one of these has found a
 * path that wants a real cluster, and a loud failure names it; a silent
 * `undefined` would turn into a confusing assertion failure somewhere else.
 * A file that genuinely needs the real client overrides this with its own
 * `vi.mock('@kubernetes/client-node', importOriginal)` — cluster-cache and
 * pod-wait do exactly that, and pay the 2.8s deliberately.
 */

function unavailable(what: string): never {
  throw new Error(
    `${what} is stubbed in unit tests: this path wants a real apiserver. Mock the `
    + 'process boundary instead, or opt this file back into the real client with '
    + "vi.mock('@kubernetes/client-node', async (importOriginal) => …). See "
    + 'packages/test-utils/src/k8s-stub.ts.',
  )
}

class CoreV1ApiStub {}
class BatchV1ApiStub {}

class KubeConfigStub {
  loadFromDefault(): void { /* the stub is already "loaded" — no kubeconfig is read */ }
  makeApiClient<T>(Api: new () => T): T { return new Api() }
  getCurrentCluster(): never { return unavailable('KubeConfig.getCurrentCluster()') }
  getCurrentContext(): never { return unavailable('KubeConfig.getCurrentContext()') }
  applyToHTTPSOptions(): never { return unavailable('KubeConfig.applyToHTTPSOptions()') }
}

class WatchStub {
  watch(): never { return unavailable('Watch.watch()') }
}

/**
 * The module shape `vi.mock` installs. Types are erased at runtime, so only
 * the values `#platform/k8s` imports need to exist here: the two API
 * classes, KubeConfig, Watch, and makeInformer.
 */
export function k8sClientStub(): Record<string, unknown> {
  return {
    CoreV1Api: CoreV1ApiStub,
    BatchV1Api: BatchV1ApiStub,
    KubeConfig: KubeConfigStub,
    Watch: WatchStub,
    makeInformer: () => unavailable('makeInformer()'),
  }
}
