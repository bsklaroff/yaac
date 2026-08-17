import { testEnv } from '@yaac/shared/env'

/**
 * Every image yaac itself ships — the base/tools/nestable chain, the egress
 * proxy, netd, and the digest-pinned upstream mirrors — is realized on the
 * machine running the yaac CLI by `yaac cluster install`, pushed to the
 * in-cluster registry, and consumed from there by content-hash tag. The
 * server builds only what a project or a user wrote, and only in a
 * sandboxed builder pod (docs/trust-split-builds.md).
 *
 * So a tag the registry does not have is a missing *install*, never a
 * build trigger. This is the one place that says so, in whichever of the
 * two vocabularies fits the audience — an e2e run's images come from
 * test/global-setup.ts, and telling a test to run `cluster install` would
 * send it to the wrong prebuild.
 */
export function missingPrebuiltImage(what: string, tag: string): Error {
  return new Error(
    `${what} image ${tag} is missing from the local registry. `
    + (testEnv.requirePrebuiltImages
      ? 'Restart the test run so the global setup can build it.'
      : 'Build and push it with `yaac cluster install`.'),
  )
}
