# Projects and their repos

A project links zero or more git repos. Each create picks which of them the
workspace starts with: none, one or several. One repo sits at the workspace
root or in a folder named for it; several always sit in named folders. Each
agent session runs in the workspace root or in one checkout's root. One main
clone serves every project that links a repo, and each repo authenticates
with its own credential.

## Rows

```
repos            id, owner, remoteUrl, gitCredentialId, knownHostsEntry,
                 hosted, guardDefaultBranch, keepsHostedRepo, deletedAt
repo_shares      repoId, userId
project_repos    projectId, repoId, dir, position, readOnly, ghToken,
                 lastIncluded, lastBranch
workspace_repos  workspaceId, repoId, path, baseBranch, startCommit
```

- A **repo** is one remote as one user reaches it: the URL, the credential
  that authenticates to it, the host key, and whether yaac hosts it
  (docs/hosted-projects.md). Its main clone is `global/repos/<repo id>`
  (docs/server-git.md) and, when hosted, its bare repository is
  `server-local/hosted-repos/<repo id>.git`.
- A **project repo** links a repo into a project. `dir` is the folder its
  checkout takes when nested: by default the repo's name, unique in the
  project, one path segment of `[A-Za-z0-9._-]`. `lastIncluded` and
  `lastBranch` remember the last create's choice for it.
- A **workspace repo** is one checkout in one workspace. `path` is `''` for
  the workspace root or the `dir` it was created under, copied at create so
  renaming a link's `dir` never moves an existing checkout. The base branch
  and start commit are per checkout. A workspace is flat exactly when its
  one row has `path = ''`.
- `sessions.cwd` is where a session's agent runs and `workspaces.cwd` the
  workspace's default, both relative to the workspace root.

`#domain/repos` owns repos (the main clone, branches, the hosted remote,
credentials, who may use one), `#domain/projects` which repos a project
links, and `#domain/workspaces` the checkouts (`checkouts.ts`).

## One main clone per repo

Adding a URL its owner already has links the existing repo instead of
cloning again, so two projects of one user on one remote share a main
clone, a credential and every fetch. This is safe for the reasons a main
clone is safe at all: only the server writes it, pods mount it read-only,
it never deletes an object, and it holds nothing but what origin served.
Workspaces share no git state through it. A fetch refreshes `origin/*` in
every running workspace that has a checkout of the repo, in any project.

Never across owners. A main clone holds objects fetched with its owner's
credential, so a second user linking it would read a private repo without
proving access. Two users adding one URL keep two repos. The exception is a
hosted repo its owner shared: the grant is explicit, and yaac is the host.

The credential belongs to the repo, so one user cannot use two credentials
for one URL in two projects.

## Workspace layout

The workspace dir (`workspaces/<id>`, `/workspace` in a pod) holds the
checkouts at `<workspace dir>/<path>`.

| Repos selected | Layout |
|---|---|
| none | an empty workspace dir |
| one | at the root, or under `dir` when the create asks for `nested` |
| several | each under its `dir` |

Every checkout gets the branch `agent/<workspace id>`. A create names its
selection as `repos: RepoStart[]`, with
`RepoStart = { repo, branch?, commit? }`, plus `nested` and `cwd`; `repo` is
the link's folder or the repo's id, and `[]` means no repos. Creates,
queued entries, routines, drafts, reruns and `yaac-mama` all take the same
fields. `branch` and `commit` on their own are shorthand for the start of a
selection of exactly one repo (`resolveStart`).

Each selected repo must be usable by the project's owner (`canUseRepo`),
have a credential, and behind the proxy have its host in the egress
allowlist. A workspace with no repos needs none of that. Linking a repo
(adding a project around it, or adding it to one) adds its host to the
project's allowlist when the list leaves it out, and the webapp and CLI
say so, so the check only refuses a host someone removed afterwards.

## Remembered create settings

The selection, layout and cwd are create settings like the tool and model:
the create route records what the user chose (`recordProjectCreate`), and
the next create starts from it.

- A create that names no repos takes the ones last included
  (`project_repos.lastIncluded`; a repo linked since counts as included),
  each at its default branch. The create form opens each repo on its
  `lastBranch`.
- One that names no layout or cwd takes `projects.lastNested` and
  `lastCwd` (a repo id, or `.` for the root).
