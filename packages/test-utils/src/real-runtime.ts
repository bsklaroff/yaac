import { setWorktreeRuntime } from '@yaac/server/runtime/driver'
import { k8sWorktreeRuntime } from '@yaac/server/main/runtime-k8s'

/**
 * Register the REAL k8s runtime, for tests that mean to exercise a mediator
 * and the driver together with only the process boundary (kubectl, the
 * stream relay) mocked out.
 *
 * Deliberately its own module: importing it pulls in the whole k8s driver
 * and, with it, `@kubernetes/client-node` — seconds of import time per test
 * file. Tests that only need a mediator want `fake-runtime` instead, which
 * costs nothing.
 */
export function installRealWorktreeRuntime(): void {
  setWorktreeRuntime(k8sWorktreeRuntime())
}
