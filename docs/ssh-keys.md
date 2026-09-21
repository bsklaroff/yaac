# SSH keys

yaac authenticates git over SSH with a key **it generates**. The private
half lives sealed in the database and, transiently, in the memory of the
processes that sign with it. It is never read from the user's machine,
never written to any filesystem, and never shown; the user only ever sees
the public half, which they register with their git host as a deploy key or
account key.

```
yaac auth update        # → git → SSH: names a pattern, prints the public key
yaac auth list          # shows every key as its public half
```

The webapp's Credentials pane does the same: pick "SSH key", name a
pattern, and copy the public key off the row it adds.

## What a key is

One ed25519 key per repo pattern (`<host>/*`, `<host>/<path>`,
`<host>/<prefix>/*` — the same patterns https tokens use), in a
`git_ssh_keys` row: the sealed 32-byte seed, the public key in the clear,
and the host's known_hosts line. Only ed25519: the key is yaac's own, so
there is no type to choose, every git host accepts it, and one algorithm
keeps everything below trivial. The seed is the stored form because
everything derives from it — the public half, the `KeyObject` the server
signs with, and the OpenSSH private-key container an `ssh-add -` reads —
so nothing ever has to parse that container back. `#lib/ssh-key` is the
whole of the key math.

That container is hand-encoded (`openssh-key-v1`, cipher `none`) because
OpenSSH refuses the PKCS#8 form Node exports natively for Ed25519.

Generating a key for a pattern that already has one **replaces** it: the
previous public key stops working the moment the call returns, and the
answer is how the caller learns the new one. That is also the only way to
refresh a stored host key today: when a git host rotates its host key,
every SSH project on it fails with `Host key verification failed` until the
pattern is regenerated and the new public key registered. A host-key-only
update is a known gap.

## The host key

A generate fetches the host's key by driving `ssh` against it
(`StrictHostKeyChecking=accept-new` into a temp known_hosts; `ssh-keyscan`
cannot be routed through Tor). That is trust on first use, so the entry is
echoed back beside the public key — by the CLI and the webapp both — for
the user to compare a fingerprint.
A host the server cannot reach unauthenticated takes a pasted line instead.
Every git-over-ssh invocation yaac makes, on either substrate, verifies
against that stored line with `StrictHostKeyChecking=yes`.

## Who signs, where

Three processes ever hold the private half, and none writes it:

- **The server's own git** (clones, fetches) signs through an ssh-agent the
  server runs in-process (`domain/git/agent.ts`): a UNIX socket under the
  install-keyed temp dir that answers exactly two requests — list
  identities, and sign — and refuses everything else. Identities come from
  the public column; a seed is opened only inside the sign handler, for the
  one key the request named. Rows are read per request, so a key generated
  or removed a moment ago is what the next fetch uses.
  `GIT_SSH_COMMAND` names the socket as `IdentityAgent` and the PUBLIC key
  file as `-i` under `IdentitiesOnly`, so ssh offers the one identity the
  pattern resolved to rather than every key the agent holds against a host
  that may lock the account out.
- **A k8s worktree** signs through the egress proxy's in-memory agent. The
  server pushes each key over the proxy's authenticated control API; the
  proxy pipes it into `ssh-add -h <host> -` (destination-constrained, from
  stdin); the worktree pod reaches that agent over TCP through its own
  `SSH_AUTH_SOCK` forwarder (docs/worktree-egress.md, `k8s/proxy/
  ssh-agent-relay.ts`). The relay admits three requests — list, sign, and
  the `session-bind@openssh.com` extension, which is how the client tells
  the agent which host it is talking to; an agent will not sign with a
  constrained key on an unbound session, so that one extension is what
  makes the constraint usable rather than a lockout. A replaced proxy pod
  comes back with an empty agent, which the driver notices and refills.
- **A containerless worktree** gets an `ssh-agent` of its own, fed the key
  through `ssh-add -` from the server's stdin pipe; its home holds only the
  public half (docs/containerless-driver.md). A workspace's agent is its
  own rather than the server's because a containerless worktree outlives a
  server restart, and its pushes must not die with it.

The agent's identity answer and the host-key lookup work from the public
column and the host key alone. A seed is opened in four places: the sign
handler above; the proxy push and containerless launch that hand a
worktree's agent its key; a credential resolve, which skips a key that no
longer opens so the failure lands somewhere visible; and the user-facing
listing, which marks such a key as needing regeneration.

## The trust boundary, stated

What a user hands yaac is a pattern; what they get back is a public key.
Nothing yaac stores names a path on any machine, so the same flow works
against a server on another host (docs/remote-hosting.md).

Under `k8s`, nothing a worktree can read is a private key: the pod holds a
forwarded agent socket and a public known_hosts file, and the proxy's agent
signs only for the host the key was constrained to.

Under `containerless` the boundary is the server's uid, and a worktree IS a
process of that uid on the same host. The server's agent socket sits in the
same install-keyed temp dir as the worktree's own tmux and ssh-agent
sockets, so a containerless worktree can point `SSH_AUTH_SOCK` at it and
sign with every stored key, not just the one project's key it was handed —
and it can read the secret-key file and the database directory too. That
is the posture of a driver with no sandbox at all
(docs/containerless-driver.md): the key never touches a filesystem there
either, but nothing on that host is withheld from what runs on it.