- A queued child takes its parent's.
- Spares are warmed with the remembered selection, layout and cwd, and
  claimed only by a create asking for exactly that; the claim rebranches
  each checkout.

## The agent's cwd

Each session has its own cwd, chosen when it is opened, like its model and
permission mode. The workspace's cwd is the default: shells and steps start
there (the tmux session's own directory), and so does a session opened
without a choice.

- A create's choice sets both. Without one it is the remembered choice when
  that repo is in the workspace, else the lone repo's path, else the root.
- A cwd is the root or a checkout's root and nothing deeper: the server
  makes those dirs before the runtime starts.
- A session keeps its cwd for life. claude and codex look a conversation up
  by the directory it started in, so a restart resumes each session where
  it was recorded; working elsewhere means opening another session.

### Agent history by cwd

claude files conversations and its memory under a folder named for the cwd.
A workspace's history keeps one such folder per cwd it can have: the root
and each checkout in a folder (`claudePodCwd`).

- A transcript's path is known from the session's cwd and the conversation
  id, both of which yaac chooses at launch. A reader uses the path the
  conversation's row records, else the computed one; nothing searches the
  folders.
- claude keys auto-memory on the git root it starts in. The project keeps
  one memory per repo and one for a workspace root that is no checkout
  (`claudeMemoryDirName`), each mounted (or under containerless linked)
  over the memory folder of every cwd it applies to. So a repo's memory is
  the same whether its checkout sits at the root of one workspace or in a
  folder of another.

## Credentials per repo

Each repo in a workspace uses its own credential, including two repos on
one host. A credential is used for its own repo and nothing else; the one
wider use is a GitHub token as `GH_TOKEN`, which a setting on the link
allows. The egress path is handed a grant per (project, repo): the repo's
host and path and the link's `readOnly` and `ghToken` (`RepoGrant`). How
the proxy and the containerless driver apply them is
docs/git-credentials.md.

`GH_TOKEN` is one value per process: the token of the repo the session's
cwd is in when that repo allows it, else the first that does, else unset. A
project env var named `GH_TOKEN` wins. `yaac-mama as-repo <repo> --
<command>` runs one command with another repo's.

### Read-only repos

Under k8s, `project_repos.readOnly` makes a repo read-only in one project.
The credential is the repo's and shared by every project that links it, so
this flag is how one project reads a repo that another writes. From that
project's workspaces the proxy passes only reads to the repo's path, over
https and ssh, whichever credential comes with them (so pushes and LFS
uploads are refused; docs/workspace-egress.md "Read-only repos"), and it
never offers the repo's token as `GH_TOKEN`, since the GitHub API cannot be
split into reads and writes by method.

It does not stop a write that is not git to that path: the host's API with
another token that can write the repo, or the same host under another name
the allowlist admits.

Neither `readOnly` nor `ghToken` exists under containerless. A workspace
there runs as the server's user and holds every credential, so the flags
could promise nothing; their routes answer `NOT_SUPPORTED`.

## Unlinking and deleting

Removing a project or unlinking a repo deletes no repo and no workspace:
the repo, its credential and its main clone stay among its owner's repos,
and Settings → Repos lists it as linked to no project. A workspace keeps
its checkout of an unlinked repo, but its git there stops at once, running
or not: the project no longer holds a grant for the repo, so a fetch or
push is refused until the repo is linked again. Unlinking is refused while
a site of the project is built from the repo.

Only a repo's owner deletes it (`yaac repo delete`). That unlinks it from
every project, other users' included, ends its shares, and for a hosted
repo deletes the bare repository, the only copy of its code. It deletes no
workspace: one that holds a checkout keeps its files and commits, with no
remote, and still restarts with that checkout as it stands (one that has
lost it cannot make it again). A create in flight that starts with the repo
is stopped, and a delete is refused while a site is built from the repo.
Those checkouts borrow their objects from the main clone, so while
any workspace holds one, the main clone and the repo's row (marked deleted,
linkable by no one) stay, and the delete lists the workspaces holding it.
Once those workspaces are deleted the server removes both.

## Limits

A public site and a workflow with run secrets both name one commit, so each
needs a workspace with exactly one repo; a site records which repo it is
built from (`sites.repoId`).
