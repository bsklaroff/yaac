# yaac for iPhone

A native shell around the yaac webapp, the iPhone counterpart of the desktop
app's Servers page (docs/server-selection.md "The desktop shell"). It keeps a
list of servers, adds one by address or by scanning a QR code, and shows the
selected server's webapp full screen. Like the desktop shell it bundles no
frontend: the SPA always comes from the server it talks to, so the app needs
no update when the webapp changes, and the two cannot be on different
versions.

A browser can already use yaac on a phone (docs/remote-hosting.md, "Client
setup"). What a browser cannot do is switch servers: a tab, or a home-screen
web app, is tied to the one origin that served it, so a server list inside
the SPA would vanish exactly when that server is down.

It is a single SwiftUI target with no dependencies, outside the pnpm
workspace; nothing in `pnpm build`, `pnpm lint` or vitest touches it.

| File | Role |
|---|---|
| `Yaac/YaacApp.swift` | the app, and the root view choosing the page or the list |
| `Yaac/ServerStore.swift` | saved servers, the selection, probes, origin parsing |
| `Yaac/ServersView.swift` | the server list |
| `Yaac/QRScanner.swift` | the camera, through VisionKit's `DataScannerViewController` |
| `Yaac/WebView.swift` | the `WKWebView`, its bridge and navigation policy |
| `Yaac/PreviewView.swift` | a forwarded port's preview, full screen over the webapp |
| `Yaac/PortForward.swift` | the loopback listener and tunnel a preview loads through |
| `Info.plist` | the keys build settings cannot generate: the `yaac://` scheme, plain http for previews, and export compliance (only the system's HTTPS, so exempt) |

The project uses Xcode 16 synchronized folders, so a file added under
`Yaac/` or `YaacTests/` is in its target with no project edit.

## How it reaches a server

Exactly as Safari does. A phone reaches a server through `tailscale serve`,
which stamps the device owner's tailnet identity on each request
(docs/remote-hosting.md, "Security model"); `WKWebView` sends real `Origin`
and `Sec-Fetch-Site` headers, so the server's guards pass unchanged. The app
holds no credential, and the server has no notion of it.

So the Tailscale app must be connected, and the app accepts `https` origins
only, on a plain ASCII host name: `serve` is always https with a publicly
trusted `*.ts.net` certificate, so App Transport Security needs no
exception for servers, and a loopback origin or IP address means nothing on
a phone. Its one exception, `NSAllowsLocalNetworking`, is for previews,
which load plain http from the phone's own loopback (see "Previews"). The
key is not loopback-only: it allows plain http to unqualified and `.local`
names app-wide. Only a previewed page can use that, since the main view
sends other origins to Safari and the server list accepts https only. A
previewed page that reaches a LAN address raises iOS's Local Network
prompt, with the `NSLocalNetworkUsageDescription` build setting's text.
Checking the host also keeps a percent-encoded `@` or `/`, or a Unicode
look-alike, from making the confirmation name one host while the app
connects to another. A link or code the app cannot use says why above the
list.

## The server list

`ServerStore` follows the rules of `~/.yaac-client/server.json`, kept in
UserDefaults:

- **Probe** is `GET /api/whoami` with a 5-second timeout. A 2xx naming a user
  is a yaac server that identifies this phone, and the row shows the tailnet
  login it took the phone for. A 401 or 403 is **refused**, with the server's
  reason (a tagged device, or a `local`-mode server). Anything else is
  **stopped**; a request that got no answer at all names the Tailscale app as
  the likely cause.
- **Connect** probes first and selects only on success, so the selection is
  never a server that will not answer. It saves the origin and moves it to
  the front of the list. Connect on the selected server is a real retry.
  Adding is connecting to a new origin, so an origin that fails is not saved.
- **Remove** refuses the selected server, as on the desktop; **Disconnect**
  (a swipe on the selected row) deselects it without forgetting it.

At launch the app probes the selected server and shows its page, or the list
with the failure above it. Over a connected page the list is a sheet, opened
from the **Servers** row of the webapp's projects screen, so "Back" uncovers
the page as it was, its sockets and scroll position intact.

Typed addresses may be a bare host (`srv.tail1234.ts.net`); the path, query
and default port are dropped.

## QR codes

The webapp's **Settings → General → Open on your phone** shows a QR code of

```
yaac://connect?origin=<the page's origin, percent-encoded>
```

(`PhoneLinkField` in `packages/frontend/src/components/settings/PhoneLink.tsx`),
only on an https origin. The app's own scheme, rather than the bare origin,
lets the system Camera app offer "Open in yaac"; a bare https URL would open
Safari. Universal Links cannot replace it, since they need a file on the
scanned domain and every install has its own `*.ts.net` name. The in-app
scanner accepts both forms.

A scan or an opened link is only **offered**: the app asks "Add <host>?"
before connecting, and connecting still requires the probe to pass. Any page
or message can carry a `yaac://` link, and the app trusts the server it shows
with everything typed into it.

## The web view

- **The bridge.** A script injected at document start defines
  `window.yaacWindow` with `showServers`, `openExternal` and `openPreview`,
  the three calls the SPA makes of a native shell (`windowApi()` in
  `packages/frontend/src/components/WindowControls.tsx`). The SPA shows its
  Servers row (`ServersButton`) only when `showServers` exists, its Preview
  entries only when `openPreview` does, and its window controls only under
  Electron;
  `test-playwright-scripts/ios-shell-bridge.js` checks both at a phone
  viewport. A message is accepted only from the top frame
  of the connected origin. As with the desktop shell, the page can show the
  list but never change the selection, so a server cannot move the app onto
  one it chooses.
- **Navigation.** The top frame stays on the connected origin. Any other
  link, and every `window.open` or `target=_blank`, opens in Safari.
  Subframes are left to the page's CSP.
- **Layout.** The page pads itself for the notch and home indicator
  (`viewport-fit=cover`, docs/mobile-layout.md) in portrait and landscape,
  so the web view ignores the safe area and its scroll view adds no insets,
  and it does not bounce, since the page never scrolls. SwiftUI reports no
  safe area to a view that ignores it, so the web view reports the window's
  instead; without that the page's insets are zero and its header sits under
  the status bar.
- **Lifecycle.** iOS suspends a backgrounded app and drops its sockets; the
  SPA reconnects them on `visibilitychange` (`reconnectingSocket`). A page
  whose process iOS killed under memory pressure is reloaded. The default
  data store keeps each origin's localStorage (theme, selection, mobile
  screen).

## Previews

A workspace's dev server is on a port the server offers but never binds
(docs/port-forward-tunnel.md), so the app forwards it itself, as the
desktop app does. The webapp's Preview entry (in the workspace's `⋯` menu,
or its header at a wide width) calls `openPreview` with the workspace and
port, and the app covers the page with `PreviewView`:

