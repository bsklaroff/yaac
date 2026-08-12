import globals from 'globals'
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'

const RELATIVE_PARENT = { group: ['..*'], message: 'Relative parent imports are not allowed.' }

// The path layer (packages/shared/src/{paths,project-paths}.ts) hands out
// one root per STORAGE TIER — shared / node-local / server-local — so that
// every path declares who has to be able to see it before a multi-node
// cluster gives the tiers different volumes. A path built on the raw
// install root would declare nothing, so the root is off-limits in src.
// The sanctioned exceptions carry an inline disable with a justification:
// the path layer itself, and the two hashes that use the data dir as an
// INSTALL IDENTITY rather than a place to put bytes. See paths.ts.
// `paths` matching is by exact specifier, so every spelling that resolves
// to the path layer has to be listed — including the re-export module and
// the relative forms usable inside packages/shared/src itself. Wired into
// EVERY src zone below: flat-config rule options replace rather than merge,
// so a zone that re-declares no-restricted-imports without this drops it.
const UNTIERED_DATA_DIR = [
  '#paths', '#project-paths', './paths', './project-paths',
  '@yaac/shared/paths', '@yaac/shared/project-paths',
].map((name) => ({
  name,
  importNames: ['getDataDir'],
  message: 'Build paths on a storage tier: sharedPath/sharedProjectPath, nodeLocalProjectPath, or serverLocalPath (see the tier legend in paths.ts).',
}))

// Sealed folders expose an index.ts barrel (mapped to the folder's own
// specifier — `#features/<name>`, `#http`, `#platform/db` — in the package's
// imports field); everything else in the directory is internal.
// src must enter through the barrel — add a folder to the alternation below
// once it has one. Tests are deliberately unrestricted: they still reach
// internals directly, which is what keeps a folder sealable without rewriting
// its whole test file in the same commit.
//
// A `regex` pattern, not a `group` glob: groups are matched with gitignore
// semantics, where the leading `#` of a subpath specifier reads as a comment
// and the pattern is silently discarded — it looks installed but matches
// nothing.
const SEALED_FOLDERS = {
  regex: '^#(domain/(auth|projects|skills|titles|worktrees)|records|runtime/(agents|status|terminals|k8s/(cluster|egress|forwarders|image-engine|images|view|worktrees))|store/(projects|transcripts|worktrees)|http|platform/(container|k8s))/.',
  message: 'This folder is sealed; import its barrel (e.g. #runtime/k8s/images).',
}

// The database drivers themselves, banned everywhere but records. The handle
// and the schema are records' own internal modules (`records/client.ts`,
// `records/schema.ts`) rather than a specifier any layer could name, so this
// is all that is left to ban: rows live behind the records barrel, and
// observed facts enter through `applyWorktreeEvent` rather than through a
// caller-side write (docs/layered-server.md). Reaching the tables from
// outside would take a deep `#records/schema` import, which SEALED_FOLDERS
// already refuses in src.
const NO_DATABASE_DIRECT = {
  regex: '^(@electric-sql/pglite|drizzle-orm)(/|$)',
  message: 'Only #records opens the database (docs/layered-server.md): read or write rows through its barrel.',
}

// Lower layers know nothing about the ones above them — not the HTTP
// layer, not the routes, not the startup. `#notify` and `#log` stay
// importable from every layer: both are zero-dependency outbound channels,
// and a change notification is not a dependency on the hub that consumes
// it.
// The mediators name no substrate: they reach the runtime through
// `#runtime/driver` (the registered driver) and `#runtime/contract` (its
// vocabulary). `#runtime/{agents,status,terminals}` stay open: those are
// runtime vocabulary, not substrate verbs. The api layer is NOT on this
// rule yet — its substrate use is a different shape (image-build rows, the
// proxy client, port forwards) and is staged separately in the plan.
//
// Two things this rule does not yet prove, both of which resolve when the
// holdout list below empties. It is per-file, so a restricted file still
// reaches the substrate TRANSITIVELY through a holdout sibling
// (`stop.ts` → `./cleanup` → `#platform/k8s`) — a green rule is not yet
// the claim that a mediator's module graph is cluster-free, and so not yet
// the unit-test-speed guarantee either.
//
// docs/plans/runtime-contract-completion.md is the migration; the holdout
// override below lists what has not moved yet, and the rule is enforced
// outright once that list is empty.
const NO_SUBSTRATE_ABOVE_RUNTIME = {
  regex: '^(#platform/k8s|#runtime/k8s|#platform/container)(/|$)',
  message: 'Reach the runtime through #runtime/driver and #runtime/contract, never a substrate barrel (docs/layered-server.md).',
}

const NO_API_OR_MAIN = {
  regex: '^(#main|#routes|#http|#api)(/|$)',
  message: 'Layers below api/main must not import them (docs/layered-server.md): report through #records events or #notify instead.',
}

