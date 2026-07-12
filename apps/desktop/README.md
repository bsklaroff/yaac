# @yaac/desktop

A Tauri v2 shell around the yaac webapp. The bundled page (`src/`) is only a
launcher: it resolves the target server (enabled `~/.yaac/remote.json`, else
the local `~/.yaac/.server.lock`), spawns `yaac server start` when the local
daemon is down, mints a one-time exchange token with the bearer credential
(POST /tokens — the same endpoint `yaac open` uses), and navigates the
window to `<server-origin>/?token=…`, where the SPA trades the token for
its session cookie. From then on the webview is a plain browser on
the server origin, so the SPA, cookie auth, and WebSockets behave exactly
like the webapp, and version skew is impossible (the SPA comes from the
server it talks to).

## Prerequisites

- A Rust toolchain (`rustup`); no cross-compilation needed.
- Linux: WebKitGTK dev packages — on Fedora
  `webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel`,
  on Debian/Ubuntu
  `libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`.
- The `yaac` CLI on PATH (for local-daemon auto-start).

## Run

```sh
pnpm desktop:dev     # tauri dev: launcher via vite on :1430, then navigates
pnpm desktop:build   # tauri build (bundle.active=false → plain binary)
```

The desktop app is not part of `pnpm build`; the published npm artifact never
includes it.

## First build note

`src-tauri/Cargo.lock` must be generated on a machine with cargo (it is the
exact-pin mechanism for the Rust side — commit it once generated). The first
`tauri dev` also writes `src-tauri/gen/schemas/`, which validates
`capabilities/default.json`; if the `https://*:*` http-scope pattern or the
`$HOME/.yaac` dotfile paths are rejected there, see the risk notes in the
capability file's description.

## v1 limitations (accepted)

- `YAAC_DATA_DIR` is not honored — the launcher always reads `~/.yaac`
  (matching its fs capability scope).
- The launcher does not spawn the auth-daemon (`yaac open` does, in-process);
  the SPA's sign-in cards explain what to run when it matters.
- Switching local↔remote means flipping `yaac remote on|off` and relaunching
  the app; an in-app picker is deferred (the launcher structure supports it).
- Installers/signing/updater are deferred (`bundle.active: false`). The
  committed `icons/` are a trimmed placeholder set: just the window icons
  (Linux pngs) and `icon.ico` (embedded by tauri-build on Windows compiles).
  When bundling lands, regenerate the full set — icns, Windows Store logos —
  from a real logo with `pnpm --filter @yaac/desktop exec tauri icon
  <logo.png>` and re-add `icons/icon.icns` to `bundle.icon`.

## Verifying the 2×2 by hand

| | local daemon | remote server |
|---|---|---|
| webapp | `yaac open` | `yaac remote set <url> --token <t>` + `yaac open` |
| desktop | remote off, server stopped → `pnpm desktop:dev` should start the server and land authed on the loopback origin | remote on → should land on `https://…`; break the token to see the bad-token splash |

Also check from the desktop app: a terminal attaches (PTY WebSocket), and a
forwarded-port link opens in the system browser (the `on_new_window` handler
in `src-tauri/src/lib.rs`), plus the error splashes: `yaac` off PATH →
"yaac CLI not found"; stopped remote → "Cannot reach the configured remote".
