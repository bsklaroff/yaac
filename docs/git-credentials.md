# Git credentials

All of a repo's git traffic (the server's clones and fetches, and every fetch
and push workspaces make to it) authenticates with **one credential assigned
to that repo** (docs/project-repos.md). A project that links several repos
uses each one's own. Credentials are named and belong to a user, the owner
of the repos they serve: one credential can serve many of its owner's repos,
and no other user's. There are two kinds, and the kind must match the
repo's remote:

- an **HTTPS token** the user pastes, for an `https://` remote;
- an **SSH key** yaac generates, for an `ssh://git@host/path` or SCP-style
  `git@host:path` remote. The private half is stored sealed in the database
  and held only transiently in the memory of the processes that sign with it.
  It is never read from the user's machine, never written to a file, and never
  shown. The user sees only the public half, which they register with their
  git host as a deploy key or account key.

Credentials are managed in the webapp (Settings → Git credentials, and the Add
Project form), and each repo picks its credential in Settings → Repos, which
lists every repo the user owns with the credential it uses. From the CLI, `yaac auth update` adds one, `yaac auth list`
lists them by name, and `yaac project add <url> <credential>` clones with the
named credential and assigns it to the repo; a repo is always added with one.
`yaac config git-credential <project> <credential>` assigns another.
`yaac auth fake github` seeds `fake-github`, a placeholder token that a parent
yaac's proxy swaps for its real one (for yaac running inside a yaac workspace).

A repo whose remote yaac hosts (docs/hosted-projects.md) has no
credential and needs none. The server reads its remote from disk, and a
workspace reaches it as itself, so its credential resolves to `hosted`.

## The model

A `git_credentials` row holds its owner, a name (unique per owner), a kind,
the sealed secret (the token, or the ed25519 seed) and, for a key, its public
line. Every route that lists, adds, renames, replaces or deletes one acts on
the caller's own; another user's credential reads as missing, and a repo
can only be assigned one of its owner's. A repo points at its
credential with `repos.gitCredentialId`, next to the `knownHostsEntry`
trusted when an SSH credential was assigned. Credentials are assigned rather
than matched by URL pattern so that the choice is made once, visibly, and does
not change when another credential is added. The credential is the repo's,
so every project that links the repo uses the same one.

- **No usable credential, no workspaces.** A repo can lack a usable
  credential (none assigned, or a remote that changed). Creating a workspace
  with that repo is then refused, and the webapp's create button becomes "Add
  git authentication…", which opens Settings on that repo. "Usable" means the
  credential's kind matches the remote's scheme and, for a key, the host key
  saved at assignment is still there.
- **Replacing keeps the repos.** Replace swaps in a new secret of the same
  kind (a pasted token or a freshly generated key) under the same name. Every
  repo it served moves to it in one transaction, keeping their trusted host
  keys. It is a new row, not an update, so nothing holding the old id keeps
  using the replacement unknowingly. After replacing a key, register the new
  public half with the host before those repos' git works again.
- **Deleting is never refused.** A leaked credential must be removable at once,
  so a delete leaves its repos with no credential (the webapp confirms and
  names them), and the runtime is told immediately. If the egress proxy cannot
  be told about a delete or replace, the request fails with
  `RUNTIME_UNAVAILABLE` instead of reporting success, because the proxy keeps
  the old secret until the next push. A running containerless workspace keeps
  its copy until it restarts. In every case, also revoke a leaked token or key
  at the host.
- **Default names** are `<project>-token` / `<project>-key` when made for a
  project and `git-token` / `git-key` otherwise, with `-2`, `-3`… appended if
  the name is taken.
- **Renaming is free.** A key's comment is the credential's name, so a rename
  updates the comment in its public line. Hosts match the key itself, not the
  comment, so a copy registered under the old comment keeps working.

## The host key

Assigning a key to a repo fetches the remote host's key by running `ssh`
against it with `StrictHostKeyChecking=accept-new` and a temporary known_hosts
file. (`ssh-keyscan` cannot take a `ProxyCommand`, so it cannot be routed
through Tor.) This is trust on first use, so the response shows the entry for
the user to compare a fingerprint. Every git-over-SSH command yaac runs, on
either substrate, verifies against that stored entry with
`StrictHostKeyChecking=yes`.

The host key belongs to the assignment. Assigning a different credential
fetches it again, and changing a repo's remote clears its host key in the
same statement, so the repo has no usable credential until a key is
assigned again. Reassigning is also how a rotated host key is refreshed.

