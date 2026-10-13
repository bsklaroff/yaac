# Plan: test machines

A **test machine** is a VM that belongs to a project and that one workspace
at a time can lease. It is for work a gVisor pod cannot do: a kind cluster,
rootful podman, nested privileged containers. The k8s e2e tiers are the
first user. The machine never holds a credential, and it has no network of
its own. While a workspace holds the lease, every connection the machine
makes goes out through that workspace's pod. The pod's egress is the usual
netd redirect and proxy, so the machine gets the workspace's allowlist and
its placeholder-for-real-token swaps.

```
workspace pod (gVisor)                         test machine (VM, root for the holder)
  ssh yaac-machine ──ncat── proxy tunnel ──────▶ sshd :22
        │   (lease = allowlist entry + agent grant)   │
        │◀────── reverse SOCKS (ssh -R 1080) ─────────┤ tun2socks: default route
        ▼                                             │ dnsmasq: every name → sinkhole
  netd redirect → proxy (allowlist, swaps) → internet │ cloud firewall: no outbound
```

Scope: k8s installs only. Under `containerless` there is no proxy, so the
machine's traffic would leave from the host unfiltered. Every route answers
`NOT_SUPPORTED` there, and so does every `yaac-mama machine` command.

## Why it holds

- **The machine has no way out but the pod.** It has a public address for
  inbound ssh and nothing else. A provider firewall that runs outside the
  VM denies all outbound traffic it starts (Hetzner Cloud Firewall: stateful,
  and one outbound rule turns every other outbound connection into a deny).
  Root on the machine cannot change that. Replies to the inbound ssh still
  flow, and the holder's ssh session carries the machine's traffic back into
  the pod.
- **The pod re-sends everything.** `ssh -R 1080` with no destination opens a
  SOCKS proxy on the machine's loopback. Each connection through it starts
  inside the pod, where netd and the proxy treat it as the workspace's own.
  Ports other than 443, 80 and the ssh sentinel are dropped by the pod's
  NetworkPolicy, exactly as for the workspace.
- **No credential ever reaches the machine.** The pod holds only
  placeholders, and the machine gets nothing the pod does not have. The
  machine's login key is in the proxy's ssh-agent, like a git SSH key
  (docs/git-credentials.md), so even the holder never sees it.
- **Release revokes both directions at once.** A lease is two entries in the
  holder's proxy registration: the machine's address in its allowlist, and an
  agent grant for the machine's host key. Releasing rewrites the
  registration. The proxy drops a live tunnel whose host is no longer
  allowed (docs/workspace-egress.md, "When a registration changes"), so the
  ssh session dies, and the machine's SOCKS listener goes with it. The relay
  reads grants per message, so a reconnect gets no signature.
- **It fails closed.** No master connection means no SOCKS listener, so
  everything the machine sends hits a closed port.

**The project is the trust domain.** A previous holder had root and could
leave something behind for the next one. All holders belong to one project:
same owner, same allowlist. Those workspaces already share the project's tool
homes and caches, so persistence between leases opens nothing new. The reset
between leases is housekeeping, not a security boundary. Rebuilding from an
image is the boundary, and it comes later (see "Later").

## The model

A `test_machines` table (migration `add_test_machines`):

| column | |
|---|---|
| `id`, `projectId`, `name` | name unique per project |
| `address`, `port` | what ssh dials, written verbatim into the holder's registration |
| `knownHostsEntry` | the machine's host key, pinned at `add` (trust on first use, shown to confirm, as for git keys) |
| `sealedHolderKey`, `holderPublicKey` | ed25519 seed and public line for the `yaac` account (the holder) |
| `sealedAdminKey`, `adminPublicKey` | the same for `yaac-admin`, which the server uses for reset and check |
| `allowedHosts` | extra hosts the holder's allowlist gets for the lease's duration (registries, release downloads) |
| `state` | `ready`, `leased`, `resetting` or `broken` |
| `leaseWorkspaceId`, `leasedAt` | the holder |
| `lastCheck` | time and verdict of the last check |

The keys are generated and sealed the same way git SSH keys are. Only the
public halves leave the server: `add` prints them for the machine's
bootstrap. A machine holds no secret of its own, so its user data may carry
the public keys. Keep everything else out of user data, because the
provider's metadata service hands it to whatever on the machine asks.

