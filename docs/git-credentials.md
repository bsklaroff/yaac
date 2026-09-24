# Git credentials

A project's git — the server's clones and fetches, and every fetch and push
its worktrees make — authenticates with **one credential assigned to that
project**. Credentials are named, and one may serve many projects. There
are two kinds, and the kind must match the project's remote:

- an **HTTPS token** the user pastes, for an `https://` remote;
- an **SSH key** yaac generates, for an SCP-style `git@host:path` remote.
  The private half lives sealed in the database and, transiently, in the
  memory of the processes that sign with it. It is never read from the
  user's machine, never written to any filesystem, and never shown; the user
  only sees the public half, which they register with their git host as a
  deploy key or account key.

They are managed in the webapp (Settings → Git credentials, and the Add
Project form). The CLI can add one (`yaac auth update`) and list them by
name (`yaac auth list`), and `yaac project add <url> <credential>` clones
with the one named and assigns it: a project is always added with a
credential. `yaac auth fake github` seeds `fake-github`, a token that is a
proxy placeholder a parent yaac swaps for its real one (the yaac-in-yaac
case).

## The model

A `git_credentials` row is a name, a kind, the sealed secret (the token, or
the ed25519 seed) and, for a key, its public line. A project names the one
it uses in `projects.gitCredentialId`, beside the `knownHostsEntry` an SSH
assignment trusted. Why assignment rather than matching a URL against
patterns: which credential a project gets is a decision the user makes once,
visibly, and nothing about it changes when another credential is added.

- **No credential, no worktrees.** A project is added with one, but can
  still lack a usable one — an upgraded install's project the importer
  found no match for, or a remote that changed. A create refuses it, and
  the webapp's create button becomes "Add git authentication…", which opens
  Settings on that project. "Usable" means the credential's kind is the
  remote's scheme and, for a key, the host key it was assigned with is
  still there.
- **Replacing keeps the projects.** Replace swaps a credential's secret for
  a new one of its kind — a pasted token, or a freshly generated key — under
  the same name, with every project it served moved onto it in one
  transaction and the host keys they trusted kept (the host has not
  changed). It is a new row, not an update, so nothing holding the old id
  goes on using the replacement unawares. A replaced key needs its new
  public half registered with the host before those projects' git works.
- **Deleting is never refused.** A leaked credential has to be removable at
  once, so a delete leaves the projects that used it with none (the webapp
  confirms, naming them) and the runtime is told immediately — a delete or
  replace the egress proxy could not be told of answers
  `RUNTIME_UNAVAILABLE` rather than "done", since the proxy still holds the
  old secret until the next push. A running containerless worktree keeps
  the copy it launched with until it restarts. Either way, revoke a leaked
  token or key at the host too.
- **Default names** are `<project>-token` / `<project>-key` when made for a
  project, `git-token` / `git-key` otherwise, suffixed `-2`, `-3`… past the
  names taken.
- **Renaming is free.** A key's comment is the credential's name, so a rename
  re-comments its public line. The comment is not part of the key: a host
  matches the key blob, and a copy registered under the old comment keeps
  working.

## The host key

Assigning a key to a project fetches the remote host's key by driving `ssh`
against it (`StrictHostKeyChecking=accept-new` into a temp known_hosts;
`ssh-keyscan` cannot be routed through Tor). That is trust on first use, so
the answer echoes the entry back for the user to compare a fingerprint.
Every git-over-ssh invocation yaac makes, on either substrate, verifies
against that stored line with `StrictHostKeyChecking=yes`.

The host key belongs to the assignment, so it goes with it: assigning a
different credential fetches its own, and a project row whose remote
changes has its host key cleared in the same statement — the project then
reads as having no usable credential until the key is assigned again. The
same re-assignment is how a rotated host key is refreshed.

## What a key is

Only ed25519: the key is yaac's own, so there is no type to choose, every
git host accepts it, and one algorithm keeps everything below trivial. The
seed is the stored form because everything derives from it — the public
half, the `KeyObject` the server signs with, and the OpenSSH private-key
container an `ssh-add -` reads — so nothing ever has to parse that container
back. `#lib/ssh-key` is the whole of the key math. That container is
hand-encoded (`openssh-key-v1`, cipher `none`) because OpenSSH refuses the
PKCS#8 form Node exports natively for Ed25519.

## Who uses a credential, where

- **The server's own git** (clones, fetches) takes an HTTPS token in the
  request URL for that one invocation, and signs for a key through an
  ssh-agent the server runs in-process (`domain/git/agent.ts`): a UNIX socket
  under the install-keyed temp dir that answers exactly two requests — list
  identities, and sign — and refuses everything else. Identities come from
  the public column; a seed is opened only inside the sign handler, for the
  one key the request named. `GIT_SSH_COMMAND` names the socket as
  `IdentityAgent` and the project's PUBLIC key file as `-i` under
  `IdentitiesOnly`, so ssh offers the one identity assigned rather than
  every key the agent holds.
- **A k8s worktree** holds neither. The server hands the egress proxy every
  credential some project uses, each with the projects entitled to it, in
  the `yaac-proxy-credentials` Secret (docs/worktree-egress.md). The proxy
  injects a token only into requests from a worktree of one of its projects,
  and only toward that project's remote host. Keys are loaded into the
  proxy's in-memory agent, each destination-constrained (`ssh-add -h`) to
  its projects' hosts, and a worktree reaches that agent through its
  `SSH_AUTH_SOCK` forwarder (`k8s/proxy/ssh-agent-relay.ts`). The relay
  scopes the agent to the worktree's project: it answers "which keys" with
  that project's key alone and refuses a signature for any other — so an
  assignment is enforced, not just recorded. It admits three requests —
  list, sign, and the `session-bind@openssh.com` extension, which is how the
  client tells the agent which host it is talking to; an agent will not sign
  with a constrained key on an unbound session.
- **A containerless worktree** is handed its project's credential: the
  token, or the key fed through `ssh-add -` into an `ssh-agent` of its own
  from the server's stdin pipe, with only the public half in its home
  (docs/containerless-driver.md). A workspace's agent is its own rather than
  the server's because a containerless worktree outlives a server restart,
  and its pushes must not die with it. A running workspace keeps the
  credential it launched with until it restarts.

## The trust boundary, stated

What the user hands yaac is a token or a name; what they get back for a key
is a public key. Nothing yaac stores names a path on any machine, so the
same flow works against a server on another host (docs/remote-hosting.md).

Under `k8s`, nothing a worktree can read is a credential: the pod holds a
forwarded agent socket and a public known_hosts file, the proxy signs only
with its own project's key and only for that key's hosts, and a token rides
only its own project's requests.

Under `containerless` the boundary is the server's uid, and a worktree IS a
process of that uid on the same host. The server's agent socket sits in the
same install-keyed temp dir as the worktree's own tmux and ssh-agent
sockets, so a containerless worktree can point `SSH_AUTH_SOCK` at it and
sign with every stored key, not just its project's — and it can read the
secret-key file and the database directory too. That is the posture of a
driver with no sandbox at all (docs/containerless-driver.md): nothing on
that host is withheld from what runs on it.