- **The forward.** `PortForward` listens on `127.0.0.1`, at the port the
  server offers when it is free and at any free port otherwise, for as long
  as the preview shows. Each connection the page makes opens its own
  WebSocket to `/api/forward/attach`, the protocol `startForward` in
  `@yaac/shared` speaks, so a dev server's hot-reload socket works too. The
  WebSocket goes through `serve` like the page, so the server identifies the
  phone's owner, and admits only the workspace's owner. A failed dial (close
  code 4001, e.g. nothing listening yet) shows above the page.
- **Who can use the listener.** Loopback on a phone is shared by every app,
  so while the listener is up, any code running on the phone (a keyboard
  extension with full access, a background-audio or VoIP app) can connect
  to it and reach that one workspace port as the user. It reaches nothing
  else: the tunnel's workspace and port are fixed when the preview opens.
  The desktop app and `yaac forward` take the same posture
  (docs/port-forward-tunnel.md), though there the other processes are the
  user's own.
- **Backgrounding.** The listener lives only while the preview is on
  screen. When the app goes to the background it closes, and the web view
  goes with it: suspended, the app could not notice another app binding the
  port and serving the page's origin. On return the preview listens again,
  on the same port when it is still free, and reopens the page where it
  was, so its scripts start over. If another app took the port, it listens
  elsewhere and opens the dev server's start page there; if it cannot
  listen at all, it says so. So the app holds no standing set of forwards.
- **The web view** loads `http://127.0.0.1:<port>/` with a data store of its
  own, which lasts as long as the preview, and no bridge, since it runs repo
  code. Links and new windows load in place, including other origins, so a
  dev app's OAuth redirect can come back; while the page is anywhere but
  the preview's own address the title shows its host instead of its title,
  so it cannot pass for the dev server. Back, Reload and Done sit in its
  toolbar.

