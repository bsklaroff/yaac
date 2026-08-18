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
// specifier — `#domain/<name>`, `#http`, `#drivers/k8s/images` — in the package's
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
  regex: '^#(domain/(auth|git|images|projects|skills|titles|worktrees)|db|runtime/(agents|ports|status|terminals)|drivers/(shared|k8s/(cluster|container|egress|forwarders|image-engine|images|install|substrate|view|worktrees))|http)/.',
  message: 'This folder is sealed; import its barrel (e.g. #drivers/k8s/images).',
}

// The database drivers themselves, banned everywhere but db. The handle
// and the schema are db's own internal modules (`db/client.ts`,
// `db/schema.ts`) rather than a specifier any layer could name, so this
// is all that is left to ban: rows live behind the db barrel, and
// observed facts enter through `applyWorktreeEvent` rather than through a
// caller-side write (docs/layered-server.md). Reaching the tables from
// outside would take a deep `#db/schema` import, which SEALED_FOLDERS
// already refuses in src.
const NO_DATABASE_DIRECT = {
  regex: '^(@electric-sql/pglite|drizzle-orm)(/|$)',
  message: 'Only #db opens the database (docs/layered-server.md): read or write rows through its barrel.',
}

// Lower layers know nothing about the ones above them — not the HTTP
// layer, not the routes, not the startup. `#notify` and `#log` stay
// importable from every layer: both are zero-dependency outbound channels,
// and a change notification is not a dependency on the hub that consumes
// it.
// Nothing above a driver names one: every layer over it — api, the
// mediators, the machinery — reaches the runtime through
// `#drivers/driver` (the registered instance) and `#drivers/contract` (its
// vocabulary). `#runtime/*` stays open to them too: that is driver-neutral
// machinery, not substrate verbs.
//
// The machinery is on it too, which is what makes the mediators' module
// graph genuinely cluster-free: `#runtime/agents` used to bind the stream
// relay directly (podExec, dialCtrlStream), so any mediator importing it
// still loaded the cluster client transitively. The transport is on the
// contract now (exec, dialCtrl, dialPty, reviveStatusStream), so nothing
// above a driver folder reaches one.
const NO_DRIVER_ABOVE_CONTRACT = {
  regex: '^#drivers/(k8s|containerless|shared)(/|$)',
  message: 'Reach the runtime through #drivers/driver and #drivers/contract, never a concrete driver (docs/layered-server.md).',
}

// A driver's ONE door. `#drivers/k8s` and `#drivers/containerless` are the
// assembly barrels and only the composition root names them; everything
// past one — substrate, cluster, egress, images; or the host driver's own
// modules — is internal to the folder and importable only from inside
// `drivers/`. Distinct from SEALED_FOLDERS, which stops a caller reaching
// past ONE of those barrels: this stops it naming them at all.
const NO_DRIVER_INTERNALS = {
  regex: '^#drivers/(k8s|containerless)/.',
  message: 'A driver has one door: #drivers/k8s or #drivers/containerless. Its modules are internal (docs/layered-server.md).',
}

