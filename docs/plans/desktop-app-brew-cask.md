# Ship the desktop app as a Homebrew cask

## Goal

Make this the macOS install for most people:

```sh
brew trust bsklaroff/yaac
brew install --cask bsklaroff/yaac/yaac-desktop
```

It installs a signed, notarized `yaac.app` and the `yaac` CLI it runs, from
the existing `bsklaroff/homebrew-yaac` tap.

Most people installing yaac want one of two things:

1. **Run workspaces on this Mac with the containerless driver.**
2. **Connect to a k8s server someone runs elsewhere**, added in the app's
   server picker.

Neither needs a local cluster, so neither should need podman, kind, the
`libkrun/krun` tap, or the from-source Rust builds of the tap's patched
`yaac-krunkit` / `yaac-libkrun` pair. The tap ends up with three packages:

- **`yaac-server`** (formula): the CLI plus the containerless host tools.
  It is the only copy of the server code on a machine.
- **`yaac-desktop`** (cask): the Electron app alone. It depends on
  `yaac-server` and runs it for everything it does.
- **`yaac-cluster`** (formula): installs nothing itself. It depends on
  `yaac-server` plus what `yaac cluster install` needs. It is for running a
  cluster from this Mac.

Linux, which has no casks, installs from source
(docs/install-from-source.md).

## Tap trust

Homebrew 6.0 refuses to load code from a non-official tap until it is
trusted (docs.brew.sh "Tap Trust"). Installing a fully qualified name trusts
only that item, not the tap formulas it depends on. Official taps
(homebrew-core, homebrew-cask) are always trusted.

The cask depends on the tap's `yaac-server` formula, so the main install
needs `brew trust bsklaroff/yaac`. That is the price of one copy of the server
code: the alternative, an app that bundles its own server, avoids the trust
step but ships and signs a second copy that can drift from the formula's.

The cluster path also needs `brew trust libkrun/krun` and
`brew tap libkrun/krun`, because `yaac-libkrun` depends on that tap's
`libkrunfw` and `virglrenderer-krun`. Splitting the cluster tools out of
`yaac-server` keeps those steps off the main path.

If `yaac-server` is ever accepted into homebrew-core, the cask's dependency
becomes a core formula and the trust step disappears with no other change
(see "Out of scope").

## Current state

Packaging exists but produces only a local, unsigned build
(packages/desktop/README.md, "Packaging (macOS)"):

- `pnpm desktop:package` runs `pnpm -w build`, `tsup`,
  `scripts/stage-server.ts` and `electron-builder`, producing
  `packages/desktop/dist-app/`. `pnpm desktop:install` then copies it into
  `/Applications` with `ditto`.
- `stage-server.ts` stages the publish artifact (`pnpm pack` plus
  `npm install --omit=dev`) and a copy of the build machine's `node`.
  `scripts/after-pack.cjs` copies both into `yaac.app/Contents/Resources`.
  The packaged app uses them only to run the auth daemon
  (`resolveYaacCommand` in `src/server-process.ts`). A dev run
  (`pnpm desktop:dev`) runs `yaac` from PATH instead.
- The shell never starts or stops a server. When the selected server on
  this machine cannot be reached, the connect page's hint says to run
  `yaac server start` (`src/flow.ts`).

The `yaac` formula installs the npm tarball plus what both drivers need:
node, tmux, socat, fd and ripgrep for containerless, and kubernetes-cli,
podman, kind and (on macOS) `bsklaroff/yaac/yaac-krunkit` for a local
cluster.

The gaps for a distributable app are in
`packages/desktop/electron-builder.yml`:

- `mac.target: [dir]` builds a bare `.app`, not a distributable artifact.
- `mac.identity: null` leaves it unsigned.

## Order

The formula split (Phase 3) and the tray (Phase 4) are independent of each
other and of the daemon phases, and can land in any order. The real
dependencies are:

- Phases 1 and 2 land as one change. The app starts its daemon today
  through `yaac auth server run`, which Phase 1 deletes, and Phase 2's
  lock-free daemon assumes the CLI no longer runs one.
- Phase 5 (signing) after Phase 2, which removes the bundled Node it would
  otherwise have to sign.
- Phase 6 (the `.dmg`) after Phase 5, and Phase 7 (the cask) after all the
  others.

## Phase 1: take the auth daemon out of the CLI

The auth daemon is the login broker: it runs the Claude and Codex CLIs'
browser sign-ins on the user's machine, where the browser and the vendors'
localhost OAuth callbacks are, and saves the result to the (possibly
remote) server. The server relays sign-in requests to it over a WebSocket,
so a browser anywhere can start one.

