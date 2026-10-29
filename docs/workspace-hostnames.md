# Workspace ports and hostnames

Under `containerless` a workspace binds host ports itself, so two
workspaces of one project that start the same dev server would both ask for
the same port. So each containerless workspace gets its own port for every
`portForward` entry. Every workspace port, on either driver, also gets a
hostname, `<port>.<id8>.localhost`, served without binding a host port per
workspace (docs/port-forward-tunnel.md).

## Allocation

A `portForward` entry `{ "containerPort": 3000, "hostPortStart": 3000 }`
(docs/project-config.md) says the workspace serves something on 3000. Every
workspace gets `YAAC_PORT_<containerPort>` holding the port to bind for that
entry, so a config passes it on:

```json
{
  "initCommands": ["pnpm dev --port $YAAC_PORT_3000"],
  "portForward": [{ "containerPort": 3000, "hostPortStart": 3000 }]
}
```

Under `k8s` the variable is always the entry's own port
(`YAAC_PORT_3000=3000`), since each pod has its own network, so one config
works on both drivers. yaac sets no `PORT`, because what it means differs
between apps and between the processes of one app. An agent that starts a
dev server itself sees the variable too.

Under `containerless`, `declareForwards` (`declareWorkspacePorts`) gives each
entry the first port at or above `hostPortStart` that no other running
workspace holds and nothing on this machine answers on. It probes by
connecting to `127.0.0.1` and `::1`, because on macOS a test bind can
succeed next to a listener on a specific address. The mapping stays the
identity (`{ containerPort: 3001, hostPort: 3001 }`), since the workspace's
network is the host's. The first workspace gets 3000.

The allocation goes in the workspace's marker file, so a server restart
recovers it. A re-declare for a workspace that already holds ports returns
them unchanged, because its dev servers are bound there. A workspace that
stops releases its ports. A restarted workspace is allocated again, and
usually gets the same ports.

## Hostnames

`http://<port>.<id8>.localhost:<router port>/`, where `<port>` is the
workspace-side port (the variable's value) and `<id8>` the first eight
characters of the workspace id (`@yaac/shared/workspace-hosts`).

- **The workspace is its own label.** Every `*.localhost` name resolves to
  loopback in Chromium (and so the desktop app), Firefox and curl.
  `<id8>.localhost` is then the registrable domain, so one workspace's
  ports are same-site with each other (a frontend can share a cookie with
  its API) and cross-site with other workspaces and with the yaac server.
  On bare `localhost:<port>` every workspace shares one cookie jar, since
  cookies ignore the port. A client that leaves the name to the system
  resolver may fail to resolve it; `127.0.0.1:<port>` still works there.
- **`Host` is passed through.** The dev server sees the name the browser
  used, so its absolute URLs and HMR client point back the same way. Vite
  accepts `*.localhost` by default. A dev server with its own host
  allowlist (Next.js's `allowedDevOrigins`, webpack's `allowedHosts`) must
  allow the name.

## Routing

Both routers read a connection's first request head
(`readRequestHead`) and splice the whole TCP connection to the port its
`Host` names. Keep-alive requests, WebSocket upgrades and HMR then pass
through as bytes, and nothing parses HTTP. A browser never reuses a
connection across hosts, so routing by the first head is safe.

**On the server's own listener** (`routeWorkspaceHosts`). The server reads
each new connection's head before Node's HTTP server sees it. A workspace
name is spliced to `dialPort` for that workspace and port, and any other
host goes on to the HTTP server untouched. A workspace name never reaches
the API: an unknown workspace gets a 404, a port it is not serving a 502,
and a request through `tailscale serve` or to a `tailnet` install a 403.
Only a `local` install's own machine is served, because that caller already
owns every workspace and could reach the ports anyway. This covers a browser
or the desktop app on the server's machine, for either driver (under `k8s`,
with no forwarder running), and an `ssh -L` tunnel to the server's port.

**On a remote client's forwarder.** When `yaac forward` or the desktop app
forwards for a server whose origin is not loopback, its forward set
(`createForwardSet`'s `hostsPort`) also binds a router at
`WORKSPACE_HOSTS_PORT`, 8786, or the next free port above it. It routes the
names into the identified tunnel (`/api/forward/attach`), so it reaches only
ports the server offers. A name it does not offer gets a 404.

No API route exists for this. The server-side router is not a Hono route,
and each client builds the names from the workspace id and port.

The `k8s` driver has no port collision, but it offers the same names. The
router only calls `dialPort`, so they cost nothing there, and they keep one
URL scheme and the same cookie isolation on both drivers.

## Where the names show up

- **Webapp.** A browser on a loopback origin has a Preview button that opens
  the name in a new tab (`useHostsPort`). The desktop app's preview pane
  loads the name: through the server when it runs on the same machine, and
  through the app's own router otherwise. The app sends that router's port
  to the page over IPC (`onHostsPort`). A browser on a remote origin gets
  no preview, since nothing the page can know of routes the names on its
  machine.
- **CLI.** `yaac workspace list` prints each port's URL. For a remote
  server the URLs use `WORKSPACE_HOSTS_PORT` and work while `yaac forward`
  or the desktop app runs; a router that found 8786 taken holds the port
  `yaac forward` printed instead. `yaac forward` against a remote server prints the
  router it bound.
