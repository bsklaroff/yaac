# Cheap Claude worktrees in yaac workspaces

A Claude subagent started with `isolation: "worktree"` gets a git worktree
under `<checkout>/.claude/worktrees/<name>/`. In a k8s workspace that
directory is on the NFS checkouts volume, and only the project's
`ephemeralModulesPaths` (by default the root `node_modules`) are on tmpfs.
Each subagent then runs its own `pnpm install`. pnpm cannot hardlink from
the store on tmpfs onto NFS, so it copies roughly 43k files per worktree.
Six such installs at once slow every filesystem read in the pod. The
webapp's changes poll then times out (500, after the 20s exec limit) and
reports busy (503) while the timed-out run still holds its lock. The
worktrees also appear as untracked nested repos in the changes list and
the explorer.

This plan makes worktrees cheap rather than forbidding them. Each one links
the workspace's module dirs instead of installing them, and all of them are
hidden from the main checkout's git.

## 1. Seed `worktree.symlinkDirectories` from the project's module dirs

`seedClaudeSettings` (`packages/server/src/domain/workspaces/seed.ts`) sets
`settings.worktree.symlinkDirectories` to the project's resolved
`ephemeralModulesPaths`. Claude Code's settings reference defines the value
as "directory paths relative to the repository root", the same shape as
`ephemeralModulesPaths`.

- These are the dirs yaac already puts on tmpfs, and the pod already keeps
  the pnpm store inside the root `node_modules`. A worktree then links to a
  warm tree instead of copying it over NFS.
- Replace only this key on each create, keeping other `worktree.*` keys and
  the rest of the file. A union with the previous value would keep stale
  entries after a project changes its config. The Claude home is per
  project, so one value fits every workspace in it.
- `create.ts` already resolves the list (`resolveEphemeralModulesPaths`)
  before it calls `seedClaudeSettings`, so the list becomes a parameter.
- Both drivers. Under containerless the module dirs are real directories on
  local disk, and symlinking them still saves an install.

## 2. Write `.git/info/exclude` when creating each checkout

`createCheckout` (`packages/server/src/domain/git/repo.ts`) builds `.git`
with `--template=`, so no `info/exclude` exists today. Write one:

```
/.claude/worktrees/
/node_modules
```

The file has one line per module dir. That line has no trailing slash: a
rule like `node_modules/` matches only real directories, so the symlink
Claude puts in each worktree would show as untracked there. Worktrees read
the main checkout's `info/exclude`, since it lives in the shared git
directory, so one file covers all of them.

The changes script already honours `info/exclude` (`add -A`,
`--exclude-standard`). Its private index then stops recording worktrees as
nested-repo entries, and the changes list, explorer tree and the agent's
`git status` all stop showing them.

`createCheckout` takes an `exclude: string[]` parameter, filled in by
`create.ts` from the same module-dir list. Existing workspaces keep a
checkout without the file until they are recreated. That is only cosmetic,
so there is no backfill and no legacy-compat entry.

## 3. Tests

- `packages/server/test/domain/git/repo.test.ts`: extend the
  `createCheckout` describe. After a checkout with a module dir and a
  `.claude/worktrees/x` holding a nested repo, `git status --porcelain`
  lists neither, and a `node_modules` symlink is ignored.
- Settings seeding: assert the seeded `settings.json` carries
  `worktree.symlinkDirectories` equal to the config's module dirs. It
  should replace a stale value, keep other `worktree` keys, and leave hooks
  alone. This goes in the workspace-create tests that already read the
  Claude home; `seedClaudeSettings` has no test of its own.
- No new CLI argument or API route, so no new e2e or route-matrix row.

## 4. Verify in a real k8s workspace

1. Create a workspace and confirm that `settings.json` and
   `.git/info/exclude` hold the new entries.
2. Have the agent spawn two or three `isolation: "worktree"` subagents. In
   each worktree, confirm `node_modules` is a symlink to
   `/workspace/node_modules` and that `git status` is clean.
3. Main risk: run `pnpm install --frozen-lockfile` inside one worktree.
   Confirm it finishes fast and does not purge or relink the shared
   `/workspace/node_modules`. pnpm sees a `node_modules` whose recorded
   workspace root differs and may want to rebuild it from scratch. If it
   wipes or corrupts the main tree, every agent shares that damage. In that
   case, deny worktree isolation under k8s instead, by seeding
   `permissions.deny: ["EnterWorktree", "Agent(isolation:worktree)"]`.
4. Measure pnpm's per-package `packages/*/node_modules`, which are not
   module dirs here, so a worktree's install still writes them onto NFS.
   They are only symlinks, but measure the count.
5. Watch the changes poll: the server log should stay around 1–2s while
   subagents run.

## 5. Docs

Update `docs/workspace-storage.md` and `docs/project-config.md` to say
`ephemeralModulesPaths` also drives Claude's worktree symlinks and the
checkout's `info/exclude`, and why (`docs/nfs-checkout-performance.md`).

## Known limits

- Claude only. Codex, opencode and pi do not create worktrees on their own.
- All worktrees share the main checkout's dependencies. A subagent on a
  branch with a different lockfile sees the main checkout's packages.
- A worktree created with `git worktree add` through Bash gets neither the
  symlinks nor the hiding, unless it lands under `.claude/worktrees/`.
