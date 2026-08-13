import { worktreeDriver } from '#drivers/driver'
import { resolveProjectConfig } from '#domain/projects'

/**
 * Forget a finished image build and run it again now. `false` when the id
 * is unknown or its build is still running — there was nothing to retry.
 *
 * The only part of the image-build surface that is a mediator's: the reads
 * and the dismissal are display values the runtime already holds, and api
 * asks it for those directly. This one cannot be asked for directly,
 * because a rebuild has to know what each owning project's config asks
 * for — and the runtime may not read config at all. So the reader is
 * composed here, where config comes from, along with the one translation
 * it needs: the store says "no config" with `null`, the contract says it
 * with `undefined`, and both mean the same ordinary thing (all defaults).
 *
 * A defaulted config would not fail loudly, which is why this is worth a
 * verb rather than a closure at the call site: it would rebuild a nested
 * project without its nestable layer and report success.
 */
export function retryImageBuild(id: string): boolean {
  return worktreeDriver().retryImageBuild(
    id,
    (slug) => resolveProjectConfig(slug).then((cfg) => cfg ?? undefined),
  )
}
