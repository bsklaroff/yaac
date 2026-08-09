# Modularity metrics

`pnpm modularity` scores how cleanly the codebase is split into modules, on the
three axes that trade against each other: how much code there is, how wide the
interfaces between modules are, and how tangled the dependency graph is.

```
pnpm modularity                       # every packages/*/src
pnpm modularity packages/server/src   # one package
pnpm modularity --runtime-only        # ignore type-only imports
pnpm modularity --files               # the same metrics at file granularity
pnpm modularity --names               # list single-consumer barrel exports
pnpm modularity --json                # machine-readable, incl. the module graph
```

dependency-cruiser extracts the raw file graph (configured in
`.dependency-cruiser.cjs`, and usable directly for graph rendering and rule
checks); `scripts/modularity.ts` computes everything dependency-cruiser does
not.

## What a module is

A sealed folder is always its own module: its barrel is the interface the repo
has already committed to, so it is the boundary regardless of what surrounds it
— `platform/` holds both loose files and sealed subfolders, and comes out as
four modules. Everything else falls back to the shallowest directory under
`src/` that holds source files directly, which makes pure namespace directories
transparent: `features/` is not a module, `features/worktrees` is.

The dependency graph is collapsed to that granularity. Imports that resolve
through a package's `imports` map are re-resolved by the script:
dependency-cruiser drives enhanced-resolve without `importsFields` or
`extensionAlias`, so it can neither read an imports map nor substitute our
output-form `./src/*.js` targets back to `.ts`, and on its own it sees a graph
with most internal edges missing.

## Coupling and acyclicity

The headline numbers are Lakos's, from *Large-Scale C++ Software Design*:

- **CD(m)** — cumulative component dependency: how many modules you must
  understand, link, or stub out to use `m`, counting `m` itself.
- **CCD** — the sum of CD over every module.
- **NCCD** — CCD normalized by the CCD of a balanced binary dependency tree of
  the same size. About 1.0 is tree-like; Lakos treats anything above ~1.6 as a
  design smell.
- **PC** — MacCormack and Baldwin's propagation cost, `CCD / n²`: the fraction
  of the system an average change can reach. The same quantity as CCD, scaled
  to a percentage so it compares across differently-sized scopes.

Acyclicity does not need a separate score, which is the reason to use CCD
rather than a plain edge count. A cycle of *n* mutually dependent modules
contributes *n²* to CCD, because every member reaches every other; a levelized
DAG of the same size lands near *n·log₂n*. Cycles are therefore punished
quadratically and fall out of the one metric. The report prints the share of
CCD attributable purely to mutual reachability inside cycles, so the cost of a
tangle is visible as a number rather than a warning.

For each cycle it also lists the thinnest internal edges — the ones carried by
the fewest files — since those are the cheapest places to cut. Martin's
afferent and efferent coupling (`Ca`, `Ce`) are in the table as the local view
of the same thing.

Type-only imports are counted by default: they are erased at compile time, but
a type that crosses a barrel is still part of that barrel's interface and still
has to be understood. `--runtime-only` drops them, which is the graph the
bundler sees, and is the right lens for asking whether a cycle is a real
initialization hazard. Cycle edges that survive only on type imports are tagged
`[type-only]` either way.

## Interface width

Interfaces are measured at the barrels, since a sealed folder's `index.ts` *is*
its interface. Per module the report gives the number of exported names, how
many of them anything outside the folder actually imports, how many are used by
exactly one other module, and `depth` — Ousterhout's ratio of implementation
lines to exported names.

Deep is good: a deep module hides a lot of behavior behind a little surface, a
shallow one is mostly surface. Exports nothing imports are pure width with no
payoff and should be deleted or unexported. Exports used by exactly one module
are a weaker signal, but a barrel where most names have a single consumer is
usually a namespace rather than an abstraction — the folder is exporting its
internals under a different spelling.

## Lines of code

`sloc` is reported and deliberately left out of every score. Minimizing lines
pushes toward extracting shared abstractions, and abstractions extracted purely
to avoid repetition are a leading cause of both wide interfaces and cycles.
Ousterhout's deep-module principle explicitly trades more implementation code
for a narrower interface. Treat size as a tiebreaker between designs that score
the same on coupling and interface width, not as a co-equal objective.
