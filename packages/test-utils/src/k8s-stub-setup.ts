import { vi } from 'vitest'
import { k8sClientStub } from '#k8s-stub'

// Install the `@kubernetes/client-node` stub for every test file in the
// project that loads this. Separate from unit-setup.ts because it is not
// universal: the projects whose subject IS a k8s client (k8s/proxy,
// k8s/netd) load the real library instead, and vitest.config.ts decides
// which projects get this file.
//
// ~2.8s per test file, so this is the largest single lever on the unit run.
// k8s-stub.ts has the full rationale, and the escape hatch for a file that
// needs the real client inside a project that stubs it.
//
// The factory closes over a statically imported helper, which a *test* file
// could not do — vitest hoists vi.mock above the imports there. Setup files
// are not test files: this runs top to bottom, and the factory is called
// later still, the first time something imports the mocked module.
vi.mock('@kubernetes/client-node', () => k8sClientStub())
