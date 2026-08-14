// The public interface of the k8s runtime's VIEW of itself: the one place a
// pod becomes a `RuntimeHandle`, and the pass snapshot built on top of it.
//
// Sealed and separate from `worktrees` because folding it into the
// observation folder would make other folders import across that seal for a
// type they use and a feature they don't.
//
// Modules in here import each other by relative path; everything outside
// imports `#drivers/k8s/view`.
export { runtimeHandleFromPod } from './handle'
export { createRuntimeSnapshot } from './snapshot'
