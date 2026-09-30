import globals from 'globals'
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'

const RELATIVE_PARENT = { group: ['..*'], message: 'Relative parent imports are not allowed.' }

// Paths in src must be built on a storage tier (shared / node-local /
// server-local; see packages/shared/src/paths.ts), not the raw data dir.
// Sanctioned exceptions carry an inline disable. `paths` matches exact
// specifiers, so every spelling of the path modules is listed. Every src
// zone below must include this: flat-config rule options replace rather
// than merge.
const UNTIERED_DATA_DIR = [
  '#paths', '#project-paths', './paths', './project-paths',
  '@yaac/shared/paths', '@yaac/shared/project-paths',
].map((name) => ({
  name,
  importNames: ['getDataDir'],
  message: 'Build paths on a storage tier: sharedPath/sharedProjectPath, nodeLocalProjectPath, or serverLocalPath (see the tier legend in paths.ts).',
}))

// Sealed folders expose an index.ts barrel mapped to the folder's own
// specifier (e.g. `#drivers/k8s/images`); src must import the barrel, not
// the modules behind it. Add a folder to the alternation once it has one.
// Tests are unrestricted.
//
// This is a `regex`, not a `group` glob: groups use gitignore semantics,
// where a leading `#` starts a comment and the pattern matches nothing.
const SEALED_FOLDERS = {
  regex: '^#(domain/(agent-history|auth|git|projects|skills|titles|workspaces)|db|runtime/(agents|ports|status|terminals)|drivers/(shared|k8s/(cluster|container|egress|forwarders|image-engine|images|install|substrate|workspaces))|http)/.',
  message: 'This folder is sealed; import its barrel (e.g. #drivers/k8s/images).',
}

// The database libraries, banned everywhere but db. The handle and schema
// are internal to db, and SEALED_FOLDERS already refuses deep `#db/...`
// imports (docs/layered-server.md).
const NO_DATABASE_DIRECT = {
  regex: '^(@electric-sql/pglite|drizzle-orm)(/|$)',
  message: 'Only #db opens the database (docs/layered-server.md): read or write rows through its barrel.',
}

// Layers above the drivers (api, domain, runtime) reach the runtime only
// through `#drivers/driver` (the registered instance) and
// `#drivers/contract` (its types), never a concrete driver. This keeps
// the cluster client out of their module graphs.
const NO_DRIVER_ABOVE_CONTRACT = {
  regex: '^#drivers/(k8s|containerless|shared)(/|$)',
  message: 'Reach the runtime through #drivers/driver and #drivers/contract, never a concrete driver (docs/layered-server.md).',
}

// `#drivers/k8s` and `#drivers/containerless` are each driver's only
// entry point, named only by the composition root. Their inner folders
// are importable only from inside `drivers/`.
const NO_DRIVER_INTERNALS = {
  regex: '^#drivers/(k8s|containerless)/.',
  message: 'A driver has one door: #drivers/k8s or #drivers/containerless. Its modules are internal (docs/layered-server.md).',
}

// The install feature administers the substrate from the CLI, before any
// server exists. No server module may import it, including the driver's
// own folders, so the server never needs a container engine
// (docs/trust-split-builds.md).
const NO_INSTALL_FROM_SERVER = {
  regex: '^#drivers/k8s/install(/|$)',
  message: 'Only the CLI enters #drivers/k8s/install; the server never administers its own substrate (docs/layered-server.md).',
}

const NO_API_OR_MAIN = {
  regex: '^(#main|#routes|#http|#api)(/|$)',
  message: 'Layers below api/main must not import them (docs/layered-server.md): report through #db events or #notify instead.',
}

