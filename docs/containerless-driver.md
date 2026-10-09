# The containerless driver

yaac runs a workspace on one of two substrates. The `k8s` driver gives each
workspace a single-pod Job in a local cluster, built from an image and
reached through an egress proxy. The `containerless` driver gives it a tmux
server on the host, in the checkout the server already made: no image, no
cluster, no proxy and no sandbox.

It is for machines that cannot run the k8s driver (podman and kind are hard
on macOS and impossible on a locked-down laptop), and for people who want
agents working on the real machine. The cost is isolation: an agent here
runs as the user running yaac, with all of that user's access. Choosing this
driver means accepting that.

```
yaac server start        # a host server is always the containerless one
yaac host check          # the counterpart of `yaac cluster check`
```

There is no driver flag. The k8s server is a pod of the cluster it manages
(docs/server-in-cluster.md) and this one is a process on your machine, so
`yaac server start` means containerless and `yaac cluster install` means
k8s. The command that stands the server up records the driver in
`server.json` (docs/server-selection.md), so a client that cannot reach the
server knows whether the fix is a start or an install.

The two never share a data dir: a host start against a data dir recorded as
`k8s` is refused, and `yaac cluster install` refuses a containerless one. A
k8s server cannot see tmux workspaces. It would reap their rows and its
teardown would delete the state dirs holding their markers, leaving agents
running as the user with nothing able to reach them.

## What a workspace is here

A workspace is its tmux server, as it is its Job under k8s: running means
up, exited means gone. It outlives the yaac server, so `yaac server restart`
never stops an agent.

Each workspace has its own tmux server and socket; with one shared socket,
`has-session -t yaac` and `respawn-window -t yaac:<tool>` would answer for
whichever workspace came first. Sockets live under the OS temp dir because
`sockaddr_un.sun_path` is about 104 bytes on macOS and data-dir paths are
longer. The temp dir name is keyed by the data dir, so two servers on one
host never collide.

The session has the same shape as the one `workspace-bin/yaac-workspace-init`
creates in a pod (the placeholder the stale reaper looks for, `sleep
2147483647` here because macOS's sleep has no `infinity`; the `yaac:<tool>`
window names the status watcher parses; the tmux options the webapp terminal
needs), because that machinery is shared by both drivers.

## Paths

Every tmux command, `git -C` call and prompt script written above the driver
layer uses `WorkspacePaths`: where this workspace's things are, as the
workspace sees them. The pod driver answers with fixed container paths,
since each pod has its own mount namespace. This driver answers per
workspace, since all workspaces share one filesystem.

| | k8s | containerless |
|---|---|---|
| checkout | `/workspace` | `~/.yaac/global/projects/<project-id>/workspaces/<id>` |
| project main clone | the server's own path, read-only | `~/.yaac/global/projects/<project-id>/repo/.git` |
| tmux socket | `/tmp/yaac-tmux/server` (pod-local) | `$TMPDIR/yaac-<hash>/<short-id>.sock` |
| scratch | `/tmp` | `<state dir>/containerless/scratch` |
| ACP record | `/home/yaac/.yaac-acp` (mounted) | `~/.yaac/global/projects/<project-id>/acp/<id>` |

The state dir is `~/.yaac/global/projects/<project-id>/sessions/<id>`.

