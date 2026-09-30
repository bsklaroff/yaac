/**
 * Stand-in for `@kubernetes/client-node` in unit runs.
 *
 * The real package takes ~2.8s to import, and roughly half the
 * `unit:server` files reach it through the `#drivers/k8s/substrate` barrel.
 * Unit tests mock the process boundary and never call the client, so they
 * only need the names to exist.
 *
 * Anything that would talk to an apiserver throws, so a unit test that
 * wants a real cluster fails loudly. A file that needs the real client
 * overrides this with `vi.mock('@kubernetes/client-node', importOriginal)`.
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
 * The module shape `vi.mock` installs: only the runtime values
 * `#drivers/k8s/substrate` imports.
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
