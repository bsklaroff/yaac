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
k8s. The command that stands the server up records the driver in its data
dir's `install.json` (docs/server-selection.md), so a client that cannot
reach the server knows which command brings it back.

The two never share a data dir: by default this one is `~/.yaac-server` and a
cluster's is `~/.yaac-cluster`, so both can run on one machine. A host start
against a data dir recorded as `k8s` is refused, and `yaac cluster install`
refuses a containerless one. A
k8s server cannot see tmux workspaces. It would reap their rows and its
teardown would delete the state dirs holding their markers, leaving agents
running as the user with nothing able to reach them.

## What a workspace is here

A workspace is its tmux server, as it is its Job under k8s: running means
up, exited means gone. It outlives the yaac server, so `yaac server restart`
never stops an agent.

Each workspace has its own tmux server and socket; with one shared socket,
`has-session -t yaac` and `new-window -t yaac` would answer for whichever
workspace came first. Sockets live under the OS temp dir because
`sockaddr_un.sun_path` is about 104 bytes on macOS and data-dir paths are
longer. The temp dir name is keyed by the data dir, so two servers on one
host never collide.

The tmux session has the same shape as the one
`workspace-bin/yaac-workspace-init` creates in a pod (the keeper window the
stale reaper looks at, `sleep 2147483647` here because macOS's sleep has no
`infinity`, docs/sessions.md; the tmux options the webapp terminal needs),
because that machinery is shared by both drivers.

## Paths

Every tmux command, `git -C` call and prompt script written above the driver
layer uses `WorkspacePaths`: where this workspace's things are, as the
workspace sees them. The pod driver answers with fixed container paths,
since each pod has its own mount namespace. This driver answers per
workspace, since all workspaces share one filesystem.

| | k8s | containerless |
|---|---|---|
| checkout | `/workspace` | `~/.yaac-server/global/projects/<project-id>/workspaces/<id>` |
| project main clone | the server's own path, read-only | `~/.yaac-server/global/projects/<project-id>/repo/.git` |
| tmux socket | `/tmp/yaac-tmux/server` (pod-local) | `$TMPDIR/yaac-<hash>/<short-id>.sock` |
| scratch | `/tmp` | `<state dir>/containerless/scratch` |
| ACP record | `/home/yaac/.yaac-acp` (mounted) | `~/.yaac-server/global/projects/<project-id>/acp/<id>` |
| `$HOME` | `/home/yaac` | the user's own |
| git config | `/home/yaac/.gitconfig` | `<state dir>/containerless/gitconfig` (`GIT_CONFIG_GLOBAL`) |

The state dir is `~/.yaac-server/global/projects/<project-id>/sessions/<id>`.