export default tseslint.config(
  // dockerfiles/streamd and dockerfiles/acpd are plain JS baked into the base
  // image (their tests import untyped .js modules), deliberately outside the
  // tsconfig projects — vitest (unit:streamd, unit:acpd) is their gate.
  { ignores: ['dist', 'dist-test', 'packages/*/dist', 'packages/desktop/dist-app', 'packages/desktop/staging', 'dockerfiles/streamd', 'dockerfiles/acpd'] },
  {
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
    ],
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.json', './packages/frontend/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [RELATIVE_PARENT] },
      ],
      'no-restricted-syntax': ['error', 'ImportExpression'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'avoidEscape' }],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/no-trailing-spaces': ['error'],
      '@stylistic/arrow-parens': ['error', 'always'],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // Packages never import apps. (Covers test-utils and any package without a
  // stricter zone below; server/auth-daemon/shared/cli override this.)
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            {
              group: ['@yaac/cli', '@yaac/cli/*', '@yaac/frontend', '@yaac/frontend/*'],
              message: 'Packages must not import apps (@yaac/cli, @yaac/frontend).',
            },
          ],
        },
      ],
    },
  },

  // server and auth-daemon: only @yaac/shared (+ self via #). They must never
  // import each other — anything they share lives in @yaac/shared. The
  // database is records' alone (the zone below re-opens it for records and
  // the db platform itself).
  {
    files: ['packages/server/src/**/*.ts', 'packages/auth-daemon/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            NO_DATABASE_DIRECT,
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              message: 'This package may only import @yaac/shared (use "#…" for its own modules).',
            },
          ],
        },
      ],
    },
  },

  // The one layer allowed to open the database — it owns the handle and the
  // schema outright. Later than the base zone on purpose — flat-config rule
  // options replace rather than merge, so this re-states every pattern minus
  // the database ban.
  //
  // Rows are the vocabulary here, and nothing else supplies it: a runtime
  // observation becomes a row only by arriving as a `WorktreeEvent`, how a
  // row combines with one is a mediator's call, and a column that names a
  // place on disk holds the store's own portable form (project-relative) —
  // resolving it takes layout knowledge this layer has no business holding.
  // So records reaches nothing sideways and nothing above.
  {
    files: ['packages/server/src/records/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            NO_API_OR_MAIN,
            {
              regex: '^(#domain|#runtime|#store)(/|$)',
              message: 'The records layer must not import the store, the runtime, or the mediators above it (docs/layered-server.md).',
            },
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              message: 'This package may only import @yaac/shared (use "#…" for its own modules).',
            },
          ],
        },
      ],
    },
  },

  // The store layer: worktrees, clones, transcripts and config on disk
  // (docs/layered-server.md). Pure disk mechanics — it never reads
  // rows, never touches the substrate, and never imports the mediators or
  // the runtime above it.
  {
    files: ['packages/server/src/store/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            NO_DATABASE_DIRECT,
            NO_API_OR_MAIN,
            {
              regex: '^(#records|#domain|#runtime)(/|$)',
              message: 'The store layer must not import records, the runtime, or the mediators above it (docs/layered-server.md).',
            },
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              message: 'This package may only import @yaac/shared (use "#…" for its own modules).',
            },
          ],
        },
      ],
    },
  },

  // The runtime layer: how agents run (docs/layered-server.md). It
  // never reads rows — an observed fact leaves as a `WorktreeEvent` from a
  // mediator above it — and never imports the mediators themselves.
  {
    files: ['packages/server/src/runtime/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            NO_DATABASE_DIRECT,
            NO_API_OR_MAIN,
            {
              regex: '^(#records|#domain)(/|$)',
              message: 'The runtime layer must not import records or the mediators above it (docs/layered-server.md).',
            },
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              message: 'This package may only import @yaac/shared (use "#…" for its own modules).',
            },
          ],
        },
      ],
    },
  },

  // The domain layer: the mediators. They read records, drive the store
  // and the runtime, and apply what those report — but never reach up into
  // the api surface or the composition root.
  {
    files: ['packages/server/src/domain/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            NO_DATABASE_DIRECT,
            NO_API_OR_MAIN,
            NO_SUBSTRATE_ABOVE_RUNTIME,
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              message: 'This package may only import @yaac/shared (use "#…" for its own modules).',
            },
          ],
        },
      ],
    },
  },

  // The not-yet-migrated half of the runtime carve-out
  // (docs/plans/runtime-contract-completion.md). Each of these still names a
  // substrate barrel; the plan's stages empty the list, and the override
  // below is deleted with the last entry. A new domain file is born
  // restricted, because it is not on it.
  //
  // Everything except the rule under migration still applies here — this
  // re-declares the domain zone minus NO_SUBSTRATE_ABOVE_RUNTIME.
  {
    files: [
      // stage 5 — launch
      'packages/server/src/domain/worktrees/create.ts',
      'packages/server/src/domain/worktrees/spawn-script.ts',
      'packages/server/src/domain/skills/builtin.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            NO_DATABASE_DIRECT,
            NO_API_OR_MAIN,
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              message: 'This package may only import @yaac/shared (use "#…" for its own modules).',
            },
          ],
        },
      ],
    },
  },

  // shared: no VALUE imports from other workspace packages; type-only is fine
  // (e.g. the Hono AppType from @yaac/server).
  {
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              allowTypeImports: true,
              message: '@yaac/shared may only type-import from other workspace packages.',
            },
          ],
        },
      ],
    },
  },

  // frontend: only @yaac/shared (+ self via #).
  {
    files: ['packages/frontend/src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              message: 'packages/frontend may only depend on @yaac/shared.',
            },
          ],
        },
      ],
    },
  },

  // The mobile shell's intent/effect split (docs/mobile-layout.md). Which
  // screen shows moves only on a user action, so App's own effects — the
  // project recovery and the pane auto-select — go through variants that
  // deliberately don't navigate. Those variants exist for exactly one caller
  // each; reaching for one from a component (or a new effect anywhere else)
  // would fling the user past the list they were looking at, which is the bug
  // the whole design exists to prevent. Keep it a conscious rule edit rather
  // than an autocomplete accident.
  //
  // Re-states ImportExpression: this zone redeclares no-restricted-syntax, and
  // a redeclaration replaces the base rule's options wholesale.
  {
    files: ['packages/frontend/src/**/*.{ts,tsx}'],
    ignores: ['packages/frontend/src/App.tsx', 'packages/frontend/src/store.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        'ImportExpression',
        {
          selector: "Identifier[name='autoSelectWorktree'], Identifier[name='restoreActiveProject']",
          message: 'autoSelectWorktree/restoreActiveProject are App\'s effect-side actions. Anything a user '
            + 'taps must use selectWorktree/setActiveProject so the mobile shell navigates with it '
            + '(docs/mobile-layout.md).',
        },
      ],
    },
  },

  // desktop (Electron main): only @yaac/shared (+ self via #). Talking to
  // the server goes through the shared typed client, same as the CLI; the
  // window's content is the SPA served by the server, so nothing here may
  // reach into @yaac/frontend or @yaac/server.
  {
    files: ['packages/desktop/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              message: 'packages/desktop may only depend on @yaac/shared.',
            },
          ],
        },
      ],
    },
  },

  // cli app: may wire server + auth-daemon + shared, but never the frontend.
  {
    files: ['packages/cli/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            { group: ['@yaac/frontend', '@yaac/frontend/*'], message: '@yaac/cli must not import @yaac/frontend.' },
          ],
        },
      ],
    },
  },

  // commands: thin RPC/presentation. Only sibling commands (#commands/…),
  // @yaac/shared, and the four sanctioned host-side modules — exec
  // (platform/k8s/exec, attaches/streams via `kubectl exec -it`) and cluster
  // check/setup/delete (runtime/k8s/cluster/*, run before any server
  // exists). The negation chain re-includes each parent dir (gitignore
  // semantics: a leaf can't be un-ignored while its parent is).
  {
    files: ['packages/cli/src/commands/**/*'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            {
              group: [
                '@yaac/*',
                '!@yaac/shared', '!@yaac/shared/*',
                '!@yaac/server', '@yaac/server/*',
                '!@yaac/server/platform', '@yaac/server/platform/*',
                '!@yaac/server/platform/k8s', '@yaac/server/platform/k8s/*',
                '!@yaac/server/platform/k8s/exec',
                '!@yaac/server/runtime', '@yaac/server/runtime/*',
                '!@yaac/server/runtime/k8s', '@yaac/server/runtime/k8s/*',
                '!@yaac/server/runtime/k8s/cluster', '@yaac/server/runtime/k8s/cluster/*',
                '!@yaac/server/runtime/k8s/cluster/check',
                '!@yaac/server/runtime/k8s/cluster/setup',
                '!@yaac/server/runtime/k8s/cluster/delete',
              ],
              message: 'commands may only import #commands/…, @yaac/shared, and @yaac/server/{platform/k8s/exec,runtime/k8s/cluster/{check,setup,delete}}.',
            },
          ],
        },
      ],
    },
  },

  // process.env may only be read in @yaac/shared's env.ts, which centralizes
  // every yaac variable's default and validation. Sanctioned reads elsewhere
  // carry an inline `eslint-disable-next-line no-process-env`.
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    rules: { 'no-process-env': 'error' },
  },
  {
    files: ['packages/shared/src/env.ts'],
    rules: { 'no-process-env': 'off' },
  },
  // test-utils is test infrastructure (the former test/helpers) and reads
  // process.env directly to shape the test environment.
  {
    files: ['packages/test-utils/**/*.ts'],
    rules: { 'no-process-env': 'off' },
  },
)