## What a key is

Keys are always ed25519. The key is yaac's own, so there is no type to choose,
every git host accepts it, and one algorithm keeps the code simple. The seed is
what is stored, because everything derives from it: the public half, the
`KeyObject` the server signs with, and the OpenSSH private-key format that
`ssh-add -` reads. Nothing ever has to parse that format back. All key math is
in `#lib/ssh-key`. The OpenSSH format (`openssh-key-v1`, cipher `none`) is
encoded by hand because OpenSSH rejects the PKCS#8 form Node exports for
Ed25519.

## Who uses a credential, where

- **The server's own git** (clones, fetches) gets an HTTPS token from a
  credential helper scoped to the remote's origin, set through `GIT_CONFIG_*`
  in that one command's environment, with the token in an env var the helper
  echoes. It never goes in the URL: argv is visible to every local user,
  while a process's environment is readable only by its own uid (under
  containerless that uid also runs every workspace, which already holds
  real credentials). Git asks helpers per request host, so a redirect, a
  user's `insteadOf` or an LFS storage host elsewhere never sees the token.
  An empty `credential.helper` ahead of it drops the user's own helpers, so
  git neither offers their login nor erases it when the token is rejected.
  For a key it signs through an ssh-agent the server
  runs in-process (`domain/git/agent.ts`): a UNIX socket in the install-keyed
  temp dir that answers only two requests, list identities and sign. That
  dir's name is predictable, so another OS user who created it first could
  swap in an agent of their own. `ensureInstallTmpDir` creates it 0700,
  tightens one of the server user's own that is open to others (removing
  anything others put in it), and refuses a symlink, a dir another user
  owns, or a temp dir others can write that has no sticky bit. A refusal
  refuses the server's start, and `yaac server start` prints why.
  Identities come from the public column, and a seed is decrypted only inside
  the sign handler, for the one key requested. `GIT_SSH_COMMAND` names the
  socket as `IdentityAgent` and the repo's public key file as `-i` with
  `IdentitiesOnly`, so ssh offers only the assigned key.
- **A k8s workspace** holds neither kind. The server gives the egress proxy
  every credential some repo uses, each with a grant per (project, repo)
  that may use it, in the `yaac-proxy-credentials` Secret under its owner's
  key (docs/workspace-egress.md "Owners", "Git credentials"). The proxy
  uses a credential for its own repo and nothing else. It injects a token
  only into requests from a workspace of the granted project, and only under
  that repo's path on its host; the one wider use is as `GH_TOKEN` toward
  the GitHub API, where the link allows it. For ssh it ends the workspace's
  session itself: it reads the git command, checks the path is one of the
  project's ssh repos on that host, and logs in to the host with that
  repo's key, so the key never leaves the proxy and a session carries only
  git. A link marked read-only takes only reads, on both transports
  (docs/workspace-egress.md "Read-only repos").
- **A containerless workspace** is given the credential of each repo it has
  a checkout of directly: the token, in a credential store keyed by the
  repo's path, or the key, fed from the server over a stdin pipe through
  `ssh-add -` into the workspace's own `ssh-agent`, with only the public half
  in its state dir and a wrapper (`yaac-git-ssh`) that has ssh offer the key
  of the repo git is reaching (docs/containerless-driver.md). Nothing holds
  a credential to its repo there; the workspace only picks the right one.
  It gets its own agent rather than using the server's because a
  containerless workspace outlives a server restart, and its pushes must keep
  working. It keeps the credentials it launched with until it restarts.

## The trust boundary

The user gives yaac a token or a name, and gets back a public key. Nothing yaac
stores refers to a path on any machine, so the same flow works with a server on
another host (docs/remote-hosting.md).

Under `k8s`, nothing a workspace can read is a credential. The pod holds a
known_hosts file naming the proxy's public host key and no agent socket.
The proxy logs in with a key only for the repo it is granted for, and sends
a token only on requests under its own repo's path from that repo's
project.

Under `containerless` the boundary is the server's uid, and a workspace is a
process of that uid on the same host. The server's agent socket is in the same
temp dir as the workspace's tmux and ssh-agent sockets, so a containerless
workspace can point `SSH_AUTH_SOCK` at it and sign with every stored key, not
just its own repos'. It can also read the secret-key file and the database
directory. That is expected for a driver with no sandbox
(docs/containerless-driver.md): nothing on the host is hidden from what runs
on it.