The ACP record is not driver-private: under k8s the container path is a
mount of the shared project location, and every reader (the chat pane, the
first-prompt capture, a stopped workspace's transcript) opens that location. It
must also outlive the state dir, which a stop removes, so a stopped
workspace's conversation stays readable (docs/agent-modes.md).

The review diff is plain host `git` in the checkout. The checkout is its own
clone whose only path-dependent git state is the alternates line pointing at
the main clone's objects (docs/server-git.md). A pod mounts the main clone at
the same path, and a launch on either driver that reuses a checkout rewrites
the line (`buildCloneLinkExec`).

## Storage

The data dir has the same three tiers on every substrate: `global/`,
`server-local/` and `node-local/` under `~/.yaac-server` (tier legend in
`packages/shared/src/paths.ts`). Under k8s they are volume claims and a node
hostPath; here they are plain subdirectories, which a workspace reaches by
path. The only difference: a node-local source dir that does not exist yet
(the project's pnpm store, on its first workspace) is created by the driver,
where a pod's init container would create it.

## The workspace's environment

A workspace runs with the user's own `$HOME`, PATH and toolchain: their
`~/.kube`, cloud profiles, `~/.npmrc`, language caches and shell setup all
apply, as they would in any terminal. Nothing here is isolated, so hiding
them would only make the machine harder to use. (OpenSSH reads its config
and keys from the account's passwd home whatever `$HOME` says, so `~/.ssh`
applies too.)

What yaac does need is for the agents, git and gh to use the project's
config and credentials rather than the user's, since sessions, sign-ins and
reporting are per project on both drivers. The driver gets that from the
environment, by variables it names and variables it clears.

- **Named.** Where a tool has a home override, every create sets it:
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR` and pi's session
  dir. Creates write these as container paths on both drivers; here each is
  translated to the host dir its mount came from, the project's shared one.
  The pnpm store (below) is named the same way. The launch adds
  `GIT_CONFIG_GLOBAL` and `GH_CONFIG_DIR`, both in the driver's state dir.
- **Cleared.** Any variable that could redirect a tool without an override
  is removed (`TOOL_HOME_VARS`: `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG` and
  `OPENCODE_CONFIG_CONTENT` add config inputs, so a host value would load the
  user's own config and keys), along with the server's `YAAC_*` settings.
  The named variables are cleared too, so no host value survives even if a
  create forgets one. (yaac's own `OPENCODE_CONFIG_CONTENT` is set on the
  launch command line, after the clearing.)

The clearing also removes the variables a claude session sets on processes
it spawns (`AGENT_SESSION_VARS`: `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`,
session id, pid, trace context, messaging socket), which the server carries
when an agent started it. A claude that inherits `CLAUDE_CODE_CHILD_SESSION`
stops saving its transcript. `GIT_EDITOR=true`, which that session also sets,
is dropped only as that exact value alongside `CLAUDECODE`; otherwise it is
the user's preference.

Under the real `$HOME`, anything an agent writes to a fixed path there
would be shared by every workspace and the user's own sessions. The pinned
CLIs and adapters keep to their home variables, with one exception that
yaac's patch fixes: pi-acp's session map and prompt commands follow
`PI_CODING_AGENT_DIR`, as pi's do, rather than `~/.pi`
(`dockerfiles/agent-patches/pi-acp.js`).

gh gets a config dir of its own, so it never sees the user's own login. An
HTTPS GitHub project's workspace is logged in through `GH_TOKEN`; any other
project's gh is logged out, and a `gh auth login` in a pane lasts until the
workspace stops.

Each mount a create declares already has a route here, so none is bound
(that would need root):

| Pod mount | Here |
|---|---|
| the tool homes, history dirs and pnpm store under `/home/yaac` | the env value naming each |
| `.config/opencode`, `.local/share/opencode` | links in the opencode wrapper's dirs (below) |
| the helper scripts in `/usr/local/bin` | their staging dir, first on PATH |
| the ACP record and attachments | `WorkspacePaths` |
| the checkout and main clone | already in place |

Any other mount refuses the create, so a mount can never quietly write into
the user's home.

The translation points at the mount's source rather than any per-workspace
path, because claude keys its macOS Keychain item on the path string, and on
first token refresh it moves the credential into that item and deletes
`.credentials.json`. A per-workspace string would let the first refresh in
any workspace delete the file every other workspace of the project uses.
Keeping the rule in the translation means no call site can get it wrong.

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

### opencode

opencode has no home override: its config, data, state and cache come from
the XDG base dirs. Setting those for the whole workspace would hide the
user's XDG layout from every other tool, so the launch writes an `opencode`
wrapper into the driver's bin dir, ahead of the pinned agents on PATH, which
sets them for opencode alone and runs the pinned binary. Config and data
are links to the project's dirs. State and cache are the workspace's own: a
plain `opencode` registers and joins a background service in its state dir,
and that service keeps the environment of the first client that started it,
so a shared one would run a later workspace's reporter with the first one's
`YAAC_*` values. yaac's launches and an `opencode` typed in a pane both go
through the wrapper; the commands opencode runs inherit its XDG values.

### Shell startup

The user's rc files run in a workspace's shells, and an rc may export its
own `CLAUDE_CONFIG_DIR` or `GH_TOKEN`, or put its own `claude` first on
PATH. yaac's settings must win over those, while the rest of the user's
setup applies.

So every shell reads yaac's startup files around the user's own: after the
user's files it re-applies the `YAAC_SHELL_ENV` file, which the launch
writes with every entry it set (credentials such as `GH_TOKEN` included,
so owner-only), the tool-home variables it cleared, and the PATH prefix.
Anything else the rc sets, `YAAC_DATA_DIR` included, stays the user's. The
files are shipped in `host-shell/`, and also name the checkout `~workspace`
for prompts.

tmux runs every window command as `default-shell -c`, so launches run in
the user's shell as a pod's do in zsh, and `SHELL` is the user's in panes
and agents. tmux sets a pane's `SHELL` to its `default-shell`, and fixes a
pane's shell when the pane is created, so the shell options are set before
the session. Each launch command is POSIX sh, and `exec`s its program so
the pane's pid is the agent's. A pane opened without a command starts the
user's shell through `default-command`, as a login shell.

- **zsh**: `ZDOTDIR` points at a dir in the state dir linking
  `host-shell/zsh`'s files, since zsh writes there while it does (Debian's
  global `compinit` dump). Those files source the user's
  (`YAAC_USER_ZDOTDIR`, else `$HOME`) with `ZDOTDIR` set as those expect,
  then the env file, which points `ZDOTDIR` back at them. So every zsh, a
  launch's `zsh -c`, a nested one and a zsh script, starts through them.
  `ZDOTDIR` is set whatever the user's shell, since an agent may start a
  zsh of its own (claude does). `hash -d` names the checkout.
- **bash**: every non-interactive bash, a launch's `bash -c` and `bash -lc`
  included, reads the env file as its `BASH_ENV`, after the user's profile.
  A pane starts `bash --rcfile`, since a login shell reads none, and the
  rcfile reads what a login shell would. A nested interactive bash (`bash`,
  `bash -ic`) reads `~/.bashrc` with nothing after it, so there the user's
  rc wins. A `PROMPT_COMMAND` stands in for `\w`.
- **fish** has no hook after `config.fish` but its `-C` flag, which tmux
  cannot pass to a launch. So a fish user's launches, like those of any
  other shell, run under `/bin/sh`, which reads no rc, and agents there see
  `SHELL=/bin/sh`. A pane starts `fish -l -C` sourcing a fish-syntax copy of
  the env file. A `vendor_conf.d` file, reached through `XDG_DATA_DIRS`,
  wraps `prompt_pwd`. `fish -c` (an init command) and a nested fish read
  `config.fish` last, so there the user's rc wins.

A prompt that does not shorten through named dirs (starship, say) shows the
full path. A shell whose rc activates an older node through nvm runs the
pinned agents on it; they need node 22.

Init commands run as `$SHELL -c`: project configs are written for a pod's
zsh, so they run in the user's shell even where launches do not.

The tmux server starts with `-f /dev/null`, as in a pod: a user's
`~/.tmux.conf` could set hooks, rename windows or end the session.

### What a workspace keeps in the state dir

The driver's state dir (`<state dir>/containerless`) holds the marker, the
gitconfig and git credential store, the SSH public key, gh's config,
opencode's wrapper and its state and cache, zsh's startup dir,
`yaac-watch-prs`'s seen state (`YAAC_WATCH_PRS_STATE`) and the
`YAAC_SHELL_ENV` file and its fish copy. A stop removes it with the rest of the state dir.

### Mounts that are not realized

**Cache volumes.** A pod mounts a config's `cacheVolumes` onto storage that
outlives it. Here the create declares none: a tool on the host keeps its
cache where it always does, in the user's home or the checkout.

**Scratch directories** (the project setting) stay in the checkout; a stop
deletes them and a restart's init commands rebuild them.

The rebuild is a relink, not a download, because every workspace uses the
project's shared `.cached-packages/pnpm-store`: the create sets
`pnpm_config_store_dir` (and `npm_config_store_dir`, for pnpm 10) to it. A
shared store is safe only here: pnpm indexes it in SQLite in WAL mode,
which needs every writer on one kernel, and pods are not (each keeps its own
store; docs/workspace-storage.md "Package installs").

## Agent history

A pod reaches its conversations through mounts over the tool homes
(docs/workspace-storage.md "Agent history"). The two with an env override
(codex's sqlite home, pi's session dir) are handled like any other mount.
The other three (claude's `projects/` and `file-history/`, codex's
`sessions/`) sit inside the shared tool homes, so the create plants links
in those homes instead:

- The folder claude files this checkout's conversations under (named from
  the cwd by claude's rule, for every spelling of the data dir) links to the
  history's `claude/-workspace`.
- That folder's `memory` links to `-repo/memory`, so claude's auto-memory
  is the one a pod uses.
- Each file-history dir and codex rollout already in the history is linked
  where its tool looks.

A new rollout or file-history dir stays a real file in the shared home until
the next create moves it in. This isolates nothing; it keeps the layout the
same on both drivers.

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
target delivery as an argument. The mount delivery creates an empty dir for
the pod to mount over itself, so the server owns it (a kubelet-created
mountpoint is root-owned). Both claim only names this install ships, prune
links for skills it no longer ships, and run on every create and restart.

The pod's mount is read-only; a symlink is not. An agent writing
`~/.claude/skills/<name>/SKILL.md` here edits the install itself: lost on an
npm upgrade, or an edit to a dev checkout's working tree. A symlink cannot be
made read-only (`chmod` follows it and would block upgrades), and linking to
a frozen copy would lose the version lockstep.

The same skill text reaches both drivers, so it may only assume what a host
has; there is no image supplying `Dockerfile.default`'s utilities. The same
applies to the helper scripts on its PATH. So skills filter GitHub
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

The checkout's `origin` has no token (server-side git adds it per command).
In a pod the proxy adds the credential in flight. Here the launch receives
the resolved credential and writes it into the driver's state dir, beside
the gitconfig `GIT_CONFIG_GLOBAL` names, so the user's `~/.gitconfig` never
applies. An HTTPS token becomes a line in a credential store the helper
names with `store --file=`; without it, `store` would read the user's own
`~/.git-credentials`, write the project's token into it, and could erase the
user's entry after a failed push.

An SSH key is never written to disk. The launch starts an **ssh-agent per
workspace**, detached beside the tmux server, and pipes yaac's generated key
(docs/git-credentials.md) into `ssh-add -`. Only the public half goes in the
state dir, named by `GIT_SSH_COMMAND` with `-F /dev/null`, `-i` and
`IdentitiesOnly`, so the user's ssh config does not apply and ssh does
not offer every key the agent holds (which could lock the account). The
agent's pid is stored in the workspace marker so teardown stops it and
recovery can tell a live agent from a stale socket. A state dir can outlive
a workspace whose host rebooted, so recovery also clears the credential
store and gh's config of any workspace it finds dead. Host keys use the same project-scoped
known_hosts as the pod path.

The credential helper list is reset before `store` is added, so a system
credential manager cannot answer first. `GIT_CONFIG_GLOBAL` points at the
file the launch wrote, since an inherited value would hide it, including
identity and trusted directories. Through the real `$HOME`, git does find
the user's `~/.config/git/ignore` and `attributes`. The workspace's SSH command omits the Tor
options the server's own git uses; see "Egress control" below.

A project the server hosts (docs/hosted-projects.md) needs no secret of its
own. The workspace's gitconfig rewrites the remote's `yaac.internal` URL to
the server's loopback origin, and sends the workspace's yaac-mama token
there as a bearer header. The token is in that file, so the launch writes
it owner-only.

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
docs/permission-modes.md). The result is stored on the session
(`sessions.permissionMode`) so a restart relaunches its agent the same way.
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

Nothing supervises a host server. When its database stops answering
`SELECT 1` it exits rather than fail every request, and stays down until
`yaac server start`; its workspaces keep running and are recovered then.

Every command the server runs in a workspace (exec, stream, changes diff)
gets the workspace's environment, not the server's, whose `YAAC_*` settings
and tool homes would point it at the server's own config. After a restart
the server rebuilds that environment: the state-dir paths from the ids, and
the launch's own entries from the marker. tmux's environment dump cannot be used because it does
not escape multi-line values. Secrets (`secretEnvKeys` on the spec: API
keys, `GH_TOKEN`, proxied project secrets, the `yaac-mama` token) are left
out of the marker; they live encrypted in the database, in the tmux
server's memory, and in the owner-only `YAAC_SHELL_ENV` file, which a stop
removes and recovery clears for a dead workspace.

By default tmux copies an attaching client's `SSH_AUTH_SOCK` (and a few
other variables) into the session environment. So the launch empties
`update-environment` in the same command that creates the session, or the
liveness client would hand the panes the host's ssh-agent.

## Ports

Here the workspace's processes bind host ports directly, so a listener is
already reachable on this machine and the mapping is the identity. Ports
appear as `forwardedPorts`; `unforwardedPorts` is always empty, and there is
no "forward this" action. Workspaces share the host's ports, so each
`portForward` entry gets a port of its own per workspace, passed to the dev
server as `YAAC_PORT_<n>`, and every port has a `<port>.<id8>.localhost`
name that the server routes on its own port
(docs/workspace-hostnames.md).

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

When the driver starts, it installs in the background the new pin of every
package that has an older prefix: the agents this host has used. Pins move
with yaac releases, so otherwise the first create after each upgrade would
wait on npm. A create that needs a package mid-install shares that install,
and a failed one is left for that create to retry and report.

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
agent behavior. The project also runs the `test/e2e-cli` files whose commands
need no workspace runtime (`auth-cli`, `project-cli`, `workspace-cli`), so
they are checked where there is no cluster as well as in the k8s tier. The
driver's unit tests mock `host.ts`, its whole process boundary.
