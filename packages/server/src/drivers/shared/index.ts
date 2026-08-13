// What the drivers share with each other, and with nothing else.
//
// The layer below is `#lib`, which is dependency-free and open to every
// layer; this one is dependency-free too but deliberately NOT open — it
// holds the things that are common to substrates and meaningless outside
// them. A driver is sealed from its siblings (`#drivers/k8s` and
// `#drivers/containerless` cannot see each other, so neither can host code
// the other needs), and without somewhere for that to live the choice is
// duplicating it or pushing substrate concerns up into `#lib` where every
// mediator would inherit them.
//
// The arrow runs one way and the lint enforces it: a driver imports
// `#drivers/shared`, and nothing in here may import a driver — not the
// contract's implementations, not `#db`, `#domain` or `#runtime`. That is
// what keeps it a floor rather than a back channel between the two drivers.
//
// The test of whether something belongs here is who calls it. Both drivers
// and nobody else → here. Anyone above a driver as well → `#lib` (the
// status bar's text, the host-port reservation) or `@yaac/shared` (anything
// that also crosses the wire). One driver only → that driver's own folder.
//
// Adding a name here widens the interface and obliges a unit test in
// packages/server/test/drivers/shared/.

// The review diff: the script a driver runs inside a workspace, and the
// parser for what it prints. The parsing internals behind
// `parseChangesOutput` (numstat, name-status, git's rename notation) stay
// off the barrel — they are one function's parts, and it is what the
// drivers call.
export {
  buildChangesScript,
  parseChangesOutput,
  type ChangesLocation,
} from './worktree-changes'
// What a workspace's detected listeners may be offered as, and how many.
// `SENSITIVE_PORTS` is behind `isForwardablePort`, which is the question a
// driver actually asks.
export { MAX_SURFACED_PORTS, isForwardablePort } from './port-policy'