`#domain/machines` (sealed) owns the rows' meaning and the one process
boundary onto a machine: the server's admin ssh. Like `#domain/git`, it is
domain rather than driver because no substrate owns it. What it hands down
is registration content (below), through the driver contract.

## Lease lifecycle

**Acquire** (`yaac-mama machine acquire [<name>]`):

1. A conditional update (`state = ready`, no lease) claims a machine of the
   caller's project: the named one, or any. Two acquires never both win. If
   none is free, the answer names the holders.
2. The caller's registration is rewritten whole from the database, which now
   includes the lease. That adds the machine's address on its port, its
   `allowedHosts`, and an agent grant for its holder key.
3. The answer is an ssh config block. `yaac-mama` writes it to
   `~/.ssh/config.d/yaac-machine`, together with a known_hosts file holding
   the pinned host key.

**Release**, on whichever comes first:

- `yaac-mama machine release`;
- the holder stops, is deleted, or is reaped (workspace teardown releases its
  lease);
- a force release from the webapp or `yaac machine release`;
- the `machine-leases` reconcile step finding a lease whose holder is not
  live, which catches a server that crashed mid-teardown.

Release clears the lease in the database first, rewrites the former holder's
registration (if it still runs), then marks the machine `resetting`. The
reset runs over admin ssh. It kills the `yaac` account's processes, deletes
kind clusters and the work tree, and keeps image and package caches. Then
the check runs, and the machine goes back to `ready`, or to `broken` with the
reason.

There is no waiting and no lease timeout in this version. An acquire that
loses gets an answer naming the holder, and the agent decides whether to
retry. A lease ends only when its holder lets go or stops.

## In the workspace

The config block `acquire` writes:

```
Host yaac-machine
  HostName <address>
  Port <port>
  User yaac
  ProxyCommand ncat --proxy <ssh sentinel>:<tunnel port>   # as GIT_SSH_COMMAND does
  IdentityAgent $SSH_AUTH_SOCK                             # the proxy's relay
  UserKnownHostsFile ~/.ssh/yaac-machine.known_hosts
  StrictHostKeyChecking yes
  RemoteForward 1080                                       # reverse SOCKS: the machine's egress
  ExitOnForwardFailure yes
  ControlMaster auto
  ControlPath /tmp/yaac-machine-%C
  ControlPersist 30m
  ServerAliveInterval 15
```

From there it is plain ssh. `ssh yaac-machine 'cd work && pnpm vitest run
--project e2e'` runs the tests, and `rsync -e ssh` or `git push
yaac-machine:work.git` syncs the checkout. The first ssh opens the master,
so the machine has egress for as long as the agent is using it, plus
`ControlPersist`. A reconnect after a dropped connection is just the next
ssh. The proxy sees the new registration within an informer event, so the
first connect retries for a few seconds.

`yaac-workspace-init` starts the agent socket forwarder only when
`YAAC_SSH_AGENT_UPSTREAM` is set, which today means an SSH remote. The
server also sets it when the project has machines.

## The machine

A shipped bootstrap script (`machine-bin/yaac-machine-setup`), run once as
root while the machine still has outbound access:

- Creates the `yaac` account (passwordless sudo, since kind needs rootful
  podman) and the `yaac-admin` account, each authorized for its one public
  key. sshd is key-only, with `AllowTcpForwarding remote` for `yaac` and no
  forwarding for `yaac-admin`.
- Installs podman, kind, kubectl, node and pnpm, plus a pinned `tun2socks`
  and `dnsmasq`.
- Routes everything through `tun2socks` (`socks5://127.0.0.1:1080`) by
  default. Inbound connections arriving on the real interface are
  connmarked, and their replies are policy-routed back out that interface,
  so sshd's replies never loop into the tunnel. IPv6 is off.
- Sets up dnsmasq to answer every name with the proxy DNS stub's sinkhole
  address. Names never need resolving here: netd redirects by port and the
  proxy routes by SNI or Host header. Answering locally also rules out DNS
  tunnelling.
- Trusts the install's proxy CA, which `add` prints alongside the keys. The
  proxy decrypts the hosts it swaps credentials on.
- Installs `/usr/local/sbin/yaac-machine-reset` for the admin account.

**The check** runs over admin ssh at `add`, after every reset, and on
`yaac machine check`:

- direct egress, bypassing the tunnel (`curl --interface <real iface>` to a
  public address, and DNS to a public resolver), must fail;
- the tunnel's pieces must be present;
- the holder account must work.

