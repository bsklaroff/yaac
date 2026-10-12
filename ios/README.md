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
| `Info.plist` | the keys build settings cannot generate: the `yaac://` scheme, and export compliance (HTTPS only, so exempt) |

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
exceptions, and a loopback origin or IP address means nothing on a phone.
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
  `window.yaacWindow` with `showServers` and `openExternal`, the two calls the
  SPA makes of a native shell (`windowApi()` in
  `packages/frontend/src/components/WindowControls.tsx`). The SPA shows its
  Servers row (`ServersButton`) only when `showServers` exists, and its
  window controls only under Electron;
  `test-playwright-scripts/ios-shell-bridge.js` checks both at a phone
  viewport. A message is accepted only from the top frame
  of the connected origin. As with the desktop shell, the page can show the
  list but never change the selection, so a server cannot move the app onto
  one it chooses.
- **Navigation.** The top frame stays on the connected origin. Any other
  link, and every `window.open` or `target=_blank`, opens in Safari, as do
  forwarded-port links. Subframes are left to the page's CSP.
- **Layout.** The page pads itself for the notch and home indicator
  (`viewport-fit=cover`, docs/mobile-layout.md), so the web view ignores the
  safe area and its scroll view adds no insets, and it does not bounce,
  since the page never scrolls.
- **Lifecycle.** iOS suspends a backgrounded app and drops its sockets; the
  SPA reconnects them on `visibilitychange` (`reconnectingSocket`). A page
  whose process iOS killed under memory pressure is reloaded. The default
  data store keeps each origin's localStorage (theme, selection, mobile
  screen).

## What it does not do

- **Notifications.** The desktop shell notifies by holding `/api/events`
  open while it runs; iOS suspends a backgrounded app within seconds, so the
  server would have to send them through Apple's push service.
- **Port forwarding.** The desktop binds forwarded ports on loopback
  (docs/port-forward-tunnel.md). Links open in Safari instead, which reaches
  a forwarded port at the server's `YAAC_FORWARD_BIND` address
  (docs/remote-hosting.md).
- **Tool sign-in**, which needs the desktop app's auth daemon or `yaac auth
  update` on a laptop, and **starting or setting up servers**.
- **iPad.** The target is iPhone only; on an iPad it runs scaled. The webapp
  gives an iPad width the desktop layout, so adding the iPad family is a
  build setting once checked on one.

## Build and run

Xcode 16 or later on a Mac; deployment target iOS 17.

1. Open `ios/Yaac.xcodeproj`.
2. Under the Yaac target's Signing & Capabilities, choose your team (the
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

runs `YaacTests`: origin parsing (typed, scanned and linked forms), and
connect against a stubbed network (refused, look-alike and unreachable
servers are never saved; the selected server cannot be removed; the list
survives a relaunch). Nothing in this repo's CI builds the app.

## Distribute through TestFlight

The Apple Developer Program membership that signs the desktop app covers it.

1. In App Store Connect, create an app record for the bundle id.
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
- A forwarded-port chip and an external link open in Safari; the app stays
  on its origin.
- A `yaac://connect?origin=https://example.com` link opened from Notes asks
  first, and Add fails the probe without changing the selection.
