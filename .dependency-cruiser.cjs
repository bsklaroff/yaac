// Config for dependency-cruiser, the module-graph extractor behind
// `pnpm modularity` (scripts/modularity.ts). It is also usable on its own for
// ad-hoc graph work, e.g.
//   pnpm depcruise packages/server/src --output-type dot | dot -Tsvg > g.svg
//   pnpm depcruise packages/server/src --output-type err   # rule violations
//
// The `#…` subpath imports are not resolved here: dependency-cruiser's
// enhanced-resolve setup cannot read an `imports` map or map the `./src/*.js`
// targets back to `.ts`. scripts/modularity.ts re-resolves those edges from
// each package.json; any other reader of the raw output must do the same, or
// most internal edges will be missing.
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
