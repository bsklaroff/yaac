import { beforeEach, vi } from 'vitest'
import { fakeCluster, k8sClientStub } from '#k8s-stub'

// Stub `@kubernetes/client-node` (see k8s-stub.ts) for the projects
// vitest.config.ts loads this into. Not in unit-setup.ts because k8s/proxy
// and k8s/netd need the real library.
//
// Unlike in a test file, vi.mock is not hoisted in a setup file, so the
// factory can use the statically imported helper.
vi.mock('@kubernetes/client-node', () => k8sClientStub())

beforeEach(() => { fakeCluster.reset() })
