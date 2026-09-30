# Expose the forwarded host port to in-workspace dev servers

## Problem

A `portForward` entry in yaac-config.json names a `containerPort` and a
`hostPortStart`. Under `k8s` the server does not bind anything; it
declares which host port each container port is offered at, and a client
forwarder (`yaac forward` or the desktop app) binds that port
(docs/port-forward-tunnel.md). The k8s driver's `declareWorkspaceForwards`
allocates the number: if another workspace already holds `hostPortStart`,
it walks up to the next free one. So two workspaces of one project that
both ask for 3000 get 3000 and 3001.

A dev server inside the workspace cannot see which number it got. OAuth
callback URLs and anything else built from "my own port" point at
`containerPort`, which on the user's machine belongs to a different
workspace or to nothing, and the flow breaks.

Under `containerless` the declared host port always equals
`containerPort` (the workspace's processes bind host ports directly), so
the problem only exists on `k8s`. The fix below still sets the variable
on both drivers, so dev-server code needs no branch.

## Design

Add an optional `envVar` to each `portForward` entry. The server sets that
variable inside the workspace to the declared host port. Dev-server code
builds its own URLs, e.g. `http://localhost:${process.env.PUBLIC_PORT}/oauth/callback`.

Decisions (confirmed with the user):

- The user names the variable per entry. There is no `YAAC_*` naming
  convention.
- Port number only. No URL variable, because the host part differs across
  setups (remote hosting, SSH tunnels, `forwardBindHost`).

### Where the value comes from

Forwards are declared in two places, both of which already produce the
`PortMapping[]` the variable needs:

1. **Workspace create** (`createWorkspace` in `#domain/workspaces`,
   `create.ts`). `runtime.declareForwards(...)` runs before launch, and
   its result already feeds `YAAC_STATUS_RIGHT`. Push `envVar=hostPort`
   onto the same `env` array right after it. The agent's pane and every
   later tmux pane inherit it from the launch environment.
2. **Server restart** (`restoreAllWorkspaceForwarders` in
   `#runtime/ports`, `restore.ts`). The forwarder registry is in memory,
   so a restart re-declares every running workspace's forwards, and the
   k8s allocator may now hand out different numbers than at create. The
   launch env is fixed by then. `provisionForwarders` already execs into
   the workspace to refresh tmux `status-right`; in the same step, run
   `tmux set-environment -t yaac <envVar> <hostPort>` for each entry with
   an `envVar`. New panes (where the user runs a dev server) pick up the
   new value. Already-running processes, including the agent, keep the
   old one; that is accepted.

The ad-hoc "forward this port" action (docs/auto-forward-ports.md) is out
of scope. It has no config entry to carry an `envVar`, and `persist: true`
writes `{containerPort, hostPortStart}` only.

## Changes

1. **`PortForwardConfig`** (`packages/shared/src/types.ts`): add
   `envVar?: string`.
2. **Config validation** (`packages/server/src/domain/projects/config.ts`,
   the `portForward` loop): if present, `envVar` must be a string matching
   `ENV_NAME_PATTERN` (export it from `domain/projects/env.ts` rather than
   restating the regex), and must not start with `YAAC_`. Copy it onto the
   pushed entry. The pattern is what makes the `tmux set-environment`
   command line safe without quoting.

   Project env vars may use `YAAC_` names on purpose (they apply after
   `YAAC_WORKSPACE_ID` so a project can clear it). A forward is different:
   it is set again from a host port on every restore, so a name like
   `YAAC_MAMA_URL` would be silently overwritten with a port number rather
   than deliberately overridden.
3. **Carry `envVar` through `declareForwards`.** Both drivers currently
   return bare `{containerPort, hostPort}` mappings, which drop it.
   Either extend the returned mapping with `envVar` (and keep it out of
   the registry record that feeds `forwardedPorts`), or have callers zip
   the config entries with the declared mappings by index. Pick whichever
   leaves less code; the zip needs no contract change.
4. **Create path** (`create.ts`): after `declareForwards`, push
   `${envVar}=${hostPort}` for each entry that has one.
5. **Restart path** (`restore.ts`, `provisionForwarders`): after the
   status-right refresh, exec one `tmux -S <tmuxSock> set-environment -t
   yaac …` per entry with an `envVar`, using the same `driver.exec` and
   `workspacePaths(jobName).tmuxSock` that `setWorkspaceStatusRight` uses.

## Tests

- `packages/server/test/domain/projects/config.test.ts`: `envVar`
  accepted, absent, non-string rejected, invalid name (`"FOO BAR"`,
  `"1FOO"`) rejected, `YAAC_`-prefixed rejected.
- `packages/server/test/runtime/ports/restore.test.ts`: extend the
  existing `restoreAllWorkspaceForwarders` case so a config entry with
  `envVar` produces a `tmux set-environment` exec with the declared host
  port, and one without produces none.
- `test/e2e-cli/workspace-create-suite.test.ts`: the suite already
  creates a workspace with `PORT_FORWARD`. Add `envVar` to one entry
  there and assert `printenv <var>` in the workspace equals the host port
  from the create output. Reuse the file's shared workspace; do not add a
  new one. `test/e2e-containerless/workspace-suite.test.ts` configures no
  `portForward` today; add one entry with an `envVar` to its shared
  workspace and assert the value equals `containerPort`.

## Verification

1. `pnpm lint`.
2. `pnpm vitest run --project unit:server` for the config and restore
   tests; the containerless e2e case runs in a dev workspace. The k8s e2e
   case needs a host with a cluster.
3. By hand on k8s: start two workspaces of one project that both forward
   3000 with `envVar: "PUBLIC_PORT"`. The second should report 3001 in
   its status bar and in `printenv PUBLIC_PORT`. Restart the server, open
   a new tmux pane, and check the value again.

## Non-goals

- No `YAAC_HOST_PORT_<n>` convention; users name the variable.
- No URL variable.
- No update to the environment of processes already running when a
  restart re-declares ports.
- The variable states the declared host port. A client that binds a
  different local number (`yaac forward --port <container:host>`) or a
  listener that fails to bind is outside what the server can know.