The CLI runs a daemon for two things:

- **`yaac auth update claude|codex`** calls `ensureAuthDaemon()`, then
  drives the sign-in through the server's relay routes
  (`relayed-login.ts`), like the web app's sign-in cards.
- **`yaac auth server run|start|stop|status`** let a user of the web app in
  a plain browser start a daemon for its sign-in cards.

The relay only matters when the request starts in a browser. The CLI
already runs where the login has to happen, so it does not need it. Phase
2 gives the desktop app a daemon of its own, and this phase makes that the
only one:

- **`yaac auth update` signs in in-process.** It calls the daemon package's
  login code (`tool-login.ts`) directly, polls it locally as
  `relayed-login.ts` polls the server today, and saves the result with
  `PUT /auth/:tool`. It also seeds the git identity from local git config
  when the server has none (`seedGitIdentityFromShell`), as starting the
  daemon does today. `relayed-login.ts` goes.
- **Delete `yaac auth server *`** and its e2e test
  (`test/e2e-cli/auth-daemon.test.ts`).
- **Delete the shared daemon machinery** in `@yaac/shared/auth-daemon`: the
  lock file, the detached spawn, `ensureAuthDaemon`, and their tests
  (`packages/shared/test/auth-daemon.test.ts`). What the app still needs to
  start a daemon moves into `packages/desktop`.
- **Install Codex without npm.** The daemon's "Install" button runs
  Claude's standalone installer (`curl … | bash`, into `~/.local/bin`) but
  installs Codex with `npm install -g`, failing when npm is missing. OpenAI
  publishes an equivalent installer as an asset of every Codex release:
  `install.sh` with `--release <version>` and `CODEX_NON_INTERACTIVE=1`
  installs the native binary into `~/.local/bin` and checks it against the
  release's SHA-256 sums. `installArgv` in `tool-install.ts` fetches that
  script from the pinned release
  (`https://github.com/openai/codex/releases/download/rust-v<version>/install.sh`)
  and runs it, and the "npm was not found" branch goes away. Neither
  sign-in then needs Node on the machine, which matters once the app
  carries the daemon without the CLI.

**What users lose.** The web app's sign-in cards in a plain browser work
only while the desktop app runs on that machine. Without it (Linux, which
has no app, or a Mac user in a browser), sign-in is `yaac auth update` in a
terminal, or pasting a token. The cards and the server's "no auth server
connected" answer say so instead of naming `yaac auth server start`.

**Docs.** docs/remote-hosting.md (the diagram, "Tool credentials", the git
identity and time zone notes, "Machine-scoped commands", "A phone alone
cannot sign in"), docs/server-in-cluster.md (git identity, time zone),
docs/multi-user.md and docs/server-selection.md describe the daemon as the
desktop app's. The Settings copy in `SettingsButton.tsx` that names the auth
server follows.

Browser sign-in without the app is given up deliberately. The app itself
starts its daemon today by running `yaac auth server run`, which this phase
deletes, so it lands in the same change as Phase 2.

Exit check: `yaac auth update claude` and `yaac auth update codex` complete
a browser sign-in against a remote server with no daemon running, and seed
the git identity when it is unset. `yaac auth server` is gone from
`yaac --help`. On a machine without npm, the Codex "Install" button
installs Codex and the sign-in then succeeds.

## Phase 2: the app bundles the auth daemon and runs `yaac` from PATH

The app keeps one part of the CLI: the auth daemon, the login broker that
runs Claude's and Codex's browser sign-ins on this machine. Everything else
it gets from `yaac` on PATH. The daemon is small (`packages/auth-daemon`:
`ws`, `@yaac/shared` and `@lydell/node-pty`), and Electron already contains
Node, so bundling it adds no Node of our own.

**Delete the bundled server and Node:** `scripts/stage-server.ts`,
`scripts/after-pack.cjs`, the `afterPack` and `asar: false` entries in
`electron-builder.yml`, and the `stage-server` step of `app:build`.

**Run the daemon inside the app.** tsup bundles the daemon's entry into the
app as it bundles the main process. The main process runs it in an Electron
`utilityProcess`, so it lives exactly as long as the app: Quit stops it.
It is the only daemon on the machine (Phase 1), so it needs no lock file or
detached spawn. `resolveYaacCommand` and the packaged/dev split in
`src/server-process.ts` go away. A dev run (`pnpm desktop:dev`) runs the same
bundled daemon.

`packages/desktop` may import only `@yaac/shared` today. The boundary table
in AGENTS.md and the eslint import zones allow it `@yaac/auth-daemon` too, as
the CLI already has.

- **node-pty.** The Claude login needs a PTY, so node-pty's native module
  ships in the app, outside the asar (`asarUnpack`), where electron-builder
  signs it. It must load under Electron's Node: node-pty 1.x targets Node's
  stable native API (N-API), so no rebuild should be needed. Verify this
  early, since it decides whether `@electron/rebuild` joins the build.
- **PATH.** A Finder launch gets the OS's minimal PATH, with no
  `/opt/homebrew/bin` or `~/.local/bin`. The app already resolves the
  login-shell PATH for the daemon's children (claude, codex, the
  installers). It hands the same PATH to the daemon and uses it to find
  `yaac` for the tray.

