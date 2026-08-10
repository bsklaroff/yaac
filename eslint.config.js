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
  regex: '^#(features/(agents|auth|cluster|egress|forwarders|image-engine|images|projects|records|skills|status|terminals|titles|worktrees)|http|platform/(container|db|k8s))/.',
  message: 'This folder is sealed; import its barrel (e.g. #features/images).',
}

// Everything that touches the cluster, a git worktree, a transcript or tmux
// — the future `runtime/` and `store/` layers (docs/plans/layered-server.md).
// Code here never imports the api/main layers; observed facts it discovers
// enter records through `applyHerdEvent`, not caller-side writes. This path
// list is interim — it retires as the layer carve replaces it with
// per-layer globs.
const BYTES_SRC = [
  'packages/server/src/platform/container/**/*.ts',
  'packages/server/src/platform/k8s/**/*.ts',
  'packages/server/src/features/agents/**/*.ts',
  'packages/server/src/features/cluster/**/*.ts',
  'packages/server/src/features/egress/**/*.ts',
  'packages/server/src/features/forwarders/**/*.ts',
  'packages/server/src/features/image-engine/**/*.ts',
  // #features/projects: everything that touches the clone, its config
  // files, its credentials or its build context. `add`, `detail` and `list`
  // answer "which projects exist" from rows, so they stay out.
  'packages/server/src/features/projects/branches.ts',
  'packages/server/src/features/projects/build-dirs.ts',
  'packages/server/src/features/projects/build-files.ts',
  'packages/server/src/features/projects/config.ts',
  'packages/server/src/features/projects/credentials.ts',
  'packages/server/src/features/projects/dockerfile.ts',
  'packages/server/src/features/projects/fake-auth.ts',
  'packages/server/src/features/projects/git-auth-failures.ts',
  'packages/server/src/features/projects/local-config.ts',
  'packages/server/src/features/images/**/*.ts',
  'packages/server/src/features/status/**/*.ts',
  'packages/server/src/features/terminals/**/*.ts',
  // #features/worktrees: everything that acts on the substrate is named
  // here; the JOIN paths that read rows alongside an observation (list,
  // detail, resolve, restart, the stopped listing, project teardown) stay
  // out.
  'packages/server/src/features/worktrees/agent-session-registry.ts',
  'packages/server/src/features/worktrees/cleanup.ts',
  'packages/server/src/features/worktrees/create.ts',
  'packages/server/src/features/worktrees/observe.ts',
  'packages/server/src/features/worktrees/prewarm.ts',
  'packages/server/src/features/worktrees/prewarm-reconcile.ts',
  'packages/server/src/features/worktrees/changes.ts',
  'packages/server/src/features/worktrees/project-purge.ts',
  'packages/server/src/features/worktrees/prompt-capture.ts',
  'packages/server/src/features/worktrees/salvage-reconcile.ts',
  'packages/server/src/features/worktrees/seed.ts',
  'packages/server/src/features/worktrees/spare-pool.ts',
  'packages/server/src/features/worktrees/spawn-reconcile.ts',
  'packages/server/src/features/worktrees/spawn-script.ts',
  'packages/server/src/features/worktrees/locate.ts',
  'packages/server/src/features/worktrees/stale-worktrees.ts',
  'packages/server/src/features/worktrees/stop.ts',
  'packages/server/src/features/worktrees/worktree-meta.ts',
]

// A `regex` for the same reason SEALED_FOLDERS is one: a `group` glob reads
// the leading `#` as a comment and silently matches nothing. The driver
// packages are named too, so the ban cannot be walked around by opening
// PGlite directly instead of going through the barrel. `#features/records`
// is the ONE feature allowed past this: rows live behind its barrel, and
// observed facts enter it through `applyHerdEvent` rather than through a
// caller-side write (docs/plans/layered-server.md).
const NO_DATABASE_DIRECT = {
  regex: '^(#platform/db|@electric-sql/pglite|drizzle-orm)(/|$)',
  message: 'Only #features/records opens the database (docs/plans/layered-server.md): read or write rows through its barrel.',
}

// The other direction: substrate/disk code knows nothing about the layers
// above it — not the HTTP layer, not the routes, not the startup. `#notify`
// and `#log` stay importable from every layer: both are zero-dependency
// outbound channels, and a change notification is not a dependency on the
// hub that consumes it.
const NO_SERVER = {
  regex: '^(#main|#routes|#http)(/|$)',
  message: 'Substrate/disk code must not import the api/main layers (docs/plans/layered-server.md): report through #features/records events or #notify instead.',
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

  // The one feature allowed to open the database, and the db platform it
  // opens. Later than the base zone on purpose — flat-config rule options
  // replace rather than merge, so this re-states every pattern minus the
  // database ban.
  {
    files: [
      'packages/server/src/features/records/**/*.ts',
      'packages/server/src/platform/db/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              message: 'This package may only import @yaac/shared (use "#…" for its own modules).',
            },
          ],
        },
      ],
    },
  },

  // The substrate/disk half of the server (see BYTES_SRC): the zone above,
  // plus the database ban. Later than that zone on purpose — flat-config
  // rule options replace rather than merge, so this re-states every pattern
  // it inherits.
  {
    files: BYTES_SRC,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            NO_DATABASE_DIRECT,
            NO_SERVER,
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
  // check/setup/delete (features/cluster/*, run before any server exists). The
  // negation chain re-includes each parent dir (gitignore semantics: a leaf
  // can't be un-ignored while its parent is).
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
                '!@yaac/server/features', '@yaac/server/features/*',
                '!@yaac/server/features/cluster', '@yaac/server/features/cluster/*',
                '!@yaac/server/features/cluster/check',
                '!@yaac/server/features/cluster/setup',
                '!@yaac/server/features/cluster/delete',
              ],
              message: 'commands may only import #commands/…, @yaac/shared, and @yaac/server/{platform/k8s/exec,features/cluster/{check,setup,delete}}.',
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
