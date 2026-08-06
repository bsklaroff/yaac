/**
 * What the cluster must be holding up before an image can be built in it,
 * and the wiring that hands that guarantee to `#features/image-engine`.
 *
 * The builder pods live one layer down, in `#features/image-engine`, because
 * cluster setup builds netd's image and a builder that imported this feature
 * would put the two in a cycle (CLAUDE.md; `pnpm modularity` checks it). What
 * the pods need from up here — the registry they pull parents from and push
 * products to, the admission guard that reserves their role label, the
 * policies that let them reach the registry and upstream — is therefore
 * INJECTED, and this module is the injection.
 *
 * BOOTSTRAP ORDERING. Everything below is stood up from digest-pinned
 * UPSTREAM images that node containerd pulls directly (`registry:2` for the
 * registry itself, `podman/stable` for a builder pod whose mirror does not
 * exist yet), so nothing here needs an image yaac built. That is what makes
 * "the builder needs a cluster, and the cluster needs images" not a cycle:
 * `yaac cluster setup` installs the registry, the guard and the gVisor
 * runtime BEFORE it builds netd's image, and every one of those steps runs
 * on images no builder has to produce. See docs/image-builds.md.
 */
import {
  buildBuilderEgressNetworkPolicyManifest,
  imageBuilder,
  withImageBuilder,
  type ImageBuilder,
} from '#features/image-engine'
import { EGRESS_WORLD_DENY_NAME, k8sNamespace, kubectlApply, kubectlGetJson } from '#platform/k8s'
import { buildEgressWorldDenyNpManifest } from './policy-manifests'
import { ensureBuilderRoleGuard } from './proxy-apply'
import { ensureMainRegistry } from './main-registry'

/**
 * Make the cluster able to host a builder pod. Idempotent, and cheap enough
 * to run before every lease: three applies and one get.
 *
 * The world-deny policy is REFRESHED when it already exists in this
 * namespace — an older server may have written it without the builder
 * exclusion, which would leave builder pods selected by a default-deny they
 * need to be outside of. Never introduced here: namespaces without it keep
 * their existing posture.
 */
export async function ensureClusterBuilderHost(): Promise<void> {
  await ensureMainRegistry()
  await ensureBuilderRoleGuard()
  await kubectlApply(buildBuilderEgressNetworkPolicyManifest())
  const existing = await kubectlGetJson<Record<string, unknown>>([
    'get', 'networkpolicy', EGRESS_WORLD_DENY_NAME, '-n', k8sNamespace(),
  ]).catch(() => null)
  if (existing) await kubectlApply(buildEgressWorldDenyNpManifest())
}

/** This install's image builder, already bound to the cluster it builds in. */
export function clusterImageBuilder(): ImageBuilder {
  return imageBuilder(ensureClusterBuilderHost)
}

/**
 * `clusterImageBuilder`, scoped to one operation and closed for you.
 *
 * An explicit `builder` short-circuits it, and exists for one caller: the
 * e2e global setup, which prebuilds and mirrors through the HOST engine on
 * a developer machine (docs/image-builds.md). It must not be able to do so
 * by setting `YAAC_IMAGE_BUILDER` — the servers it spawns inherit its
 * environment, and they are exactly what the suite is meant to run through
 * the default builder.
 */
export function withClusterImageBuilder<T>(
  fn: (builder: ImageBuilder) => Promise<T>,
  builder?: ImageBuilder,
): Promise<T> {
  return builder ? fn(builder) : withImageBuilder(ensureClusterBuilderHost, fn)
}