The machine reports its own result, so a machine whose root has been
compromised can lie. This check catches an operator mistake (a firewall
never attached, or detached later), which is the failure that actually
happens. `add` refuses a machine that fails it.

**Provisioning** stays outside the server: a machine is any VM the operator
registers. `infra/hetzner-k3s` gains a `test_machines` map (name to project,
server type):

1. A bootstrap server runs the setup script with outbound access open and is
   snapshotted.
2. Each machine is created from that snapshot, already behind a firewall
   that allows inbound tcp/22 and denies all outbound.

Keep machines off the cluster's private network. Hetzner private networks
have no access controls, and from there root could reach the k3s API, the
kubelets and the NFS export.

## Surfaces

**yaac-mama** gains `machine list`, `machine acquire [<name>]` and
`machine release`. All three are scoped to the caller's project, like every
other mama command. `list` shows each machine's state and its holder (with
`(you)`). Update the skill text and the script's usage together.

**CLI** `yaac machine`, for the project owner:

- `add <project> <name> --address A [--port P] [--allow-host H]...` prints
  the public keys, the CA and the bootstrap command, then runs the check;
- `list [<project>]`;
- `check <project> <name>`;
- `release <project> <name>`;
- `set-hosts <project> <name> <host>...`;
- `remove <project> <name>`, which releases the lease first.

Every argument and option gets an e2e-cli test.

**Routes** under `/api/projects/:id/machines`: list, add, remove, check,
release, and the hosts edit. Each gets a route-matrix row with
`containerless` answering 501 `NOT_SUPPORTED`. The snapshot carries each
project's machines (state and holder) on both drivers, and is empty under
containerless.

**Webapp**: a "Test machines" section in project settings (add, keys, check,
force release, remove), and a badge on the workspace that holds one.

## Proxy changes

- The registration gains `machines: [{ host, port, knownHostsEntry }]`. A
  CONNECT on the tunnel listener to a machine's host and port is admitted
  for its holder. The machine's `allowedHosts` simply join the
  registration's `allowedHosts`.
- The relay's grants for a workspace are its project's SSH grants plus one
  grant per leased machine: the holder key, for that machine's host key. A
  machine's holder key travels in the project owner's `ssh-keys.json` with
  no project grants, so it only ever signs for a lease holder. The relay
  also stops refusing a workspace whose registration names a machine but
  whose remote is not SSH.
- The live-tunnel re-check covers machine admission, so a release drops the
  session.

## Testing

- **`unit:server`**: `test/domain/machines/`, faking admin ssh at spawn and
  the cluster with `fakeCluster`. One rich test file covers acquire races,
  release on stop, the reconcile sweep, reset and check failures, and asserts
  on the registration the driver writes.
- **Proxy unit tests**: machine admission and the relay's machine grants,
  including a sign refused after the registration narrows.
- **Route matrix** rows on both columns; `write-routes.test.ts` covers the
  behavior.
- **e2e (host-only)**: one `machines-suite` file. A podman container running
  sshd, tun2socks and dnsmasq, on a podman network with no route out,
  stands in for the VM and its firewall. One workspace fixture covers:
  - acquire, then ssh;
  - from the machine, an allowlisted fetch succeeds, and a blocked host is
    refused and shows on the workspace;
  - a second workspace's acquire is refused;
  - release drops the session and the machine loses egress.

  Teardown-on-stop runs last.

## Phases

1. **Datapath.** The proxy changes, the registration field, the setup script
   and a hand-seeded lease. This proves an e2e run from a workspace on a real
   Hetzner machine before any product surface exists.
2. **Product.** Table, `#domain/machines`, mama commands, CLI, routes,
   reconcile step, reset and check.
3. **Webapp.**
4. **`infra/hetzner-k3s`** snapshot and machine module, with its README.

On shipping, fold this into `docs/test-machines.md`, add the machine paths
to docs/workspace-egress.md, and delete this plan.

## Later

- **Rebuild between leases** from the snapshot through the provider's API,
  making each lease a clean machine. With that, a machine could be shared
  across projects. It is also how a provider integration could verify the
  firewall from outside instead of trusting the machine's report.
- **Waiting**: `acquire --wait`, or a queued workspace that starts when a
  machine frees.
- **The sandbox driver** (docs/plans/sandbox-driver.md) has the same proxy,
  so it could lease machines once its per-listener identity exists.
