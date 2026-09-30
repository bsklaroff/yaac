import { testEnv } from '@yaac/shared/env'

/**
 * The error for a yaac-shipped image missing from the registry. These
 * images (base/tools/nestable, proxy, netd, upstream mirrors) are built by
 * `yaac cluster install`, not by the server, which only builds project and
 * user layers (docs/trust-split-builds.md). So a missing tag means a
 * missing install, never a build trigger. Under test the fix is a rerun of
 * test/global-setup.ts instead.
 */
export function missingPrebuiltImage(what: string, tag: string): Error {
  return new Error(
    `${what} image ${tag} is missing from the local registry. `
    + (testEnv.requirePrebuiltImages
      ? 'Restart the test run so the global setup can build it.'
      : 'Build and push it with `yaac cluster install`.'),
  )
}
