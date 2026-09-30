# Git credentials

All of a project's git traffic (the server's clones and fetches, and every fetch
and push its workspaces make) authenticates with **one credential assigned to
that project**. Credentials are named, and one credential can serve many
projects. There are two kinds, and the kind must match the project's remote:

- an **HTTPS token** the user pastes, for an `https://` remote;
- an **SSH key** yaac generates, for an SCP-style `git@host:path` remote. The
  private half is stored sealed in the database and held only transiently in
  the memory of the processes that sign with it. It is never read from the
  user's machine, never written to a file, and never shown. The user sees only
  the public half, which they register with their git host as a deploy key or
  account key.

Credentials are managed in the webapp (Settings → Git credentials, and the Add
Project form). From the CLI, `yaac auth update` adds one, `yaac auth list`
lists them by name, and `yaac project add <url> <credential>` clones with the
named credential and assigns it; a project is always added with one.
`yaac auth fake github` seeds `fake-github`, a placeholder token that a parent
yaac's proxy swaps for its real one (for yaac running inside a yaac workspace).

## The model

A `git_credentials` row holds a name, a kind, the sealed secret (the token, or
the ed25519 seed) and, for a key, its public line. A project points at its
credential with `projects.gitCredentialId`, next to the `knownHostsEntry`
trusted when an SSH credential was assigned. Credentials are assigned rather
than matched by URL pattern so that the choice is made once, visibly, and does
not change when another credential is added.

- **No usable credential, no workspaces.** A project can lack a usable
  credential (none assigned, or a remote that changed). Creating a workspace is
  then refused, and the webapp's create button becomes "Add git
  authentication…", which opens Settings on that project. "Usable" means the
  credential's kind matches the remote's scheme and, for a key, the host key
  saved at assignment is still there.
- **Replacing keeps the projects.** Replace swaps in a new secret of the same
  kind (a pasted token or a freshly generated key) under the same name. Every
  project it served moves to it in one transaction, keeping their trusted host
  keys. It is a new row, not an update, so nothing holding the old id keeps
  using the replacement unknowingly. After replacing a key, register the new
  public half with the host before those projects' git works again.
- **Deleting is never refused.** A leaked credential must be removable at once,
  so a delete leaves its projects with no credential (the webapp confirms and
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

Assigning a key to a project fetches the remote host's key by running `ssh`
against it with `StrictHostKeyChecking=accept-new` and a temporary known_hosts
file. (`ssh-keyscan` cannot take a `ProxyCommand`, so it cannot be routed
through Tor.) This is trust on first use, so the response shows the entry for
the user to compare a fingerprint. Every git-over-SSH command yaac runs, on
either substrate, verifies against that stored entry with
`StrictHostKeyChecking=yes`.

The host key belongs to the assignment. Assigning a different credential
fetches it again, and changing a project's remote clears its host key in the
same statement, so the project has no usable credential until a key is
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

- **The server's own git** (clones, fetches) puts an HTTPS token in the request
  URL for that one command. For a key it signs through an ssh-agent the server
  runs in-process (`domain/git/agent.ts`): a UNIX socket in the install-keyed
  temp dir that answers only two requests, list identities and sign.
  Identities come from the public column, and a seed is decrypted only inside
  the sign handler, for the one key requested. `GIT_SSH_COMMAND` names the
  socket as `IdentityAgent` and the project's public key file as `-i` with
  `IdentitiesOnly`, so ssh offers only the assigned key.
- **A k8s workspace** holds neither kind. The server gives the egress proxy
  every credential some project uses, each with the projects allowed to use
  it, in the `yaac-proxy-credentials` Secret (docs/workspace-egress.md). The
  proxy injects a token only into requests from a workspace of one of its
  projects, and only toward that project's remote host. Keys are loaded into
  the proxy's in-memory agent, each limited (`ssh-add -h`) to its projects'
  hosts. A workspace reaches that agent through its `SSH_AUTH_SOCK` forwarder
  (`k8s/proxy/ssh-agent-relay.ts`). The relay lists only the workspace's own
  project's key and refuses to sign with any other, so the assignment is
  enforced, not just recorded. It allows three requests: list, sign, and the
  `session-bind@openssh.com` extension, which tells the agent which host the
  client is talking to (an agent will not sign with a host-limited key without
  it).
- **A containerless workspace** is given its project's credential directly: the
  token, or the key, fed from the server over a stdin pipe through `ssh-add -`
  into the workspace's own `ssh-agent`, with only the public half in its home
  (docs/containerless-driver.md). The workspace gets its own agent rather than
  using the server's because a containerless workspace outlives a server
  restart, and its pushes must keep working. It keeps the credential it
  launched with until it restarts.

## The trust boundary

The user gives yaac a token or a name, and gets back a public key. Nothing yaac
stores refers to a path on any machine, so the same flow works with a server on
another host (docs/remote-hosting.md).

Under `k8s`, nothing a workspace can read is a credential. The pod holds a
forwarded agent socket and a public known_hosts file. The proxy signs only with
the workspace's project's key and only for that key's hosts, and a token is
sent only on its own project's requests.

Under `containerless` the boundary is the server's uid, and a workspace is a
process of that uid on the same host. The server's agent socket is in the same
temp dir as the workspace's tmux and ssh-agent sockets, so a containerless
workspace can point `SSH_AUTH_SOCK` at it and sign with every stored key, not
just its project's. It can also read the secret-key file and the database
directory. That is expected for a driver with no sandbox
(docs/containerless-driver.md): nothing on the host is hidden from what runs
on it.
