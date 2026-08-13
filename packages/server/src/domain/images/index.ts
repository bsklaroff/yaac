// The public interface of image mediation — two verbs, and the folder is
// small on purpose.
//
// Everything else about image builds is a display value the runtime
// already holds (which builds exist, one build's log, hiding a finished
// row), and api asks the runtime for those itself: a mediator that only
// forwarded the call would hide the seam rather than mediate it. What is
// left here are the calls that cannot be forwarded — both need to know what
// an owning project's config asks for, which the runtime may not fetch for
// itself. A retry hands down a reader (it may span several projects); a
// rebuild names one project, so it hands down the resolved answer.
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

export { rebuildProjectImage } from './rebuild'
export { retryImageBuild } from './retry'
