# Modularity metrics

`pnpm modularity` scores how cleanly the codebase is split into modules on
three axes: how much code there is, how wide the interfaces between modules
are, and how tangled the dependency graph is. It prints a report and never
fails, so it is a tool for reviewing a change, not a gate.

```
pnpm modularity                       # every packages/*/src
pnpm modularity packages/server/src   # one package
pnpm modularity --runtime-only        # ignore type-only imports
pnpm modularity --files               # the same metrics at file granularity
pnpm modularity --names               # list single-consumer barrel exports
pnpm modularity --json                # machine-readable, incl. the module graph
```

dependency-cruiser extracts the raw file graph (configured in
`.dependency-cruiser.cjs`, which also works on its own for graph rendering and
rule checks). `scripts/modularity.ts` computes the rest.

## What a module is

A sealed folder (one with an `index.ts` barrel mapped in its package's
`imports`) is always its own module, because its barrel is the interface the
repo has committed to. When sealed folders nest, a file belongs to the
deepest one: `drivers/k8s/substrate` is a module inside `drivers/k8s`.

Any other file belongs to the shallowest directory under `src/` that holds
source files directly. A directory with only subdirectories is therefore not
a module itself: in the server, `runtime/` has no files of its own, so
`runtime/agents` and its siblings are the modules. `drivers/` holds
`contract.ts` and `driver.ts`, so it is a module of its own beside the sealed
driver folders under it.

The script re-resolves imports that go through a package's `imports` map.
dependency-cruiser cannot read an imports map, and cannot map the `./src/*.js`
targets back to `.ts` sources, so on its own it misses most internal edges.

## Coupling and cycles

The headline numbers come from Lakos, *Large-Scale C++ Software Design*:

- **CD(m)**: cumulative component dependency. The number of modules you must
  understand, link or stub out to use `m`, counting `m` itself.
- **CCD**: the sum of CD over every module.
- **NCCD**: CCD divided by the CCD of a balanced binary dependency tree of the
  same size. About 1.0 is tree-like. Lakos treats anything above about 1.6 as
  a design smell.
- **PC**: MacCormack and Baldwin's propagation cost, `CCD / n²`. It is the
  fraction of the system an average change can reach, which makes it
  comparable across scopes of different sizes.

Cycles need no separate score. A cycle of *n* mutually dependent modules adds
*n²* to CCD, because every member reaches every other, while a layered DAG of
the same size lands near *n·log₂n*. The report also prints how much of CCD
comes from cycles alone, and for each cycle it lists the internal edges
carried by the fewest files, since those are the cheapest to cut. Martin's
afferent and efferent coupling (`Ca`, `Ce`) appear in the per-module table as
the local view of the same thing.

Type-only imports count by default. They vanish at compile time, but a type
that crosses a barrel is still part of that barrel's interface. Use
`--runtime-only` to see the graph the bundler sees, which is the right one
when asking whether a cycle can cause an initialization-order bug. Cycle
edges made only of type imports are tagged `[type-only]` either way.

## Interface width

Interfaces are measured at the barrels. For each module the report gives the
number of exported names, how many of them code outside the folder imports,
how many have exactly one consumer, and `depth`: Ousterhout's ratio of
implementation lines to exported names.

A deep module hides a lot of behavior behind a small surface; a shallow one is
mostly surface. An export nothing imports is width with no payoff, so delete or
unexport it. An export with one consumer is a weaker signal, but a barrel where
most names have a single consumer is usually a namespace rather than an
abstraction: the folder is exporting its internals under another name.

## Lines of code

`sloc` is reported but left out of every score. Minimizing lines pushes toward
extracting shared helpers, and helpers extracted only to avoid repetition are
a common cause of wide interfaces and cycles. Ousterhout's deep-module
principle accepts more implementation code in exchange for a narrower
interface. Use size to break ties between designs that score the same on
coupling and interface width.
