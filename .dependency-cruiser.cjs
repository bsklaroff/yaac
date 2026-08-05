// Config for dependency-cruiser, the module-graph extractor behind
// `pnpm modularity` (scripts/modularity.ts). It is also usable on its own for
// ad-hoc graph work, e.g.
//   pnpm depcruise packages/server/src --output-type dot | dot -Tsvg > g.svg
//   pnpm depcruise packages/server/src --output-type err   # rule violations
//
// The `#…` subpath specifiers in our packages' `imports` maps are NOT resolved
// here: dependency-cruiser drives enhanced-resolve without `importsFields` or
// `extensionAlias`, so it can neither read an imports map nor substitute the
// `./src/*.js` targets back to `.ts`. scripts/modularity.ts re-resolves those
// edges itself from each package.json. Anything reading this config's raw
// output must do the same or it will see a graph with most internal edges
// missing.
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'warn',
      comment: 'Cycles make the module graph harder to reason about and to test in isolation.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'info',
      comment: 'Modules nothing imports are usually dead code.',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)dist/' },
    tsConfig: { fileName: 'tsconfig.json' },
    // Count type-only imports as dependencies: a type that crosses a barrel is
    // still part of that barrel's interface.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  },
}