export default tseslint.config(
  // dockerfiles/streamd and dockerfiles/acpd are plain JS outside the
  // tsconfig projects; their vitest projects (unit:streamd, unit:acpd)
  // check them instead.
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

  // server and auth-daemon: only @yaac/shared (+ self via #). Only db may
  // open the database (the next zone re-opens it).
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
            NO_INSTALL_FROM_SERVER,
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

  // db: the one layer that opens the database. It imports nothing from
  // runtime, domain, api or main. Placed after the base zone and re-states
  // every pattern except the database ban, since flat-config rule options
  // replace rather than merge.
  {
    files: ['packages/server/src/db/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            NO_DRIVER_ABOVE_CONTRACT,
            NO_INSTALL_FROM_SERVER,
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            NO_API_OR_MAIN,
            {
              regex: '^(#domain|#runtime)(/|$)',
              message: 'The db layer must not import the runtime or the mediators above it (docs/layered-server.md).',
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

  // src/lib: dependency-free helpers every server layer may import and
  // that import nothing back (docs/layered-server.md). Not in @yaac/shared
  // because no other package uses them.
  {
    files: ['packages/server/src/lib/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            NO_DRIVER_ABOVE_CONTRACT,
            NO_INSTALL_FROM_SERVER,
            RELATIVE_PARENT,
            {
              regex: '^#',
              message: 'src/lib must stay dependency-free: no other module of this package (docs/layered-server.md).',
            },
            // No third-party packages either: every layer imports lib, so
            // one edge here (e.g. @kubernetes/client-node) would reach them
            // all.
            {
              regex: '^(?!node:|@yaac/shared)[@a-zA-Z]',
              message: 'src/lib takes no third-party dependency: node builtins and @yaac/shared only (docs/layered-server.md).',
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


  // runtime: driver-neutral machinery for running, observing and attaching
  // to agent sessions (docs/layered-server.md). Reaches the substrate only
  // through `#drivers/contract` and `#drivers/driver`, and imports neither
  // db nor domain.
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
            NO_DRIVER_ABOVE_CONTRACT,
            NO_DRIVER_INTERNALS,
            {
              regex: '^(#db|#domain)(/|$)',
              message: 'The runtime layer must not import db or the mediators above it (docs/layered-server.md).',
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

  // Drivers: one folder per substrate. A driver may import the contract,
  // lib, `#notify` and `#log`, and nothing above (state it needs from
  // `#runtime/*` arrives through `PassContext`). One zone per driver so
  // each can be barred from the other; shared code goes in
  // `#drivers/shared`.
  ...['k8s', 'containerless'].map((kind) => ({
    // install/ has its own zone below.
    files: [`packages/server/src/drivers/${kind}/**/*.ts`],
    ignores: [`packages/server/src/drivers/${kind}/install/**/*.ts`],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            NO_INSTALL_FROM_SERVER,
            NO_DATABASE_DIRECT,
            NO_API_OR_MAIN,
            {
              regex: `^#drivers/${kind === 'k8s' ? 'containerless' : 'k8s'}(/|$)`,
              message: 'A driver cannot see its siblings: put what both need in #drivers/shared (docs/layered-server.md).',
            },
            // Files at the driver root could reach install/ by relative
            // path without naming `#drivers/k8s/install`.
            {
              regex: '^\\./install(/|$)',
              message: 'Only the CLI enters the install feature; reach nothing of it from the driver (docs/layered-server.md).',
            },
            {
              regex: '^(#db|#domain|#runtime)(/|$)',
              message: 'A driver names nothing above its contract: no db, no mediators, no machinery (docs/layered-server.md).',
            },
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              message: 'This package may only import @yaac/shared (use "#…" for its own modules).',
            },
          ],
        },
      ],
    },
  })),

  // The k8s install feature (CLI only). Unlike the other driver folders it
  // may import `#drivers/k8s/cluster`, but still nothing above the
  // contract.
  {
    files: ['packages/server/src/drivers/k8s/install/**/*.ts'],
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
              regex: '^#drivers/containerless(/|$)',
              message: 'A driver cannot see its siblings: put what both need in #drivers/shared (docs/layered-server.md).',
            },
            {
              regex: '^(#db|#domain|#runtime)(/|$)',
              message: 'A driver names nothing above its contract: no db, no mediators, no machinery (docs/layered-server.md).',
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

  // `#drivers/shared`: code both drivers use. Same rules as a driver,
  // plus it may not import either driver.
  {
    files: ['packages/server/src/drivers/shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            NO_DATABASE_DIRECT,
            NO_API_OR_MAIN,
            {
              regex: '^#drivers/(k8s|containerless)(/|$)',
              message: 'The drivers\' shared floor may not import a driver — the arrow runs driver → shared (docs/layered-server.md).',
            },
            {
              regex: '^(#db|#domain|#runtime)(/|$)',
              message: 'A driver names nothing above its contract: no db, no mediators, no machinery (docs/layered-server.md).',
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

  // The contract and the driver registry import nothing but shared types,
  // so code that uses them pulls in no substrate code.
  {
    files: [
      'packages/server/src/drivers/contract.ts',
      'packages/server/src/drivers/driver.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            {
              regex: '^(#|@yaac/(?!shared))',
              message: 'The driver seam imports nothing but @yaac/shared and node builtins (docs/layered-server.md).',
            },
            // No third-party packages either (e.g.
            // `@kubernetes/client-node`), as in the lib zone.
            {
              regex: '^(?!node:|@yaac/shared)[@a-zA-Z]',
              message: 'The driver seam imports nothing but @yaac/shared and node builtins (docs/layered-server.md).',
            },
          ],
        },
      ],
    },
  },

  // api: routes, HTTP plumbing and the snapshot hub. Reaches the runtime
  // through `#drivers/driver` and `#drivers/contract`, never a concrete
  // driver. Logic that resolves, decides and acts still belongs in
  // `#domain` (docs/layered-server.md). Omits NO_API_OR_MAIN because
  // `#routes` and `#http` are its own.
  {
    files: ['packages/server/src/api/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            NO_DATABASE_DIRECT,
            NO_DRIVER_ABOVE_CONTRACT,
            NO_DRIVER_INTERNALS,
            {
              regex: '^#main(/|$)',
              message: 'The composition root is above api (docs/layered-server.md).',
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

  // main: the composition root, the only layer that names a driver, and
  // only through its top-level barrel.
  {
    files: ['packages/server/src/main/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: UNTIERED_DATA_DIR,
          patterns: [
            RELATIVE_PARENT,
            SEALED_FOLDERS,
            NO_DATABASE_DIRECT,
            NO_DRIVER_INTERNALS,
            {
              group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
              message: 'This package may only import @yaac/shared (use "#…" for its own modules).',
            },
          ],
        },
      ],
    },
  },

  // domain: the mediators. May use db and the runtime, never api or main.
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
            NO_DRIVER_ABOVE_CONTRACT,
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

  // The mobile shell only changes screens on a user action
  // (docs/mobile-layout.md). The non-navigating selection variants are
  // reserved for App's effects and the delete flow (the ignored files);
  // using one elsewhere could move a phone user off the list they are on.
  //
  // Re-states ImportExpression: redeclaring no-restricted-syntax replaces
  // the base rule's options.
  {
    files: ['packages/frontend/src/**/*.{ts,tsx}'],
    ignores: [
      'packages/frontend/src/App.tsx',
      'packages/frontend/src/lib/store.ts',
      'packages/frontend/src/lib/stopWorkspaceFlow.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        'ImportExpression',
        {
          selector: "Identifier[name='autoSelectWorkspace'], Identifier[name='restoreActiveProject']",
          message: 'autoSelectWorkspace/restoreActiveProject are App\'s effect-side actions. Anything a user '
            + 'taps must use selectWorkspace/setActiveProject so the mobile shell navigates with it '
            + '(docs/mobile-layout.md).',
        },
      ],
    },
  },

  // desktop (Electron main): only @yaac/shared (+ self via #). The window
  // shows the SPA the server serves.
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

  // commands: thin RPC/presentation. They may import sibling commands,
  // @yaac/shared, and three host-side server modules: k8s substrate/exec
  // (`kubectl exec -it` streams), k8s/install (cluster administration,
  // which runs before any server exists), and containerless/check. The
  // negation chain re-includes each parent dir, since gitignore semantics
  // can't un-ignore a file inside an ignored directory.
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
                '!@yaac/server/drivers', '@yaac/server/drivers/*',
                '!@yaac/server/drivers/k8s', '@yaac/server/drivers/k8s/*',
                '!@yaac/server/drivers/k8s/substrate', '@yaac/server/drivers/k8s/substrate/*',
                '!@yaac/server/drivers/k8s/substrate/exec',
                '!@yaac/server/drivers/k8s/install',
                '!@yaac/server/drivers/containerless', '@yaac/server/drivers/containerless/*',
                '!@yaac/server/drivers/containerless/check',
              ],
              message: 'commands may only import #commands/…, @yaac/shared, and @yaac/server/drivers/{k8s/{substrate/exec,install},containerless/check}.',
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
  // test-utils is test infrastructure and reads process.env directly.
  {
    files: ['packages/test-utils/**/*.ts'],
    rules: { 'no-process-env': 'off' },
  },
)