The ACP record is not driver-private: under k8s the container path is a
mount of the shared project location, and every reader (the chat pane, the
first-prompt capture, a stopped workspace's transcript) opens that location. It
must also outlive the state dir, which a stop removes, so a stopped
workspace's conversation stays readable (docs/agent-modes.md).

The review diff is plain host `git` in the checkout. The checkout is its own
clone whose only path-dependent git state is the alternates line pointing at
the main clone's objects (docs/server-git.md). A pod mounts the main clone at
the same path, and every launch on either driver rewrites the line
(`buildCloneLinkExec`), so a stopped workspace can restart on either
substrate. Stop the old substrate's workspaces before switching: neither
server sees the other's, so neither would notice two agents in one checkout.

## Storage

The data dir has the same three tiers on every substrate: `global/`,
`server-local/` and `node-local/` under `~/.yaac` (tier legend in
`packages/shared/src/paths.ts`). Under k8s they are volume claims and a node
hostPath; here they are plain subdirectories. Global and node-local paths are
symlinked into the workspace's HOME the same way. The only difference: a
node-local source dir that does not exist yet (the project's pnpm store, on
its first workspace) is created by the driver, where a pod's init container
would create it.

## Mounts become symlinks

The driver contract lets a host-process driver realize a hostPath mount "as a
bind or a symlink". This one uses symlinks, since bind mounts need root.
Each workspace gets a private `$HOME` under its state dir, with the project's
tool homes (`claude`, `codex`, `pi`, the opencode config) linked in, and a
private bin dir on `PATH` holding the helper scripts a pod has in
`/usr/local/bin`.

This driver inherits the host environment, where the user may have pointed a
tool elsewhere. Left alone, the agent would silently use the server user's
own config and credentials, and write transcripts where yaac never looks. So
tool homes are handled two ways:

- **Named.** Where a tool has a home override, every create sets it:
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR` and pi's session
  dir. Creates write these as container paths on both drivers; here each is
  translated to the host dir its mount came from, the project's shared one.
- **Cleared.** Any variable that could redirect a tool without an override
  is removed, along with the server's `YAAC_*` settings. The named variables
  are cleared too, so no host value survives even if a create forgets one.

opencode is why clearing is needed. It has no home override:
`OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` add
config inputs, so a host `OPENCODE_CONFIG_DIR` would load the server user's
config and provider keys. Its real homes come from `XDG_CONFIG_HOME` and
`XDG_DATA_HOME`, which, once cleared, resolve through the `$HOME` links.
(yaac's own `OPENCODE_CONFIG_CONTENT` is set on the launch command line,
after the clearing.)

The clearing also removes the variables a claude session sets on processes
it spawns (`AGENT_SESSION_VARS`: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
session id, pid, trace context, messaging socket), which the server carries
when an agent started it. A claude that inherits `CLAUDE_CODE_CHILD_SESSION`
stops saving its transcript. `GIT_EDITOR=true`, which that session also sets,
is dropped only as that exact value alongside `CLAUDECODE`; otherwise it is
the user's preference.

The translation points at the mount's source, not the workspace's
`$HOME/<tool>` link. Both reach the same files, but claude keys its macOS
Keychain item on the path string, and on first token refresh it moves the
credential into that item and deletes `.credentials.json`. A per-workspace
string would let the first refresh in any workspace delete the file every
other workspace of the project uses. Keeping the rule in the translation
means no call site can get it wrong.

Naming the claude config dir also moves claude's global config: claude reads
`<$CLAUDE_CONFIG_DIR or home>/.claude.json` and never the other. So the
seeded onboarding state, API-key approval and trusted folders live in the
`.claude.json` inside the claude home on both drivers, with no separate
mount.

Signing out (`yaac auth clear`, or the webapp) therefore clears both the
file and the Keychain item, since the live token may exist only in the
Keychain. The item is per project, and the delete refuses the un-suffixed
service name, so the user's own claude install is never touched.

None of this is visible inside a workspace, so `yaac host check` lists the
host variables that will be overridden or cleared, and a create mentions them
in its progress output.

### Mounts that are not realized

**Mounts into the checkout.** A pod mounts cache volumes under `/workspace`
onto separate storage that git never sees. A symlink there would show as
untracked (`git add -A` would commit an absolute host path) and trip the
ephemeral-modules guard. The checkout is already on local disk, so nothing
is lost. Module dirs (`ephemeralModulesPaths`) also stay in the checkout;
a stop deletes them and a restart's init commands rebuild them.

The rebuild is a relink, not a download, because every workspace uses the
project's shared `.cached-packages/pnpm-store`: the create sets
`pnpm_config_store_dir` (and `npm_config_store_dir`, for pnpm 10) to it. A
shared store is safe only here: pnpm indexes it in SQLite in WAL mode,
which needs every writer on one kernel, and pods are not (each keeps its own
store; docs/workspace-storage.md "Package installs"). Otherwise pnpm would
put a full store in each private HOME, kept alive by the checkout's
hardlinked `node_modules` after the HOME is deleted.

**Nested mounts.** A pod mounts the project's claude dir at
`/home/yaac/.claude` and then a builtin skill inside it. Here the first is a
link into shared state, so the second would write into a directory every
workspace reads. Nested mounts are skipped and logged; builtin skills and
agent history write host state instead (below). A mount with no host
equivalent fails the create.

## Agent history

A pod reaches its conversations through mounts over the tool homes
(docs/workspace-storage.md "Agent history"). The two with an env override
(codex's sqlite home, pi's session dir) are handled like any other mount.
The other three (claude's `projects/` and `file-history/`, codex's
`sessions/`) would be nested, so the create plants links in the shared homes
instead:

- The folder claude files this checkout's conversations under (named from
  the cwd by claude's rule, for every spelling of the data dir) links to the
  history's `claude/-workspace`.
- That folder's `memory` links to `-repo/memory`, so claude's auto-memory
  is the one a pod uses.
- Each file-history dir and codex rollout already in the history is linked
  where its tool looks.

A new rollout or file-history dir stays a real file in the shared home until
the next create moves it in. This isolates nothing; it keeps the layout the
same on both drivers so an install can switch.

## Builtin skills

In a pod, yaac's skills are a per-workspace staging dir mounted read-only
over each tool's skills root. Here a create links them into the project's
shared skills roots instead:
`<data>/projects/<project-id>/{claude,codex,…}/skills/<name>` points at the
install's `builtin-skills/<name>`. All four tools' roots are written. They
are per project because those dirs are already shared, and links rather than
copies keep them in step with the running yaac version.

Only yaac's own links are written or removed. A name the user owns (a real
dir, or a link pointing outside a `builtin-skills` dir) is left alone. A
yaac link pointing at a moved install is re-pointed on the next create, and
one for a skill no longer shipped is removed. Ownership is per machine, not
per install, because a versioned global install moves on every upgrade; two
installs sharing a data dir will disagree over skills only one ships.

One function, `reconcileSharedSkillRoots`, handles both drivers and takes the
target delivery as an argument, so each can undo the other after a switch.
The link delivery replaces the empty dir a pod leaves at each mounted name.
The mount delivery replaces a yaac link with an empty dir for the pod to
mount over, and creates it itself so the server owns it (a kubelet-created
mountpoint is root-owned). Both claim only names this install ships, prune
links for skills it no longer ships, and run on every create and restart.

The pod's mount is read-only; a symlink is not. An agent writing
`~/.claude/skills/<name>/SKILL.md` here edits the install itself: lost on an
npm upgrade, or an edit to a dev checkout's working tree. A symlink cannot be
made read-only (`chmod` follows it and would block upgrades), and linking to
a frozen copy would lose the version lockstep.

The same skill text reaches both drivers, so it may only assume what a host
has; there is no image supplying `Dockerfile.default`'s utilities. The same
applies to the helper scripts in the private bin dir. So skills filter GitHub
JSON with `gh --jq` rather than piping to `jq` (`yaac-watch-prs` needs only
`gh`), and find the repo with `git rev-parse --show-toplevel`, using
`/workspace` only as a fallback.

## Credentials are real

Under k8s a workspace holds only a sentinel value, and the egress proxy
swaps in the real token on the way out. Here there is no proxy, so
containerless workspaces get real OAuth bundles in the per-project tool
homes and real API keys and `GH_TOKEN` in the environment (opencode's and
pi's under variables of their own; see docs/workspace-egress.md). Nothing
separates the agent from this machine, so there is nothing to hide a secret
from. A project that cannot accept that should use the k8s driver.

### Keeping refreshed credentials in sync

An agent holding the real bundle also refreshes it. Refresh tokens rotate,
so afterwards the project's tool home holds the live credential and its
owner's store a spent one. Using a spent token fails, and for Codex (single-use
tokens) it can break the chain. Under k8s every refresh passes through the
proxy, which updates the owner's store. Here `#domain/auth`'s
credential-sync closes the loop, per user: a project's tool home only ever
holds its owner's credential.

The rule: **the newest credential wins, and both sides converge on it.**
Harvest copies a project's refreshed bundle to its owner's store; push
copies the owner's bundle to their projects that are behind. Seeding a create runs
harvest then push, so it can only move a project forward rather than undo a
running workspace's rotation.

- **A sentinel is never a credential.** It is never harvested and never
  counts as up to date. So the same code runs under k8s, and a nested
  yaac-in-yaac install (whose "real" credential is the outer proxy's
  sentinel) is never adopted or overwritten.
- **On macOS a Claude credential ends up in the Keychain.** claude moves it
  there on first refresh and deletes the file, so a file still present is the
  older copy and harvest reads the Keychain first. Push writes the file and
  deletes the stale item, so claude moves the fresh file in again. yaac never
  creates an item.
- **The host does not refresh a credential a running workspace holds**,
  since that would invalidate the agent's copy. With a workspace live, the
  plan-usage check uses whatever the agent produced and refreshes only when
  nothing is running. A briefly missing usage readout beats signing a
  running agent out.

Sync runs where staleness would cause a failure: before a host-side refresh,
before seeding a create, on workspace stop, and from a reconcile step that
runs at most every five minutes, first on the pass that follows attach (on
macOS each sweep spawns one `security` process per project). Each project keeps its own copy and catches up on the
next push. An explicit sign-in ignores newest-wins: it is the user choosing
the account, so it is written to every project.

### Never refreshing a credential this install does not own

A refresh grant spends the old refresh token and issues a new one, signing
out anyone holding the old copy. So the server never presents a sentinel
refresh token, and the grant functions refuse to (`mayPresentRefreshToken`).
A sentinel means an outer install (yaac inside a yaac workspace) owns the
real credential; presenting it would make the outer proxy rotate the real
token while this server stores nothing, leaving every outer workspace with a
spent token.

For the same reason the test suite forbids refresh grants entirely
(`YAAC_E2E_NO_TOKEN_REFRESH`, set in the shared vitest setup and every
spawned test server). A proxy rewrites the `refresh_token` of any POST to a
token endpoint regardless of what was sent, so a suite running in a
workspace would rotate the host's live credential even with a fake token.
Fixture expiry times do not help: they only decide whether a refresh is
attempted, and the attempt is the damage.

### Git credentials

The checkout's `origin` has no token (server-side git adds it per command),
and the private `HOME` hides the user's `~/.gitconfig` and `~/.ssh`. In a
pod the proxy adds the credential in flight. Here the launch receives the
resolved credential and writes it into the workspace's home: an HTTPS token
becomes a line in `$HOME/.git-credentials`, git's credential store default
file.

An SSH key is never written to disk. The launch starts an **ssh-agent per
workspace**, detached beside the tmux server, and pipes yaac's generated key
(docs/git-credentials.md) into `ssh-add -`. Only the public half goes in the
home, named by `GIT_SSH_COMMAND` with `-i` and `IdentitiesOnly`, so ssh does
not offer every key the agent holds (which could lock the account). The
agent's pid is stored in the workspace marker so teardown stops it and
recovery can tell a live agent from a stale socket. A state dir can outlive
a workspace whose host rebooted, so recovery also clears the credential
store of any workspace it finds dead. Host keys use the same project-scoped
known_hosts as the pod path.

The credential helper list is reset before `store` is added, so a system
credential manager cannot answer first. `GIT_CONFIG_GLOBAL` points at the
file the launch wrote, since an inherited value would hide it, including
identity and trusted directories. The workspace's SSH command omits the Tor
options the server's own git uses; see "Egress control" below.

## `yaac-mama`: how a workspace reaches its server

`yaac-mama` lets an agent run a small subset of the yaac CLI against its own
server: list the project's workspaces, start one, message a running one's
agent, retitle one, stop one (including itself), and manage sidebar groups.
Stop is allowed because it is reversible; delete, restart and reconfigure are
not. Both drivers support it with different transports. A workspace stopping
itself gets a best-effort reply, since the stop tears down what the reply
travels over; the session ending is the confirmation.

**Under k8s** a pod cannot dial the server: the server's ingress policy
admits no workspace pod (docs/server-in-cluster.md), and the pod holds no
credential for it. So the pod POSTs to the egress proxy, which relays the
call to the server, naming the caller by pod IP (docs/workspace-egress.md
"yaac-mama").

**Here** the workspace POSTs straight to `/workspace/mama` with a bearer
token minted at create and passed in its environment (`YAAC_MAMA_TOKEN`,
with `YAAC_MAMA_URL`). The server stores only its SHA-256 on the workspace
row. The token alone identifies the caller, so a request cannot claim to be
another workspace. It is not a security boundary (the agent could run the
`yaac` CLI directly as the user); it gives attribution, so `list` and
`create` resolve to the right project.

Both transports end at `runMamaCommand` in `#domain/workspaces`, which holds
the allowlist. `YAAC_MAMA_URL` is fixed at launch because the tmux server
keeps its environment for life; if the server moves to a different port,
running workspaces must be restarted to reach it.

## Permission modes

In a sandbox the default mode is `bypass`, since the container contains the
agent. Without one the default is `accept-edits`: edits in the workspace go
through, while shell commands, writes outside it and network access still
ask. This applies to chat (ACP) workspaces too. pi has no permission system
(docs/agent-modes.md), so `bypass` is its only mode on both drivers.

The default is the last fallback: a create uses the mode the request names,
else the one this project last chose for that agent, else the default (see
docs/permission-modes.md). The result is stored in
`workspaces.permissionMode` so a restart relaunches agents the same way.
`bypass` can still be requested; here it means the agent acts as the user on
the user's machine and credentials, and the create says so in its progress
output.

## Observation and recovery

With no informer, the driver tracks liveness with one output-suppressed tmux
control-mode client per running workspace. It never writes to tmux, and it
is not attached `read-only`: from tmux 3.7, a command-line `send-keys` is
refused while any read-only client is attached. tmux ends every client when its
server dies, so the client's exit is the workspace's death. Its stdin must be
a pipe held open, because a control-mode client exits when stdin closes.

Recovery is the normal path. On start the server reads the marker files it
wrote (`global/projects/<project-id>/sessions/<id>/containerless/workspace.json`,
the equivalent of a Job object) and probes each socket. A live socket is a
running workspace, recovered with its agents still working. A dead one is
recorded as a dead workspace, not dropped, so the stale reaper marks its row
stopped. Recovery runs after the server starts answering, so early clients
see workspaces appear.

Every command the server runs in a workspace (exec, stream, changes diff)
gets the workspace's environment, not the server's, whose `YAAC_*` settings
and host `HOME` would point it at the server user's config. After a restart
the server rebuilds that environment from the marker, which stores the
launch's own entries. tmux's environment dump cannot be used because it does
not escape multi-line values. Secrets (`secretEnvKeys` on the spec: API
keys, `GH_TOKEN`, proxied project secrets, the `yaac-mama` token) are left
out of the marker; they live encrypted in the database and in the tmux
server's memory, never in a file.

By default tmux copies an attaching client's `SSH_AUTH_SOCK` (and a few
other variables) into the session environment. So the launch empties
`update-environment` in the same command that creates the session, or the
liveness client would hand the panes the host's ssh-agent.