Update packages/desktop/README.md ("Prerequisites", "Packaging (macOS)",
the auth daemon paragraph under "Run") to match: the packaged app carries
the auth daemon and needs `yaac` on PATH only for a server on this Mac.

Exit check: a packaged build with no `Resources/server` or `Resources/node`,
launched from Finder, runs the daemon, completes a Claude and a Codex
browser sign-in against a remote server, and stops the daemon on Quit.

## Phase 3: rename `yaac` to `yaac-server` and split out `yaac-cluster`

- **`yaac.rb` becomes `yaac-server.rb`.** It keeps the npm tarball, `node`,
  `tmux`, `socat`, `fd`, `ripgrep`, and `uses_from_macos` `curl`, `git`,
  `lsof`. It drops `kubernetes-cli`, `podman`, `kind` and the whole
  `on_macos` block. Its caveats lead with `yaac server start` /
  `yaac host check`, then name `yaac-cluster` for a local cluster.
- **New `yaac-cluster.rb`** depends on `bsklaroff/yaac/yaac-server`,
  `kubernetes-cli`, `podman` (6.0 or newer), `kind` (v0.33.0 or newer), and
  `bsklaroff/yaac/yaac-krunkit` with `arch: :arm64` inside `on_macos`. It
  installs no files of its own. Its caveats hold the `yaac cluster install`
  / `yaac cluster check` text `yaac.rb` carries today.
  - `--byo` installs onto someone else's cluster need podman and kubectl
    but not kind or krunkit. They are rare enough to share this formula
    rather than get a third one.
- **Install hints.** `requireBinaries` in `#drivers/k8s/install`
  (install.ts) already reports podman, kind and kubectl missing. On macOS
  its hints should name `bsklaroff/yaac/yaac-cluster` instead of per-tool
  installs. `initMachine`'s "Is krunkit installed?" hint names the stock
  `libkrun/krun/krunkit`, which is the wrong one; point it at the same
  formula.

A `formula_renames.json` entry (`"yaac": "yaac-server"`) in the tap makes
`brew upgrade` move existing `yaac` installs to `yaac-server`
(docs.brew.sh "Renaming a Formula or Cask"). Verify it on a Mac with the old
formula installed.

Existing users who run a kind cluster still need a one-time step. The rename
carries over only what `yaac-server` depends on, so podman, kind and krunkit
become `brew autoremove` candidates, and removing krunkit breaks the podman
machine. The release notes and `yaac-server.rb`'s caveats tell them to
install `yaac-cluster` once. That is tap metadata and release communication,
not code, so it needs no `docs/legacy-compat-shims.md` entry.

This phase can ship on its own, independently of the app phases.

Exit check: on a clean Mac, `brew trust bsklaroff/yaac` and
`brew install bsklaroff/yaac/yaac-server` succeed without the
`libkrun/krun` tap, and `yaac server start && yaac host check` pass. Adding
`yaac-cluster` (with its `libkrun/krun` steps) and running
`yaac cluster install` brings up a kind cluster that `yaac cluster check`
passes.

## Phase 4: the tray starts and stops this machine's server

A cask user has the CLI, but the app should not send them to a terminal to
start a server. Starting and stopping are explicit choices in the tray.
Quitting the app never stops a server, as today.

**Tray items.** Below the waiting-count line, the tray shows this machine's
server and one action:

- **Start server** when it is not running. It runs `yaac server start`,
  then connects. The CLI's guards still apply: a k8s data dir refuses a host
  start, and the tray shows that refusal.
- **Stop server** when it is running. It runs `yaac server stop`, and the
  window falls back to the connect page.
- **Restart server to update** in place of Stop when the running server's
  version differs from the installed `yaac --version`. After
  `brew upgrade`, a running server keeps its old code until restarted. This
  needs the server to report its version, if it does not already.

These act on this machine's install, whichever command started it, the same
as running the commands by hand. They cover a k8s install too, because
`yaac server start|stop|restart` already scale its Deployment.