// The install feature is the one part of the driver the server never
// enters: it administers the substrate from the machine running the CLI,
// before any server exists. Nothing under src/ may import it — not the
// layers above the driver (NO_DRIVER_INTERNALS already refuses those), and
// not the driver's own folders, which is what this adds. A cluster module
// that reached back into it would put the server on a path that needs a
// container engine, which is exactly the property the split protects
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
  // database is db's alone (the zone below re-opens it for db).
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

  // The one layer allowed to open the database — it owns the handle and the
  // schema outright. Later than the base zone on purpose — flat-config rule
  // options replace rather than merge, so this re-states every pattern minus
  // the database ban.
  //
  // Rows are the vocabulary here, and nothing else supplies it: a runtime
  // observation becomes a row only by arriving as a `WorktreeEvent`, how a
  // row combines with one is a mediator's call, and a column that names a
  // place on disk holds a portable form (project-relative) — resolving it
  // takes layout knowledge this layer has no business holding.
  // So db reaches nothing sideways and nothing above.
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

  // src/lib: the server's own dependency-free vocabulary — modules every
  // layer may name and that name nothing back (docs/layered-server.md). A
  // sink in the module graph, which is what lets domain, runtime and api
  // all import one without any of them acquiring the others' weight. Kept
  // out of @yaac/shared deliberately: nothing outside this package reads
  // these, and shared is for cross-PACKAGE vocabulary.
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
            // "Dependency-free" means third-party too, not just this package's
            // own modules. Without this, the zone above would happily let a lib
            // module import @kubernetes/client-node — and lib is imported by
            // every layer, so that one edge would put the cluster client back
            // into the module graph of mediators the contract just got it out
            // of. It is also what keeps the stage-7 answer for `platform/git.ts`
            // honest: git wraps the `simple-git` dep, so lib is not a legal
            // home for it and the rule says so rather than the plan alone.
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


  // The runtime layer: the driver-neutral machinery — how agent sessions
  // are conducted, observed and attached to, over WHICHEVER driver is
  // registered (docs/layered-server.md). It reaches the substrate the same
  // way a mediator does, through `#drivers/contract` (its vocabulary,
  // including the stream types and the exec verdict) and `#drivers/driver`
  // (the registered instance); that is what lets a second driver inherit
  // the whole of it. It never reads rows — an observed fact leaves as a
  // `WorktreeEvent` from a mediator above it — and never imports the
  // mediators themselves.
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

  // The drivers: one folder per substrate, each implementing the contract.
  // Everything a driver may name is BELOW it — its own contract, the
  // dependency-free lib, and the two arrow-exempt outbound channels. The
  // machinery that runs over it (`#runtime/*`) is deliberately out of
  // reach: state a driver step needs from it is handed down through
  // `PassContext`, never imported up, which is what keeps the arrow one-way
  // and lets a second driver be written without reading the first.
  //
  // One zone per driver rather than one for both, so each can be told not to
  // name the OTHER. A driver cannot see its siblings — that is what makes a
  // second one writable without reading the first, and what forces anything
  // genuinely common down into `#drivers/shared`. Without the split the ban
  // is unstatable: every rule here is shared, and a driver must be able to
  // name its own folders.
  ...['k8s', 'containerless'].map((kind) => ({
    // The install folder is excluded, not exempted: it is the one part of a
    // driver the server never enters, and it is bound by MORE than this
    // zone allows (it may name #drivers/k8s/cluster, which a sibling folder
    // may not) — its own zone below states that.
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
            // The specifier ban above is anchored on `#drivers/…`, and a
            // file at the driver ROOT sits in the same directory as the
            // folder — so `./install/x` would reach it without ever naming
            // the specifier. That is the likeliest accidental route into
            // the one folder the server must not enter, and the assembly
            // (index.ts, steps.ts, lifecycle.ts) is exactly what lives
            // there. The zone's `ignores` exempts install/ itself.
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

  // The k8s driver's install feature: the substrate administration the CLI
  // runs and the server never does. Its own zone because it is bound
  // differently in both directions — it MAY name `#drivers/k8s/cluster`
  // (each shipped image's identity, and the in-cluster layers both sides
  // ensure), which no other folder of a driver may name of a sibling; and
  // it must still never reach above the contract. Nothing reads back: the
  // driver zone above bans `#drivers/k8s/install` outright, which is what
  // keeps a container engine off every path the server takes.
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

  // What the drivers share with each other and with nothing else
  // (`#drivers/shared`). Its own zone rather than the driver zone above,
  // because it is bound by one rule more than a driver is: it may not
  // import a driver. That is the whole point of the folder — the arrow
  // runs driver → shared and never back, so this can be a floor both
  // substrates stand on rather than a channel between them.
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

  // The seam itself: the contract and the registry that holds one
  // implementation of it. These two files import NOTHING but shared types
  // — that is what makes the seam a seam wherever it sits, and what a
  // reader can rely on: a contract that can import nothing cannot quietly
  // grow a dependency on the substrate it exists to hide, and a mediator
  // reaching the runtime through it pulls no cluster code into its module
  // graph.
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
            // Third-party too, and this is the one that matters most: the
            // whole guarantee is that the contract cannot grow a dependency
            // on the substrate it exists to hide, and `@kubernetes/client-node`
            // is a bare specifier the pattern above does not see. Same shape
            // as the lib zone's.
            {
              regex: '^(?!node:|@yaac/shared)[@a-zA-Z]',
              message: 'The driver seam imports nothing but @yaac/shared and node builtins (docs/layered-server.md).',
            },
          ],
        },
      ],
    },
  },

  // The api layer: routes, the HTTP plumbing and the snapshot hub. It sits
  // over the mediators, and reaches the runtime on the same terms they and
  // the machinery do — `#drivers/driver` and `#drivers/contract`, never a
  // concrete driver. What it may NOT do is name `#drivers/k8s`, which is
  // what keeps every substrate word out of a route.
  //
  // Api holding the accessor is not a licence to put policy in a route: a
  // read that resolves a worktree, decides something and then acts is a
  // mediator's, and lives in `#domain`. What belongs here is the other
  // kind — a display value the runtime already holds, asked for once and
  // rendered. The line is composition, not layer, and no lint rule can see
  // it; a wrapper that only forwards its arguments is worse than the call
  // it hides.
  //
  // It cannot take NO_API_OR_MAIN — `#routes` and `#http` are its own.
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

  // The composition root. It is the ONE place that knows which driver this
  // process runs — but it names the assembly and nothing under it: a
  // driver's folders are its own.
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

  // The domain layer: the mediators. They read db, drive the runtime, own
  // what a project and a worktree keep on disk, and apply what the runtime
  // reports — but never reach up into the api surface or the composition
  // root.
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

  // The mobile shell's intent/effect split (docs/mobile-layout.md). Which
  // screen shows moves only on a user action, so App's own effects — the
  // project recovery and the pane auto-select — go through variants that
  // deliberately don't navigate. Those variants exist for exactly one caller
  // each; reaching for one from a component (or a new effect anywhere else)
  // would fling the user past the list they were looking at, which is the bug
  // the whole design exists to prevent. Keep it a conscious rule edit rather
  // than an autocomplete accident.
  //
  // The delete flow is the third caller: deleting the open worktree hands the
  // selection to the row below it, which fills the pane the delete emptied
  // without walking a phone off the list the × was tapped on.
  //
  // Re-states ImportExpression: this zone redeclares no-restricted-syntax, and
  // a redeclaration replaces the base rule's options wholesale.
  {
    files: ['packages/frontend/src/**/*.{ts,tsx}'],
    ignores: [
      'packages/frontend/src/App.tsx',
      'packages/frontend/src/store.ts',
      'packages/frontend/src/lib/stopWorktreeFlow.ts',
    ],
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
  // @yaac/shared, and the sanctioned host-side modules — exec
  // (drivers/k8s/substrate/exec, attaches/streams via `kubectl exec -it`),
  // the k8s driver's install door (drivers/k8s/install — cluster
  // check/install/delete, which run before any server exists), and the host
  // driver's own doctor (drivers/containerless/check,
  // the same door for the same reason: administering a substrate is
  // substrate-specific by nature). The negation chain re-includes each
  // parent dir (gitignore semantics: a leaf can't be un-ignored while its
  // parent is).
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
  // test-utils is test infrastructure (the former test/helpers) and reads
  // process.env directly to shape the test environment.
  {
    files: ['packages/test-utils/**/*.ts'],
    rules: { 'no-process-env': 'off' },
  },
)
