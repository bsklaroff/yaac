import globals from 'globals'
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'

const RELATIVE_PARENT = { group: ['..*'], message: 'Relative parent imports are not allowed.' }

// Paths in src must be built on a storage tier (shared / node-local /
// server-local; see packages/shared/src/paths.ts), not the raw data dir.
// Sanctioned exceptions carry an inline disable. `paths` matches exact
// specifiers, so every spelling of the path modules is listed. `zone()`
// adds it to every src zone.
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
  regex: '^#(domain/(access|auth|cloud-identity|git|projects|skills|workspaces)|db|runtime/(agents|status|terminals|usage)|drivers/k8s/(cluster|egress|images|install|substrate|workspaces))/.',
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
  regex: '^#drivers/(k8s|containerless)(/|$)',
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
  regex: '^(#main|#routes|#api)(/|$)',
  message: 'Layers below api/main must not import them (docs/layered-server.md): report through #db events or #lib/notify instead.',
}

// The one workspace package src may import, for every package but the apps.
const ONLY_SHARED = {
  group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*'],
  message: 'This package may only import @yaac/shared (use "#…" for its own modules).',
}

// A driver names nothing above its contract (state it needs arrives through
// `PassContext`).
const NO_DRIVER_ABOVE_LAYERS = {
  regex: '^(#db|#domain|#runtime)(/|$)',
  message: 'A driver names nothing above its contract: no db, no mediators, no machinery (docs/layered-server.md).',
}

// One import-restriction zone. Flat-config rule options replace rather than
// merge, so each zone restates the base rules: relative parent imports and
// untiered data-dir paths are banned everywhere.
function zone(files, patterns, extra = {}) {
  return {
    files,
    ...extra,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { paths: UNTIERED_DATA_DIR, patterns: [RELATIVE_PARENT, ...patterns] },
      ],
    },
  }
}

