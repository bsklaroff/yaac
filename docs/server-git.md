# Server-side git

Every git process the server starts goes through one runner,
`runGit` in `packages/server/src/domain/git/run.ts`. The `#domain/git`
barrel's verbs (clone, fetch, worktree add, branch and tree lookups) are
the only callers. Nothing else in `src/` starts git.

## Why git never reads the repository's config

Under k8s, every worktree pod mounts the project's whole `.git` read-write at
`/repo/.git`. Whatever git reads from there was potentially written by an
agent. The config is the dangerous part, because it can name commands for
git to run:

- filter drivers, applied on `checkout` and when `status` re-hashes a file
- the fsmonitor
- credential helpers and ssh commands
- a hooks path
- `url.<base>.insteadOf` and `http.<url>.*`, which decide where a request
  carrying a token actually goes

Git has no switch to ignore a repository's config. Pinning keys with `-c`
only works for keys whose names are known in advance, and filter drivers,
URL rewrites and per-URL settings are named by whoever writes the config.
Finding those names means reading the config before git reads it again, and
a pod can add one in between.

So git never reads the pod-writable file at all.

## The throwaway git dir

Each call builds a git dir in server-private scratch
(`<server-local>/run/git-shadow/g-*`, which no pod mounts) and deletes it
afterwards. The server clears the whole directory at startup, under its
lock and before anything can run git, since a server killed mid-call never
ran its cleanup:

| Entry | What it is |
|---|---|
| `config` | Written by the server. It keeps only `core.repositoryformatversion` and `extensions.objectformat` from the real config, and sets `core.bare` and `core.logallrefupdates` itself. |
| `HEAD` | A validated copy of the real one. |
| `objects`, `refs`, `packed-refs`, `logs`, `worktrees`, `info`, `shallow` | Symlinks to the real `.git`. Git's lockfile follows a symlink, so ref and object writes land in the real repository. |

There is no `hooks/` and no `modules/`.

The real config is read exactly **once**, through a no-follow open of a
regular file, into a copy that `git config --file … --no-includes` then
lists. That single read is what makes a concurrent write by a pod
irrelevant: git only ever opens the copy.

Because the config is built from an allowlist, a config key git adds in
future is dropped by default. A repository using `extensions.refstorage`
other than `files` is refused, since the symlinks describe the files
backend's layout.

How each kind of call points git at the repository:

- **`repo`** (the clone): `GIT_DIR` and `GIT_COMMON_DIR` are both the
  throwaway dir. Naming the common dir is not redundant: `worktree add`
  starts a child git in the new admin dir, and without `GIT_COMMON_DIR` in
  its environment that child would follow the admin dir's `commondir`
  through the `worktrees` link back to the real config.
- **`worktree`** (a linked checkout): `GIT_DIR` is the real
  `.git/worktrees/<id>`, `GIT_COMMON_DIR` is the throwaway dir, and
  `GIT_WORK_TREE` is the checkout.
- **`none`** (a clone into an empty path, or reading one file with
  `--file`): discovery is fenced off with `GIT_CEILING_DIRECTORIES`.

Naming the directories for `repo` and `worktree` means git never discovers
anything: it never reads a checkout's pod-writable `.git` file or an admin
dir's `commondir`.

Each call also pins these on the command line:

- `core.hooksPath=/dev/null` and `core.fsmonitor=false`.
- Submodule recursion off, because `.git/modules/<name>/` holds full git
  dirs with their own pod-writable configs.
- `gc.auto=0` and `maintenance.auto=false`. An auto gc detaches and would
  outlive the throwaway dir, and its `gc.pid` lock would sit there, unseen
  by a pod's own gc. Pods gc the shared repository themselves.
- `protocol.allow=never`, plus the one transport of the remote the call
  talks to.

The server's own global and system config are still read. They belong to
the server's user, not to a pod.

Git still reads refs, objects, the index, `info/attributes` and
`.gitattributes` from pod-writable state. With no driver defined in the
config git reads, an attribute can only select git's built-in conversions,
which run nothing. Where those entries LEAD is not safe, though: see the
cross-project item below.

Branch config the server reads back (`branch.<name>.merge`, for
`worktreeUpstreamBranch`) comes from a one-read copy too, and only a plain
`refs/heads/<name>` value is accepted.

## Remote URLs come from the project row

The URL a fetch goes to, the credential it is matched with, and the
`repoUrl` the k8s proxy uses to bound its project's https credential to one
host and to gate the ssh agent all come from `projectRemoteUrl(slug)` in `#domain/projects`, which
reads the project row. `fetchOrigin` takes that URL as an argument and
fetches by explicit URL and refspec. It never uses the name `origin`, so the
repository's `remote.origin.*` never affects where a fetch goes or which
token it carries.

`cloneRepo` still writes `remote.origin.url` into the real config, before
any pod exists, for the pods' own git to use.

## Consequences

- `addWorktree` writes the checkout's `.git` file itself, naming the real
  admin dir. The one git wrote names the throwaway dir it was reached
  through.
- Rollback deletes the branch with `update-ref -d`, not `branch -D`, which
  would also rewrite the config.
- Filters configured in the repository, such as LFS set up with
  `git lfs install --local`, do not apply to the server's checkout. LFS
  configured in the server user's global config still does, and pods fetch
  LFS content themselves.

## What this does not cover

The runner guarantees two things: the server's git runs nothing a pod
chose, and a token goes only to the project row's URL. It does not stop a
pod from pointing the server's git at the wrong files.

- **Server-side reads and writes outside the pod's own project.** A pod can
  plant links in the shared `.git`, and the server's git follows them, so
  it touches other projects and other server files:
  - **Writes through a linked directory.** When `refs/remotes/origin` is
    a symlink, a fetch writes its ref files into the target. When
    `logs/refs/remotes/...` is one, the fetch appends reflog lines to any
    file the server can write, including another project's `.git/config`.
    `worktrees/` behaves the same way for `worktree add`.
  - **Reads of another project's repository.** `objects/info/alternates`
    names object directories anywhere on the server's filesystem, and a
    symlinked `objects/pack` does the same. Either one, together with a
    `packed-refs` linked to another project's, makes the listings, the
    blob reads and `addWorktree` read another project's refs and tree. The
    result is that project's code checked out into this project's
    worktree, which this project's next pod mounts. Under k8s every clone
    is at `/yaac/global/projects/<slug>/repo/.git` in the server pod, so
    only the slug has to be guessed.
  - **The first line of any readable file in an error.** A `packed-refs`
    linked to a file makes git fail with that file's first line in its
    message, and the runner rejects with git's stderr.

  Plain git follows the same links, so none of this is new. The fix is to
  stop pods writing the shared admin state: mount `/repo/.git` read-only
  with only `worktrees/<id>` writable, or confine the server's git so it can
  reach only the one repository.
- **Pods of one project reaching each other.** They still share a writable
  `.git`, so one agent can plant hooks, filters or a rewritten origin that
  another agent's git runs inside its own pod.
