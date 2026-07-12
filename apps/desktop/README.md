# @yaac/desktop

An Electron shell around the yaac webapp. There is no bundled frontend and no
renderer code: the main process resolves the target server (enabled
`~/.yaac/remote.json`, else the local `~/.yaac/.server.lock` — without the
CLI's build-id match, since the shell ships no server code to match), spawns
`yaac server start` when the local daemon is down, mints a one-time exchange
token (POST /tokens — the same endpoint `yaac open` uses, via the shared
typed client), and loads `<server-origin>/?token=…` into the window. From
then on the window is a plain browser on the server origin, so the SPA,
cookie auth, and WebSockets behave exactly like the webapp, and version skew
is impossible (the SPA comes from the server it talks to).

## Prerequisites

- Nothing beyond the repo's usual `pnpm install` (the `electron` dev
  dependency downloads its prebuilt binary on install).
- The `yaac` CLI on PATH for local-daemon auto-start. GUI launches with a
  minimal PATH self-heal: on ENOENT the spawn retries once with the login
  shell's PATH (`src/server-process.ts`).

## Run

```sh
pnpm desktop:dev     # tsup-bundle the main process, then electron .
pnpm desktop:build   # just the bundle (dist/main.js)
```

The desktop app is not part of `pnpm build`; the published npm artifact never
includes it.

## v1 limitations (accepted)

- The shell does not spawn the auth-daemon (`yaac open` does, in-process);
  the SPA's sign-in cards explain what to run when it matters.
- Switching local↔remote means flipping `yaac remote on|off` and relaunching
  the app; an in-app picker is deferred.
- No packaging/tray/notifications yet: `pnpm desktop:dev` runs it from the
  repo. Packaging (electron-builder, signing, a real app icon) is deferred —
  as is npm distribution, which Electron makes cheap (prebuilt binaries ship
  with the `electron` package; the app code is plain JS).

## Verifying the 2×2 by hand

| | local daemon | remote server |
|---|---|---|
| webapp | `yaac open` | `yaac remote set <url> --token <t>` + `yaac open` |
| desktop | remote off, server stopped → `pnpm desktop:dev` should start the server and land authed on the loopback origin | remote on → should land on `https://…`; break the token to see the error dialog |

Also check from the desktop app: a terminal attaches (PTY WebSocket), and a
forwarded-port link opens in the system browser (the `setWindowOpenHandler`
in `src/main.ts`), plus the error dialogs: `yaac` off PATH → "yaac CLI not
found"; stopped remote → "Could not connect to the remote server".