## Ports

Here the workspace's processes bind host ports directly, so a listener is
already reachable on this machine and the mapping is the identity. Ports
appear as `forwardedPorts`; `unforwardedPorts` is always empty, there is no
"forward this" action, and a config's `portForward` entry is just the port
the dev server binds.

Detection polls each running workspace's process tree every 3 seconds
(`lsof` over the tmux server's descendants), with the same sensitive-port
filter as the k8s driver. Other listeners on the machine are ignored.

A client on another machine still needs the tunnel
(docs/port-forward-tunnel.md). Each connection reaches `dialPort`, which
connects to the address the sweep saw the port bound to (a wildcard listener
is dialled on its own family's loopback). Only surfaced ports can be
dialled, so the workspace's process tree acts as an allowlist. A yaac dev
workspace's inner `yaac server` is in that tree, so it is dialable, as under
k8s. A port released and re-bound by something else stays dialable until the
next sweep.

## What this driver does not do

Each of these answers empty, `null` or a no-op at the driver, as the contract
specifies, so the snapshot includes every feed without branching. Their API
routes refuse with `NOT_SUPPORTED` (501): `[]` from `GET /image/builds`
would read as "no builds running" rather than "this server never builds".
The webapp reads `snapshot.driver` and hides these features.
`test/api/route-matrix.ts` lists every route's answer under both drivers.

- **Images and builds.** Nothing is built.
- **Egress control.** No blocked hosts, git-auth failure reports or
  allowlist; a workspace reaches whatever the user can. Under k8s
  `YAAC_USE_TOR` routes a pod's traffic through the proxy's Tor agent; here
  it covers only the server's own git. The server warns at start rather than
  set `ALL_PROXY` or an ssh ProxyCommand, which undici, raw sockets and the
  agent's shell would bypass. Silently leaking traffic is worse than a
  stated gap.
- **Nested containers.** A project config with `nestedContainers` is
  rejected at create.
- **Prewarmed spare workspaces.** A tmux server in an existing checkout has
  no image pull or pod boot to save.
- **Per-workspace module caching.** See "Mounts that are not realized".

## Host requirements

`yaac host check` verifies these, and the driver logs hard failures at
startup.

- **tmux** 3.1+ (webapp terminals use `window-size latest`) and **git**:
  required. A create checks them up front rather than failing halfway
  through `launchWorkspace`.
- **node** 22+ **with npm**: required. npm installs every agent, codex and
  pi are node scripts, and `--mode acp` runs yaac's acpd under `node`. The
  pinned agents need 22; Debian and Ubuntu `apt install nodejs` is older and
  lacks npm. A server started by a node not on `PATH` (like the desktop
  app's bundled one) is the usual way to be missing it.
- **socat**: required for `--mode acp`, whose chat transport uses it to dial
  acpd; `yaac host check` only warns, and an acp-mode create refuses.
- **lsof**: port detection. Without it workspaces report no ports.
- **curl**: used by `yaac-mama`.

Tools the agents themselves use (`ripgrep`, `fd`, `gh`, `jq`) are not
checked, matching what the builtin skills assume; pi downloads its own `fd`
if needed. The `yaac-server` Homebrew formula installs the useful ones anyway.

### Agent binaries

Every agent CLI and ACP adapter is yaac's own install of the version the
image pins (`AGENT_CLIS`, `ACP_ADAPTERS`; the package table is
`AGENT_PACKAGES` in `@yaac/shared/tool-install`), never the host's. yaac maps
permission modes to each CLI's flags and reads its reports back, and an
unpinned version breaks that without an error (a codex older than the latest
release, for example, shows an "Update available" screen that swallows the
prompt). So the launch puts
`<data>/node-local/agent-tools/<package>@<version>/bin` ahead of the host
`PATH`, shadowing the user's install only inside workspaces.

Each package is installed on first need with `npm install --global --prefix`
into a staging dir, renamed into place once the binary exists; a later
create treats the prefix's existence as "installed", so an interrupted
install must leave nothing that looks complete. `--engine-strict` makes npm
fail on a too-old node instead of warning. Staging dirs older than the
install timeout are deleted before the next install. npm runs without the
server's `YAAC_*` settings, and lifecycle scripts run only for claude and
opencode, whose postinstall places their native binary. Prefixes are named
by version and never change, so a pin bump installs alongside and running
workspaces keep their version. Old prefixes are never removed.

### Missing tools

A launch command that runs nothing exits 127, tmux closes the window, and the
workspace vanishes seconds after the create reported success. Two checks
prevent that:

- Before provisioning, the create calls `assertCanLaunch`: `tmux` and `git`
  always, plus `node` and `socat` for `--mode acp`, checked in dependency
  order. A miss refuses with `MISSING_TOOL` and install instructions. socat
  is included because without it the chat pane never attaches and looks like
  a hung agent. The create then installs any pinned binary it still needs
  (the tool for `--mode tui`; for `--mode acp` its adapter, plus the CLI if
  the adapter drives one), reporting progress.
- After launch, an unawaited probe checks that the agent windows survived,
  catching a binary that is present but broken. A failure appears a moment
  later as a failed provisioning row.

## Testing

`pnpm vitest run --project e2e-containerless` drives the real CLI against a
real containerless server. It needs no cluster or images and runs in
parallel. A fake agent, placed where yaac installs the pinned one, stands in
for real agents, since the tests cover launch, exec and recovery rather than
agent behavior. The driver's unit tests mock `host.ts`, its whole process
boundary.