## What it does not do

- **Notifications.** The desktop shell notifies by holding `/api/events`
  open while it runs; iOS suspends a backgrounded app within seconds, so the
  server would have to send them through Apple's push service.
- **Standing forwards.** Only the port a preview shows is forwarded, and
  only while it shows (see "Previews"); Safari cannot reach it.
- **Tool sign-in**, which needs the desktop app's auth daemon or `yaac auth
  update` on a laptop, and **starting or setting up servers**.
- **iPad.** The target is iPhone only; on an iPad it runs scaled. The webapp
  gives an iPad width the desktop layout, so adding the iPad family is a
  build setting once checked on one.

## Build and run

Xcode 16 or later on a Mac; deployment target iOS 17.

1. Open `ios/Yaac.xcodeproj`.
2. Under the Yaac target's Signing & Capabilities, Debug signs automatically
   with the maintainer's team; choose your own if you are not on it (the
   bundle id is `com.bsklaroff.yaac.ios`; change it if your team cannot
   register that one).
3. Run on a connected iPhone. The camera does not work in the Simulator, but
   everything else does, given a server the Mac can reach.

A free Apple ID can sign for your own phone, but the install stops opening
after 7 days.

```sh
xcodebuild test -project ios/Yaac.xcodeproj -scheme Yaac \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```

runs `YaacTests`: origin parsing (typed, scanned and linked forms),
connect against a stubbed network (refused, look-alike and unreachable
servers are never saved; the selected server cannot be removed; the list
survives a relaunch), and the URL a preview's tunnel opens. Nothing in this
repo's CI builds the app.

## Distribute through TestFlight

The Apple Developer Program membership that signs the desktop app covers it.

1. In App Store Connect, create an app record for the bundle id. In the
   developer portal, create an App Store provisioning profile for it named
   `yaac App Store`: Release signs manually with that profile, because
   automatic signing needs a development profile even to archive, and Apple
   issues none to a team with no registered devices.
2. In Xcode, set the build number (`CURRENT_PROJECT_VERSION`) above the last
   upload, then Product → Archive, and in the Organizer, Distribute App →
   TestFlight & App Store.
3. Add internal testers (up to 100 members of the App Store Connect team).
   Their builds need no review. A build expires after 90 days.

Testers install Apple's TestFlight app and accept the invite.

## Verifying by hand

On a real iPhone with Tailscale connected, against a `tailnet` server:

- Scan the Settings card's QR with the **Camera app**: it offers "Open in
  yaac", the app asks to add the host, lands on the webapp, and the row shows
  your tailnet login.
- Scan the same code with the in-app scanner; then a QR of the bare https
  origin.
- Add a second server by typing its bare host. Switch between them with the
  projects screen's Servers row; "Back" returns to the page with no reload.
- Turn Tailscale off and relaunch: the list shows the server as stopped, and
  the error names Tailscale. Turn it on and tap the row: the webapp loads.
- From a tagged device, or against a `local`-mode server: refused, with the
  server's reason.
- Open a terminal and type with the soft keyboard: the key bar sits on the
  keyboard and no field zooms the page. Background the app for a minute and
  return: the terminal re-attaches and repaints.
- An external link opens in Safari; the app stays on its origin.
- With a dev server running in a workspace and its port forwarded, the `⋯`
  menu's Preview opens it full screen, and editing a file hot-reloads it.
  Navigate within it, then Back, Reload and Done. Preview a forwarded port
  with nothing listening: the error shows above the page.
- Leave a Vite preview idle for two minutes or more, then edit a file: the
  hot reload still applies.
- Serve a multi-megabyte file with `python3 -m http.server` (HTTP/1.0, which
  closes after every response) and open it in the preview: it arrives
  whole.
- Background the app for a minute and return: the page reopens where it
  was, on the same URL. Background it again, bind the same port from
  another app (a local web server app), and return: the preview moves to
  another port rather than loading the other app's page.
- Follow a link off the dev server: the title shows the new host.
- Preview a workspace owned by another user of a `tailnet` install: the
  server refuses the tunnel, the error shows above the page, and nothing
  loads.
- A `yaac://connect?origin=https://example.com` link opened from Notes asks
  first, and Add fails the probe without changing the selection.