**First run.** With no server selected, the connect page offers **Start a
server on this Mac** next to adding a remote one. It is the tray's Start
item, plus a `yaac host check` afterwards that lists any failures. The
formula installs every tool the check requires except the agent CLIs
(claude, codex, opencode, pi), so in practice it says which agent to
install.

**Agents survive a stop.** A containerless workspace is a tmux server that
outlives the yaac server (docs/containerless-driver.md), so stopping or
restarting the server never stops an agent. While the server is down,
nothing watches them. Starting it again picks them back up.

**Code and docs.** `src/main.ts`'s and `src/server-process.ts`'s headers and
packages/desktop/README.md ("The shell never starts a server", "Tray")
describe the tray items. They replace the `yaac server start` hint in
`src/flow.ts`.

Exit check: from a packaged build, the connect page starts a containerless
server and drives a workspace end to end. Tray Stop stops the server while
the workspace's agent keeps running, and tray Start brings the workspace
back. Quitting the app leaves a running server running. After installing a
newer `yaac`, the tray offers a restart, and the restarted server reports
the new version.

## Phase 5: signing and notarization

A cask download gets the `com.apple.quarantine` attribute, and Gatekeeper
refuses an app that is not notarized ("damaged and can't be opened").
Shipping an unsigned cask that strips quarantine is what Homebrew
discourages, so notarization is required, not polish.

With the bundled Node gone (Phase 2), the bundle is an Electron app plus
node-pty's native module, which electron-builder signs and notarizes with
no custom steps:

1. An Apple Developer ID Application certificate (paid Apple Developer
   account) and an app-specific password or API key for `notarytool`.
2. In `electron-builder.yml`: set `mac.identity`, `mac.hardenedRuntime:
   true`, and `mac.notarize: true` (electron-builder runs `notarytool` and
   staples the ticket). Add entitlements only if the hardened runtime turns
   out to block something.
3. Signing identity and notarization credentials come from the
   environment. Local builds keep `identity: null`, so
   `pnpm desktop:install` still works without a certificate.

Exit check: a notarized, stapled `.app` downloaded with quarantine set (a
real browser download, or `xattr -w com.apple.quarantine …`) opens with no
Gatekeeper prompt, starts the auth daemon and a server from the tray, and
drives a workspace end to end.

## Phase 6: a `.dmg` on a GitHub Release

- Add `dmg` to `mac.target`.
- Upload the `.dmg` as an asset on the `v<version>` GitHub Release. The
  cask's `url` uses `version` and is pinned by `sha256`, the same way
  `yaac-server.rb` pins the npm tarball.

## Phase 7: the cask

Add `homebrew/Casks/yaac-desktop.rb` next to `homebrew/Formula/`, so it is
reviewed with the code it packages, and mirror it into the tap's `Casks/`
directory on release:

```ruby
cask "yaac-desktop" do
  version "0.x.y"
  sha256 "<dmg sha256>"

  url "https://github.com/bsklaroff/yaac/releases/download/" \
      "v#{version}/yaac-#{version}-arm64.dmg"
  name "yaac"
  desc "Desktop app for the yaac agent sandbox manager"
  homepage "https://github.com/bsklaroff/yaac"

  depends_on arch: :arm64
  depends_on formula: "bsklaroff/yaac/yaac-server" # the CLI it runs

  app "yaac.app"                              # productName in the yml

  zap trash: [
    "~/Library/Application Support/yaac",
    # NOT ~/.yaac or ~/.yaac-client: server data and server registration
  ]
end
```

**Brew manages upgrades.** The cask gets a `livecheck` block and no
`auto_updates`, and the app has no updater, so `brew upgrade` updates the
app and the formula together. The app loads its UI from the server, so it
cannot drift out of sync with it, and a self-updater would update the app
without the formula.

The app and the formula can still be on different versions, since a user
can upgrade one without the other. That is harmless: the window's SPA always
comes from the server, and the shell's own API use (tray, notifications,
port forwards) already tolerates remote servers on other versions.

**Installing the `.dmg` by hand.** The Release asset is public, so someone
can drag `yaac.app` into `/Applications` without brew. It is notarized, so
it opens, but it gets no CLI, and nothing updates the app.

Without the CLI the app still works fully as a client of a remote server:
the picker, the window, notifications, port forwards and the auth daemon
are all the app's own (Phase 2). The only thing missing is a server on this
Mac, for which the connect page says to install
`bsklaroff/yaac/yaac-server`.

The README documents only the cask. Mixing the two never breaks the app,
but brew's record goes stale:

- **Hand install first, then the cask.** `brew install --cask` refuses
  because `/Applications/yaac.app` already exists. `--force` replaces it,
  and from then on brew owns it.
- **Cask first, then a hand install over it.** Brew keeps recording the
  cask's version, not what is on disk. `brew upgrade` replaces the app only
  when the tap has a newer version than that record, which may put back an
  older app than the one dragged in. `brew uninstall --cask` removes the
  hand-installed copy too.

**Docs.**

- **README "Install"**: the two-line trust-and-cask install, then a short
  block for a local cluster (`brew trust libkrun/krun`,
  `brew tap libkrun/krun`, `brew install bsklaroff/yaac/yaac-cluster`,
  `yaac cluster install`). "Getting started" drops its clone-and-build block
  and starts from opening the app.
- **`homebrew/README.md`**: "End-user install", "Formulas" (the split
  `yaac-server`, the new `yaac-cluster`, the cask), and the release flow below.
- **docs/install-from-source.md**: its macOS block can install
  `yaac-cluster`'s dependencies by name as today. Its note that a source
  install and brew both own `bin/yaac` says `brew unlink yaac-server`
  instead of `brew uninstall`: the cask depends on the formula, so brew
  refuses to uninstall it, and unlinking frees the link while keeping the
  dependency met. With the cask installed, a source install then serves the
  app too, since the app runs the `yaac` on PATH. Switching back is
  `npm uninstall -g @bsklaroff/yaac && brew link yaac-server`. Check
  whether `brew upgrade` relinks an unlinked `yaac-server`; if it does, the
  doc says to unlink again after upgrading.
- **docs/cluster-setup.md** ("macOS: the podman machine") names
  `yaac-cluster`.

Verify on a clean Mac with Homebrew 6+: the two-line install succeeds
without the `libkrun/krun` tap, then both paths work from the app alone:
starting and stopping a containerless server from the tray, and adding a
remote server in the picker. Then add `yaac-cluster` with its `libkrun/krun`
steps and check that `yaac cluster install` and `yaac cluster check` pass.

## Release flow

`homebrew/README.md`'s release flow gains a desktop track:

1. Bump `version` in the root `package.json` (the single version source),
   `pnpm publish`, and fill the tarball's `sha256` into `yaac-server.rb`, as
   today.
2. Run `pnpm desktop:package` with signing and notarization credentials in
   the environment.
3. Upload the `.dmg` to the `v<version>` GitHub Release.
4. `shasum -a 256` the `.dmg` and fill `version` and `sha256` into
   `homebrew/Casks/yaac-desktop.rb`.
5. Mirror `homebrew/Formula/` and `homebrew/Casks/` into the tap
   (`rsync -a --delete`) and push.

## Out of scope

- **Self-updating.** `electron-updater` (with `auto_updates true` and a
  `zip` target) would update the app without the formula, so it is not
  planned.
- **Release automation** (a CI job on a version tag running steps 2-5).
  Revisit once the manual flow has run a few times.
- **Refusing a database migrated by a newer server.** `getDb()` runs
  `migrate()` with no check that the database is ahead of the code, so a
  downgrade runs against an unknown schema. With one copy of the server
  code this is no longer specific to the app; it is worth its own change.
- **Intel Macs.** The cask is arm64-only, since the app is built on and for
  arm64.
- **Linux and Windows packages** (AppImage, deb, MSI). Linux installs from
  source.
- **homebrew-core and homebrew-cask.** After Phase 3, `yaac-server` has no tap
  dependencies, and the cask would depend only on it. Moving `yaac-server` to
  homebrew-core removes the trust step, and moving the cask to
  homebrew-cask drops the `bsklaroff/yaac/` prefix. Both repos require
  notability first: for a self-submission, at least 90 forks, 90 watchers
  or 225 stars on the GitHub repo (docs.brew.sh "Package Acceptance
  Policy"). `yaac-cluster` stays in the tap for krunkit.

## Sources

- Homebrew Tap Trust: https://docs.brew.sh/Tap-Trust
- Homebrew Package Acceptance Policy:
  https://docs.brew.sh/Package-Acceptance-Policy
- Homebrew formula renames: https://docs.brew.sh/Rename-A-Formula
- Homebrew Cask Cookbook: https://docs.brew.sh/Cask-Cookbook
- Homebrew acceptable casks: https://docs.brew.sh/Acceptable-Casks
- electron-builder code signing: https://www.electron.build/code-signing
- electron-builder mac config: https://www.electron.build/configuration/mac
- Apple notarization:
  https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- Hardened runtime:
  https://developer.apple.com/documentation/security/hardened-runtime