export default tseslint.config(
  // dockerfiles/streamd, acpd and agent-patches are plain JS outside the
  // tsconfig projects; their vitest projects (unit:streamd, unit:acpd,
  // unit:agent-patches) check them instead.
  { ignores: ['dist', 'dist-test', 'packages/*/dist', 'packages/desktop/dist-app', 'packages/desktop/staging', 'dockerfiles/streamd', 'dockerfiles/acpd', 'dockerfiles/agent-patches'] },
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
      // A caught error is unknown; passing it on to reject() is as fine as rethrowing it.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true }],
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
  zone(['packages/*/src/**/*.ts'], [
    {
      group: ['@yaac/cli', '@yaac/cli/*', '@yaac/frontend', '@yaac/frontend/*'],
      message: 'Packages must not import apps (@yaac/cli, @yaac/frontend).',
    },
  ]),

  // server and auth-daemon: only @yaac/shared (+ self via #). Only db may
  // open the database (the next zone re-opens it).
  zone(['packages/server/src/**/*.ts', 'packages/auth-daemon/src/**/*.ts'], [
    SEALED_FOLDERS, NO_INSTALL_FROM_SERVER, NO_DATABASE_DIRECT, ONLY_SHARED,
  ]),

  // db: the one layer that opens the database. It imports nothing from
  // runtime, domain, api or main.
  zone(['packages/server/src/db/**/*.ts'], [
    NO_DRIVER_ABOVE_CONTRACT, NO_INSTALL_FROM_SERVER, SEALED_FOLDERS, NO_API_OR_MAIN, ONLY_SHARED,
    {
      regex: '^(#domain|#runtime)(/|$)',
      message: 'The db layer must not import the runtime or the mediators above it (docs/layered-server.md).',
    },
  ]),

  // src/lib: dependency-free helpers every server layer may import and
  // that import nothing back (docs/layered-server.md). Not in @yaac/shared
  // because no other package uses them.
  zone(['packages/server/src/lib/**/*.ts'], [
    NO_DRIVER_ABOVE_CONTRACT, NO_INSTALL_FROM_SERVER, ONLY_SHARED,
    {
      regex: '^#',
      message: 'src/lib must stay dependency-free: no other module of this package (docs/layered-server.md).',
    },
    // No third-party packages either: every layer imports lib, so one edge
    // here (e.g. @kubernetes/client-node) would reach them all.
    {
      regex: '^(?!node:|@yaac/shared)[@a-zA-Z]',
      message: 'src/lib takes no third-party dependency: node builtins and @yaac/shared only (docs/layered-server.md).',
    },
  ]),

  // runtime: driver-neutral machinery for running, observing and attaching
  // to agent sessions (docs/layered-server.md). Reaches the substrate only
  // through `#drivers/contract` and `#drivers/driver`, and imports neither
  // db nor domain.
  zone(['packages/server/src/runtime/**/*.ts'], [
    SEALED_FOLDERS, NO_DATABASE_DIRECT, NO_API_OR_MAIN, NO_DRIVER_ABOVE_CONTRACT, NO_DRIVER_INTERNALS,
    ONLY_SHARED,
    {
      regex: '^(#db|#domain)(/|$)',
      message: 'The runtime layer must not import db or the mediators above it (docs/layered-server.md).',
    },
  ]),

  // Drivers: one folder per substrate. A driver may import the contract
  // and lib, and nothing above (state it needs from `#runtime/*` arrives
  // through `PassContext`). One zone per driver so each can be barred from
  // the other; install/ has its own zone below.
  ...['k8s', 'containerless'].map((kind) => zone([`packages/server/src/drivers/${kind}/**/*.ts`], [
    SEALED_FOLDERS, NO_INSTALL_FROM_SERVER, NO_DATABASE_DIRECT, NO_API_OR_MAIN, NO_DRIVER_ABOVE_LAYERS,
    ONLY_SHARED,
    {
      regex: `^#drivers/${kind === 'k8s' ? 'containerless' : 'k8s'}(/|$)`,
      message: 'A driver cannot see its siblings (docs/layered-server.md).',
    },
    // Files at the driver root could reach install/ by relative path
    // without naming `#drivers/k8s/install`.
    {
      regex: '^\\./install(/|$)',
      message: 'Only the CLI enters the install feature; reach nothing of it from the driver (docs/layered-server.md).',
    },
  ], { ignores: [`packages/server/src/drivers/${kind}/install/**/*.ts`] })),

  // The k8s install feature (CLI only). Unlike the other driver folders it
  // may import `#drivers/k8s/cluster`, but still nothing above the
  // contract.
  zone(['packages/server/src/drivers/k8s/install/**/*.ts'], [
    SEALED_FOLDERS, NO_DATABASE_DIRECT, NO_API_OR_MAIN, NO_DRIVER_ABOVE_LAYERS, ONLY_SHARED,
    {
      regex: '^#drivers/containerless(/|$)',
      message: 'A driver cannot see its siblings (docs/layered-server.md).',
    },
  ]),

  // The contract and the driver registry import nothing but shared types,
  // so code that uses them pulls in no substrate code. No third-party
  // packages either (e.g. `@kubernetes/client-node`), as in the lib zone.
  zone(['packages/server/src/drivers/contract.ts', 'packages/server/src/drivers/driver.ts'], [
    {
      regex: '^(#|@yaac/(?!shared))',
      message: 'The driver seam imports nothing but @yaac/shared and node builtins (docs/layered-server.md).',
    },
    {
      regex: '^(?!node:|@yaac/shared)[@a-zA-Z]',
      message: 'The driver seam imports nothing but @yaac/shared and node builtins (docs/layered-server.md).',
    },
  ]),

  // api: routes, HTTP plumbing and the snapshot hub. Reaches the runtime
  // through `#drivers/driver` and `#drivers/contract`, never a concrete
  // driver. Logic that resolves, decides and acts still belongs in
  // `#domain` (docs/layered-server.md). Omits NO_API_OR_MAIN because
  // `#routes` and `#api` are its own.
  zone(['packages/server/src/api/**/*.ts'], [
    SEALED_FOLDERS, NO_DATABASE_DIRECT, NO_DRIVER_ABOVE_CONTRACT, NO_DRIVER_INTERNALS, ONLY_SHARED,
    { regex: '^#main(/|$)', message: 'The composition root is above api (docs/layered-server.md).' },
  ]),

  // main: the composition root, the only layer that names a driver, and
  // only through its top-level barrel.
  zone(['packages/server/src/main/**/*.ts'], [
    SEALED_FOLDERS, NO_DATABASE_DIRECT, NO_DRIVER_INTERNALS, ONLY_SHARED,
  ]),

  // domain: the mediators. May use db and the runtime, never api or main.
  zone(['packages/server/src/domain/**/*.ts'], [
    SEALED_FOLDERS, NO_DATABASE_DIRECT, NO_API_OR_MAIN, NO_DRIVER_ABOVE_CONTRACT, ONLY_SHARED,
  ]),

  // shared: no VALUE imports from other workspace packages; type-only is fine
  // (e.g. the Hono AppType from @yaac/server).
  zone(['packages/shared/src/**/*.ts'], [
    { ...ONLY_SHARED, allowTypeImports: true, message: '@yaac/shared may only type-import from other workspace packages.' },
  ]),

  // frontend: only @yaac/shared (+ self via #).
  zone(['packages/frontend/src/**/*.{ts,tsx}'], [
    { ...ONLY_SHARED, message: 'packages/frontend may only depend on @yaac/shared.' },
  ]),

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

  // desktop (Electron main): only @yaac/shared and the auth daemon it bundles
  // (+ self via #). The window shows the SPA the server serves.
  zone(['packages/desktop/src/**/*.ts'], [
    {
      group: ['@yaac/*', '!@yaac/shared', '!@yaac/shared/*', '!@yaac/auth-daemon', '!@yaac/auth-daemon/*'],
      message: 'packages/desktop may only depend on @yaac/shared and @yaac/auth-daemon.',
    },
  ]),

  // cli app: may wire server + auth-daemon + shared, but never the frontend.
  zone(['packages/cli/src/**/*.ts'], [
    { group: ['@yaac/frontend', '@yaac/frontend/*'], message: '@yaac/cli must not import @yaac/frontend.' },
  ]),

  // commands: thin RPC/presentation. They may import sibling commands,
  // @yaac/shared, the auth daemon's tool-login (`yaac auth update` signs in
  // in-process), and three host-side server modules: k8s substrate/exec
  // (`kubectl exec -it` streams), k8s/install (cluster administration,
  // which runs before any server exists), and containerless/check. The
  // negation chain re-includes each parent dir, since gitignore semantics
  // can't un-ignore a file inside an ignored directory.
  zone(['packages/cli/src/commands/**/*'], [
    {
      group: [
        '@yaac/*',
        '!@yaac/shared', '!@yaac/shared/*',
        '!@yaac/auth-daemon', '@yaac/auth-daemon/*', '!@yaac/auth-daemon/tool-login',
        '!@yaac/server', '@yaac/server/*',
        '!@yaac/server/drivers', '@yaac/server/drivers/*',
        '!@yaac/server/drivers/k8s', '@yaac/server/drivers/k8s/*',
        '!@yaac/server/drivers/k8s/substrate', '@yaac/server/drivers/k8s/substrate/*',
        '!@yaac/server/drivers/k8s/substrate/exec',
        '!@yaac/server/drivers/k8s/install',
        '!@yaac/server/drivers/containerless', '@yaac/server/drivers/containerless/*',
        '!@yaac/server/drivers/containerless/check',
      ],
      message: 'commands may only import #commands/…, @yaac/shared, @yaac/auth-daemon/tool-login, and @yaac/server/drivers/{k8s/{substrate/exec,install},containerless/check}.',
    },
  ]),

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
