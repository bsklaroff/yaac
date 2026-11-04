# Preview pane on the app's own loopback origin

The desktop preview pane loads a workspace port at its workspace hostname,
`http://<port>.<id8>.localhost:<router port>/` (docs/workspace-hostnames.md).
That name is not the origin the app was written for. This plan has the pane
load `http://localhost:<port>/` instead, and send everything the pane opens on
loopback into that pane's workspace through a proxy owned by its Electron
session.

## Problems it solves

- **Apps with a configured URL.** An app told its URL
  (`NEXTAUTH_URL=http://localhost:3000`, OAuth redirect URIs, absolute links in
  its config) redirects the pane off the hostname to `localhost:3000`. That
  reaches the plain forward rather than the pane's origin, so cookies split
  across two origins, and on a fallback port it reaches nothing.
- **Host allowlists.** Every dev server sees `Host: <port>.<id8>.localhost:8786`
  and must admit it. Vite, Rails and Django do by default; webpack-dev-server
  and Next.js may need configuring.
- **A previewed yaac.** A yaac server reads a workspace name as its own routing
  instruction. A server inside the named workspace takes its own name as
  addressed to itself (`namesWorkspace`), which covers browser tabs. In the
  pane the inner server would simply see `Host: localhost:8787`.

## Design

Each preview pane already has its own session:
`WorkspacePreview` creates its `<webview>` with
`partition="persist:preview-<workspaceId>"`. Electron can give one session its
own proxy (`session.setProxy`).

```
 pane for a528bd7a  (persist:preview-a528bd7a)
   http://localhost:8787/  ──► SOCKS5 listener for a528bd7a ──► tunnel ──► pod 127.0.0.1:8787
 pane for 5fa2e141  (persist:preview-5fa2e141)
   http://localhost:8787/  ──► SOCKS5 listener for 5fa2e141 ──► tunnel ──► pod 127.0.0.1:8787
```

- **One SOCKS5 listener per previewed workspace**, on a loopback port the
  desktop main process picks. Chromium does not send SOCKS credentials, so the
  listener's port is what identifies the workspace. A CONNECT to
  `localhost:<port>` or `127.0.0.1:<port>` opens the same tunnel connection the
  hostname router's `bridge` opens today, for `(workspaceId, port)`. SOCKS hands
  over raw bytes, so keep-alive, WebSocket upgrades and HMR pass untouched and
  nothing parses HTTP. A port the server does not offer is refused, as the
  router's `route` refuses it now.
- **The session's proxy is set in `will-attach-webview`** (main.ts), from
  `params.partition`, before the guest loads anything. The proxy applies to
  loopback only. Chromium skips the proxy for loopback by default, so the
  bypass rules need `<-loopback>`. Every other host goes direct. The pane only
  navigates to loopback (`isAllowedPreviewUrl`), but a page can still load
  subresources from a CDN.
- **The pane's URL** becomes `http://localhost:<port>/`, where `<port>` is the
  port the app itself sees: the container port under `k8s`, and the
  workspace's allocated port (`$YAAC_PORT_<n>`) under `containerless`.
  `previewPaneUrl` in `WorkspaceView` builds it, and the pane waits, as it does
  now, until the desktop app says the workspace's listener is up (an IPC
  message beside `onHostsPort`).
- **Containerless on the same machine** needs no proxy: the workspace already
  listens on this machine at that port. The pane loads it directly and keeps
  its partition for cookie isolation.

## What it gives

- The app runs on the origin it was written for, so its own redirects and
  absolute URLs stay in the pane and on the right workspace.
- Every Host check accepts the request, yaac's included, without app
  configuration.
- Isolation is stronger than with hostnames. Each workspace has its own cookie
  jar and storage, apart from every other workspace and from the yaac webapp,
  which runs in another session. Two panes can show `localhost:3000` from two
  workspaces at once.
- A page in the pane can no longer reach other workspaces' ports or a host
  yaac server on loopback, since all of its loopback traffic goes to its own
  workspace.

## Must change with it

- **Copy URL and Open in browser** (`WorkspacePreview`) hand out the address
  bar's URL. `localhost:<port>` in the system browser reaches the plain
  forward, which may sit on a fallback port. These two actions should convert a
  loopback URL to the workspace hostname URL, keeping its path and query.
- **The address bar** accepts any loopback URL the user types. With the proxy,
  `localhost:<other port>` reaches that port of the same workspace, if it is
  offered.
- **docs/workspace-hostnames.md** "Where the names show up": the pane no longer
  uses the names. Browsers, the CLI and the iPhone app still do.

## Not covered

- **OAuth inside the pane.** The pane opens non-loopback URLs in the system
  browser (webview-guard.ts), so a provider's login page and its callback land
  there, not in the pane. Letting the pane visit external sites is a separate
  security decision.
- **Browser tabs.** A normal browser cannot give one tab its own proxy, so a
  browser keeps the hostnames and the problems above.
- **The iPhone app's native preview.** iOS 17 can set a proxy on a
  `WKWebsiteDataStore`, which could do the same thing; not investigated.

## Check first

These are Electron details to confirm with a script in
`test-playwright-scripts/` before changing the pane:

1. A session proxy set from `will-attach-webview` applies to the `<webview>`
   guest's first navigation.
2. `<-loopback>` in the bypass rules sends `localhost` and `127.0.0.1` through
   the proxy, with non-loopback hosts direct. A PAC script may be needed, and
   whether bypass rules combine with PAC needs checking.
3. A WebSocket (HMR) from the guest goes through the SOCKS proxy, and the
   app's `Host` and `Origin` headers arrive as `localhost:<port>`.
4. Chromium's IPv6 try on `localhost` still goes to the proxy with the
   hostname, rather than dialing `::1` directly.
