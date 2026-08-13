// The public interface of image mediation — one verb, and the folder is
// small on purpose.
//
// Everything else about image builds is a display value the runtime
// already holds (which builds exist, one build's log, hiding a finished
// row), and api asks the runtime for those itself: a mediator that only
// forwarded the call would hide the seam rather than mediate it. What is
// left here is the call that cannot be forwarded — a retry has to hand the
// runtime a reader for each owning project's config, which the runtime may
// not fetch for itself.
//
// A folder rather than a loose `domain/images.ts` even at this size: a
// loose domain module shares a bucket with `reconcile.ts` in the
// modularity graph, which is how a leaf ends up in a cycle across the
// whole layer (docs/modularity-metrics.md).
//
// Everything outside this directory imports `#domain/images`; the
// SEALED_FOLDERS lint rule stops src from reaching past this file. Adding a
// name here widens the interface and obliges a unit test in
// packages/server/test/domain/images/.

export { retryImageBuild } from './retry'
