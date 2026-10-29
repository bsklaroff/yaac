# Linux packaging: .deb packages and an apt repository

The desktop app ships for macOS only. `pnpm desktop:release` builds a
signed, notarized arm64 `.dmg`, the `yaac-desktop` cask installs it, and the
cask depends on the `yaac-server` formula, whose CLI the app runs for any
server on the machine (packages/desktop/README.md "Packaging",
homebrew/README.md). On Linux today the only route is a source build
(docs/install-from-source.md), and the desktop app is not distributed at all.

This plan ships Debian and Ubuntu packages with the same split, served from a
signed apt repository so that `apt upgrade` moves the app and the CLI
together, as `brew upgrade` does. The app carries no server and no Node of
its own, the CLI is installed once and shared, and the cluster's tools are a
separate, opt-in package.

Installing a `.deb` takes one `sudo`, which is the norm for desktop apps on
Debian (VS Code, Chrome, Slack and Docker Desktop work the same way). Past
that point, the app's setup does the rest:

- **A containerless server** needs nothing further. The CLI is already on
  PATH, so the setup is `yaac server start`, the same as after the cask.
- **A cluster** needs one more root step, granting your user the rootful
  podman socket. The app runs it through a polkit-guarded helper, so it
  becomes a system password prompt rather than commands typed in a terminal.

Other distros keep the source build. A no-root route for them is sketched
under "Later: a home-dir install", along with why it is not worth building
yet.

## What ships

| Artifact | Contents | Homebrew counterpart |
|---|---|---|
| `yaac-server_<v>_<arch>.deb` | the CLI and server, a private Node, the containerless driver's host deps | `yaac-server` formula |
| `yaac-cluster_<v>_<arch>.deb` | the cluster's host deps and the podman-access helper | `yaac-cluster` formula |
| `yaac-desktop_<v>_<arch>.deb` | the Electron app | `yaac-desktop` cask |
| `yaac-archive-keyring_<v>_all.deb` | the repo's signing key and its `.sources` entry | `brew trust bsklaroff/yaac` |
| `SHA256SUMS`, `SHA256SUMS.asc` | checksums, signed with the repo key | |

Each package but the keyring is built for amd64 and arm64. They are published in the apt
repository and also attached to the `v<VERSION>` GitHub Release beside the
`.dmg`. There is no counterpart of `yaac-libkrun`/`yaac-krunkit`, because on
Linux the cluster runs on the host's rootful podman with no VM
(docs/cluster-setup.md "Linux: rootful podman").

Supported releases are Debian 13 (trixie) and Ubuntu 24.04 LTS and later.
Debian 12 is best effort: its tmux (3.3a) clears the containerless driver's
3.1 floor, but `yaac cluster install` has never run on its podman (4.3),
since docs/install-from-source.md covers podman 5.x. A release is listed as
supported for clusters only once the k8s e2e tier passes on its stock podman
(see "Verification").

## The `yaac-server` package

This package is the counterpart of `Formula/yaac-server.rb`: the published
npm tarball plus what the containerless driver needs on the host.

**Layout.**

```
/usr/lib/yaac/               the npm tarball's contents (dist/, package.json, …)
/usr/lib/yaac/node_modules/  from `npm ci` against dist/npm-shrinkwrap.json
/usr/lib/yaac/node/          the official Node release (bin/node, npm, npx, corepack)
/usr/lib/yaac/node/bin/fd    symlink → /usr/bin/fdfind
/usr/bin/yaac                exec /usr/lib/yaac/node/bin/node /usr/lib/yaac/dist/cli.js "$@"
```

**Node is bundled.** The formula depends on Homebrew's current `node`, and
apt has nothing to match it: Ubuntu 24.04 ships Node 18 and Debian 13 ships
Node 20, without the type stripping that docs/install-from-source.md works
around with nvm. The package therefore carries the official
`node-v<pin>-linux-<arch>.tar.xz`, pinned to the version install-from-source.md
names and checked against nodejs.org's signed `SHASUMS256.txt` at build time.
`/usr/bin/yaac` is a two-line shell wrapper rather than a symlink to
`dist/cli.js`, so its `#!/usr/bin/env node` shebang never picks up whatever
`node` comes first on PATH. The server re-execs with `process.execPath`
(`server-lifecycle.ts`, `peer-bundle.ts`), so it stays on the bundled Node.

**Workspaces need `node` and `npm` on PATH too.** The containerless driver
installs agents with `npm install --global --prefix …` and patches them with
`node <script>` (`drivers/containerless/check.ts`), and each agent's own
`#!/usr/bin/env node` shebang has to resolve. On a stock Ubuntu with only the
bundled Node, neither is found. The fix is one code change: when
`userEnvironment()` (`drivers/containerless/launch.ts`) builds the PATH for
user processes, it **appends** `dirname(process.execPath)` if that directory
is not already on PATH. Appending keeps the user's own Node (nvm, NodeSource)
ahead, so the bundled one is only the fallback. Under Homebrew the directory
is already on PATH, so nothing changes there. The `fd` symlink lives in the
same directory because Debian names fd `fdfind` and the agents look for `fd`.

**Dependencies.**

- `Depends: tmux (>= 3.1), socat, git, curl, lsof, ca-certificates, libgomp1`.
  A create refuses to run without tmux and socat. git, curl and lsof are the
  formula's `uses_from_macos` set. libgomp1 is for the bundled llama.cpp
  title model (docs/workspace-title-model-eval.md), which would otherwise
  fetch it from a distro mirror at runtime.
- `Recommends: fd-find, ripgrep`, the agents' search tools. As the
  formula's comment explains, nothing gates on them.

**Architecture-specific, not `all`.** Node and `@lydell/node-pty`'s
prebuilt binary differ per arch. `npm ci --os=linux --cpu=<arch>` selects
the matching `@lydell/node-pty-linux-*` optional dependency, so both arches
can be staged on one x64 host.

**No maintainer scripts and no systemd unit.** The server is per-user, as on
macOS: `yaac server start` runs it from the user's session, with its data in
`~/.yaac-server`. A system service would be a different product (multi-user,
a service account), and docs/multi-user.md is the place for that. `apt remove`
leaves every data dir alone, like the cask's `zap`.

**Built with `dpkg-deb --build --root-owner-group`** from a staged tree, by a
new `scripts/package-deb.ts`. This needs neither fpm nor Ruby, and it is the
same tool on every Debian host. The script fetches the tarball by version, as
the formula does, so the `.deb` holds exactly what npm published.

## The `yaac-cluster` package

This package is the counterpart of `Formula/yaac-cluster.rb`. It adds no
yaac code of its own. It declares the distro packages a cluster needs and
ships the helper below. kind and kubectl are not among them, because `yaac
cluster install` fetches those itself (see "kind and kubectl are fetched,
not packaged").

- `Depends: yaac-server (= <v>), podman, aardvark-dns, nftables, acl, policykit-1 | polkitd`.
  podman, aardvark-dns, nftables and acl are what docs/install-from-source.md
  tells a Linux user to install, and `yaac cluster install` refuses to run
  without aardvark-dns, or without `nft` under netavark's nftables driver.
  polkit is there for the helper.
- **Swap is not touched.** docs/cluster-setup.md "Linux: swap" stays a manual
  prerequisite, and the setup copy points to it.
- **A `--byo` install needs this package too.** It creates no kind cluster,
  but it builds every image yaac ships on this machine with podman and pushes
  them through a `kubectl port-forward` (docs/cluster-setup.md "Bring your own
  cluster"). On Linux, `ensureRootfulPodmanReachable` also runs on every
  install, byo included, so it needs the socket grant as well. A byo user
  gets aardvark-dns and nftables without using them, but they are small, and
  splitting off a `yaac-byo` package is not worth a fourth package. Two
  changes could remove the need, and both are out of scope here:
  - letting byo build on rootless podman, which would drop the grant;
  - publishing per-architecture images each release, which would drop
    podman entirely and leave a byo user needing only `yaac-server`.

### Podman access through polkit

Under `k8s` on Linux, the CLI needs read/write access to the root-owned
`/run/podman/podman.sock`, which only an admin can grant
(docs/cluster-setup.md "Linux: rootful podman"). The package installs a small
privileged helper for that one step, plus a polkit policy, so the app can ask
for it with a system password prompt. This follows the Linux pattern for a
GUI app that needs one fixed root action, and is the counterpart of a macOS
privileged helper.

- **`/usr/lib/yaac/cluster/grant-podman-access`** (root-owned, 0755) is a
  script form of the grant block in docs/cluster-setup.md "Linux: rootful
  podman": the same drop-in, with the same `-`-prefixed `ExecStartPost=`
  lines naming the numeric uid, then the same `daemon-reload`, `enable` and
  `restart`. The restart makes the drop-in apply the grant. It runs once,
  at setup, when nothing else is likely to be using the socket. A test holds it to that block, as one already
  does for the hint `yaac cluster install` prints. As the one root entry
  point in this plan, it is strict about what it accepts:
  - It takes no arguments, and its target is `PKEXEC_UID`, which pkexec sets
    after clearing the environment. Without it, the helper refuses.
  - The uid must resolve (`getent passwd`) and must not be 0.
  - It writes only `/etc/systemd/system/podman.socket.d/yaac-<name>.conf`,
    for the name the uid resolves to, and writes the grant by uid, never by
    name.
  - It sets a fixed `PATH` and calls only absolute paths (`/usr/bin/setfacl`,
    `/usr/bin/systemctl`, `/usr/bin/getent`).
- **`/usr/lib/yaac/cluster/revoke-podman-access`** has the same shape and
  runs the revoke block from the same section, for `PKEXEC_UID` only. A user
  can therefore drop their own grant without removing the package for
  everyone. `linux/README.md` documents it beside the manual revoke steps.
- **`/usr/share/polkit-1/actions/com.bsklaroff.yaac.podman-access.policy`**
  declares one action per helper, each naming its helper as
  `org.freedesktop.policykit.exec.path`. Both pin their defaults in full
  (`allow_any=no`, `allow_inactive=no`, `allow_active=auth_admin`), so an SSH
  or inactive session never inherits a distro default, and the prompt is
  asked every time and never kept. The grant's message says what it means:
  *"Allow yaac to use the system podman engine. Access to it is equivalent
  to root on this computer."* Neither helper needs `allow_gui`.
- **`postrm`** handles `remove` and `purge` explicitly. The drop-ins are not
  dpkg-owned files, so neither case would clean them up on its own. For
  each `yaac-*.conf` drop-in, it reads the uid from the drop-in's
  `ExecStartPost=` lines, deletes the drop-in, and runs `setfacl -x u:<uid>`
  on `/run/podman` and the socket. It finishes with one `daemon-reload`.
  Removing the live ACL entries is what withdraws the grant at once, rather
  than at the next reboot. postrm never restarts `podman.socket`, which
  would drop other users' connections.

This grants exactly the access the manual steps grant. The only difference
is that removing the package withdraws it for every user at once.
`yaac cluster install`'s own message for an unreachable socket names the
helper (`pkexec /usr/lib/yaac/cluster/grant-podman-access`) when it is
installed, and the manual steps otherwise.

## kind and kubectl are fetched, not packaged

`kind` and `kubectl` are single static binaries, and only the CLI's cluster
commands run them. `yaac cluster install` (and every other `yaac cluster`
command that needs one) fetches its pinned release on first use, on both
platforms, the way `ensureLlamaCpp` fetches llama.cpp:

- Each tool's version and per-platform SHA-256 are compiled into
  `#drivers/k8s/install`, beside the existing pins. kind is pinned at the
  release `k8s/kind-config.yaml`'s node image is built for, which replaces
  the "v0.33.0 or newer" check (`diagnoseOldKind`). kubectl uses the pin
  `dockerfiles/Dockerfile.server` already has (`KUBECTL_VERSION` and its
  per-arch SHA-256s), and a test ties the two together, the way
  `LLAMA_CPP_TAG` is tied to its Dockerfile. The host CLI and the server pod
  then always run the same kubectl.
- The binaries go in `~/.cache/yaac/cluster-tools/<tool>-<version>`. They
  are downloaded into a temp file, checked against the pin, and renamed into
  place, so an interrupted download never leaves a binary that looks
  usable. A new pin is a new path, so an upgrade never runs a stale copy, and
  an old one is deleted once the new one is in place.
- Every call runs them by absolute path. kind is spawned only from
  `#drivers/k8s/install`, so a `clusterTool('kind')` resolver there covers
  it. kubectl is also spawned from substrate (`substrate/rollout.ts`,
  `substrate/port-forward.ts`), which install can import but not the reverse.
  Those spawns also run inside the server pod, where the image's
  `/usr/local/bin/kubectl` is correct. Substrate therefore keeps the kubectl
  path as a setting: its barrel exports `useKubectl(path)`, which defaults to
  the bare name. Each host-side `yaac cluster` command calls it with the
  fetched path before touching the cluster, and the server never calls it.
  kind inherits `CONTAINER_HOST` as it does today. A `kind` or `kubectl` on PATH is never
  used, so the version yaac runs is always the one it was tested with. A
  user's own `kubectl` keeps working for looking at the cluster.
- `requireBinaries` checks only podman. `yaac cluster check` reports a
  missing tool as one that the next install fetches, rather than as a
  failure to fix.
- Without network access, the first install fails at the download and names
  the URL. It needs the network anyway, to pull the kind node image and
  Calico.

This makes Debian vendoring and `update-alternatives` unnecessary, so a
distro `kubectl` can never conflict with ours. It also works on every install
route: the `.deb`, Homebrew, and a source build. `Formula/yaac-cluster.rb`
drops its `kind` and `kubernetes-cli` dependencies and keeps podman and
`yaac-krunkit`. podman and krunkit are not fetched on macOS because they need
the VM helpers and the patched, source-built libkrun that Homebrew already
assembles.

Dev and test hosts keep their own `kind` and `kubectl` on PATH, because the
test harness (`test/global-setup.ts`, `test/support/kind-byo.ts`) calls them
directly. The CLI under test still runs its pinned copies.

## The `yaac-desktop` package

The package is built by electron-builder, from a `linux:` block beside `mac:`
in `packages/desktop/electron-builder.yml`:

```yaml
linux:
  target: [dir]           # local builds; release-linux.ts overrides to deb
  icon: build/icon.png    # electron-builder derives the hicolor sizes
  category: Development
  executableName: yaac
  synopsis: Desktop app for the yaac agent sandbox manager
  desktop:
    entry:
      StartupWMClass: yaac
deb:
  # Recommends, not Depends: apt installs Recommends by default, so a
  # default install gets the CLI as the cask does, while
  # --no-install-recommends gives a remote-only client with no Node or tmux.
  recommends: [yaac-server]
  afterInstall: build/linux/after-install.sh
  afterRemove: build/linux/after-remove.sh
```

**The Chromium sandbox stays on.** The renderer loads web content from
whichever server is selected, so `--no-sandbox` is never acceptable.
electron-builder's deb makes `chrome-sandbox` `4755 root`. Ubuntu 23.10 and
later also restrict unprivileged user namespaces through AppArmor
(`kernel.apparmor_restrict_unprivileged_userns=1`), and an Electron app
without a profile then has to rely on that SUID helper. `after-install.sh`
installs `/etc/apparmor.d/yaac`, an `unconfined` profile with `userns,` for
`/opt/yaac/yaac` (the same kind of profile Ubuntu ships for Chrome and VS
Code), and loads it with `apparmor_parser -r` when AppArmor is active.
`after-remove.sh` removes it. On Debian, which has no such restriction, the
profile is inert.

**No updater, as on macOS.** `publish: null` stays. The apt repository is the
update path, and a `.deb` installed from the Release page gets no updates
until the repo is added.

**node-pty.** The `asarUnpack` rule already covers it, and its Linux prebuilt
needs no `spawn-helper`. Each arch's build must contain that arch's
`@lydell/node-pty-linux-*` package. Adding `supportedArchitectures` (`os:
[current, linux]`, `cpu: [current, x64, arm64]`) to pnpm-workspace.yaml makes
one install hold both, and the release script fails if the unpacked `.node`
for the target arch is missing (it checks the ELF machine with `file`).

## Shell changes for Linux

The main process assumes macOS in about a dozen places. None is deep, but
each needs a decision:

- **Wording (`servers-page.ts`, `local-setup.ts`, `server-control.ts`,
  `server-switch.ts`, `main.ts`, `@yaac/shared/setup-copy`).** "this Mac"
  appears about 40 times in user-visible text. Add a `thisMachine` noun to
  `@yaac/shared/setup-copy` ("this Mac" on darwin, "this computer" elsewhere)
  and use it throughout. Doc comments in `types.ts` say "this machine".
- **Setup (`local-setup.ts`).** `PLANS` becomes per-platform. Homebrew's
  steps (trust, tap, install) have no unprivileged counterpart on Linux,
  because installing a package needs root. Linux setups therefore never run
  apt. A step that needs a package shows its command to copy, and the setup
  runs everything after it:

  | | Containerless | Cluster |
  |---|---|---|
  | to copy, until installed | `sudo apt install yaac-server` | `sudo apt install yaac-cluster` |
  | run by the app | `yaac server start` | `pkexec /usr/lib/yaac/cluster/grant-podman-access` |
  | | `yaac host check` | `yaac cluster install` |

  - While a package is missing (`yaac` not on PATH, or no helper for the
    cluster), `blocked` is the new reason `'needs-package'`. The page shows
    the command, preceded by the keyring package's two lines from "The apt
    repository" when `/etc/apt/sources.list.d/yaac.sources` is absent, and
    says "run this in a terminal, then come back". The tray's next status read notices the
    install. After a default `yaac-desktop` install the CLI is already
    present, so the containerless setup is never blocked.
  - The grant step skips itself when the socket already accepts this user
    (`fs.access(sock, R_OK | W_OK)`), the way a Homebrew step skips an
    installed formula. The native confirmation before a cluster setup
    repeats the policy's root-equivalence sentence, alongside the commands it
    lists.
  - `pkexec` fails without a polkit authentication agent (some minimal
    window managers have none). The step's error then names the helper's
    command for a terminal, where `pkexec` prompts on the TTY.
  - The cluster card mentions swap (docs/cluster-setup.md "Linux: swap") but
    does not check for it.
  - `CLUSTER_SUPPORTED` becomes `darwin && arm64 || linux && x64`. arm64
    Linux joins once the k8s e2e tier has passed on an arm64 host: gVisor,
    Calico and kind all publish arm64, but yaac's image builds have never run
    there.
  - `no-brew` remains a macOS-only reason.
- **PATH (`server-process.ts`).** `adoptLoginShellPath` stays: GNOME and KDE
  launch apps from the systemd user environment, which usually lacks what
  `~/.bashrc` adds (nvm), so the `-lic` read matters on Linux too.
  `HOMEBREW_BINS` becomes per-platform: on Linux it is
  `/home/linuxbrew/.linuxbrew/bin`, since the formula installs on Linuxbrew
  too, and `/usr/bin` is always present. The "yaac is not on PATH" error
  (`server-control.ts`) names the apt command on Linux.
- **Tray (`main.ts`, `tray-icon.ts`).** Linux trays are StatusNotifierItems.
  - Template images are ignored, so a black glyph vanishes on GNOME's and
    KDE's dark panels. `buildTrayBitmap` takes a color, and Linux draws it
    white at 24px.
  - A click opens the menu and emits no `click`, so Linux puts **Open yaac**
    first in the menu.
  - `menu-will-show` never fires, so the menu is only as fresh as the
    60-second poll. Every action re-reads the state anyway.
  - Debian's stock GNOME has no tray without the AppIndicator extension,
    where hiding the window would leave no visible way back. Relaunching from
    the app grid already shows it again (`second-instance`), and the first
    time the window hides on Linux, a notification says so.
- **Badge (`applyAttention`).** On Linux, `app.setBadgeCount(n)` replaces
  `app.dock.setBadge`. It shows on launchers that implement the Unity API
  (Ubuntu's dock, KDE's task manager) when the `.desktop` file matches
  `desktopName`, and does nothing elsewhere. The notifications carry the
  signal either way.
- **Window chrome.** `titleBarStyle: 'hidden'` makes a frameless window on
  Linux. The SPA already draws its own controls, and the zoom button already
  maximizes off darwin (`window-zoom.ts`). Electron 44 defaults to Wayland
  where it is available, so dragging through `titlebar-drag`, edge resize and
  the window shadow need a hand check under both GNOME Wayland and an X11
  session. Keeping the controls on the left is fine for a first release.
- **Menu (`menu.ts`).** `appMenu` and `windowMenu` are macOS roles. On Linux,
  `appMenuTemplate` returns File (Quit, Ctrl+Q), Edit and View roles, and the
  window sets `autoHideMenuBar`. Check that accelerators fire in a frameless
  window with the bar hidden. Terminal copy and paste never depend on this,
  because the SPA's `clipboardKeyAction` handles non-Mac keys itself.

The CLI's own Mac-only advice also changes. `install/check.ts` fixes that
name `brew install … yaac-cluster` should name `apt install yaac-cluster`
when the CLI runs from `/usr/lib/yaac`; its package root tells it how it was
installed.

## The apt repository

The apt repository is the counterpart of the tap. It is a tree of static
files at `https://apt.<domain>` (the domain is an open question). With one
channel and two arches, a single `stable main` suite is enough:

```
dists/stable/{InRelease,Release}
dists/stable/main/binary-{amd64,arm64,all}/Packages{,.gz}
pool/main/y/yaac-*/…
yaac-archive-keyring.deb
```

`scripts/publish-apt.ts` generates it with `apt-ftparchive` (packages,
release) and `gpg --clearsign`, which writes `InRelease`, then uploads it.
There is no detached `Release.gpg`, since every supported apt reads
`InRelease`. It keeps the last three
versions in `pool/`, so a rollback is one `apt install yaac-server=<v>`.

**Hosting.** The tree lives in object storage (Cloudflare R2, which charges
nothing for egress) behind the custom domain. GitHub Pages does not fit:
- its git backing rejects files over 100 MB, and an Electron `.deb` is
  close to that;
- its 1 GB site limit is about what three versions of three packages on two
  arches add up to;
- apt resolves every package path relative to the repo URL, so the `.deb`s
  cannot sit on GitHub Releases behind Pages-hosted indexes.

### The keyring package

`yaac-archive-keyring` (arch `all`) installs two files: the signing key at
`/usr/share/keyrings/yaac-archive-keyring.gpg` and
`/etc/apt/sources.list.d/yaac.sources`, which names the repo with
`Signed-By:` set to that key. It is the repo's entry point, the pattern
Microsoft's `packages-microsoft-prod.deb` uses, and it is itself published in
the repo, so a key rotation or a move to another URL reaches every install as
an ordinary upgrade. End-user install:

```sh
curl -fsSLO https://apt.<domain>/yaac-archive-keyring.deb
sudo apt install ./yaac-archive-keyring.deb
sudo apt update
sudo apt install yaac-desktop            # the app + yaac-server
sudo apt install yaac-cluster            # for a local kubernetes cluster
```

The key is scoped with `Signed-By` and never added to the global trusted
set. Installing the keyring package is the explicit step that trusts the
repo, the apt counterpart of `brew trust bsklaroff/yaac`, and the setup copy
says so in the same words (`trustSentence`). Before installing it, a user
can check the key's fingerprint, which is published in `linux/README.md`,
with `dpkg-deb -x` and `gpg --show-keys`.

The `.deb`s on the GitHub Release also install without the repo (`sudo apt
install ./yaac-server_<v>_amd64.deb ./yaac-desktop_<v>_amd64.deb`), and
nothing updates them until the keyring package is installed. The packages
do not add the repo from a postinst, as VS Code and Chrome do, because that
would be a silent trust grant, and the Homebrew side deliberately makes
trust explicit.

**Signing key.** The repo is signed with a dedicated ed25519 signing
subkey. Its primary key stays offline with the Developer ID material. The
subkey lives on a hardware token, which is plugged into the release machine
only while `pnpm publish:apt` signs. The fingerprint goes in
`linux/README.md` and docs/install-from-source.md, next to a published
revocation certificate.

**Rotation** needs an overlap. A client that holds only the old key cannot
verify an `InRelease` signed by the new one, so it could never fetch the
keyring update that would fix it. The steps:
1. Publish a keyring version whose
   `/usr/share/keyrings/yaac-archive-keyring.gpg` holds both keys, still
   signing with the old one.
2. Wait at least one release.
3. Switch signing to the new key.
4. In a later release, drop the old key from the keyring.

**Compromise** cannot be handled through the repo, because the revocation
would arrive signed by the revoked key. `linux/README.md` says so, and tells
users to re-fetch `yaac-archive-keyring.deb` by hand, check the new
fingerprint, and install it.

## Build and release

New scripts, alongside the macOS ones:

```sh
pnpm desktop:package           # on Linux: unpacked app in dist-app/linux-unpacked
pnpm desktop:install           # on Linux: apt install the locally built yaac-desktop .deb
pnpm desktop:release-linux     # yaac-desktop .deb, both arches
pnpm package:deb               # yaac-server + yaac-cluster .debs, both arches, and the keyring
pnpm publish:apt               # regenerate and sign the repo from dist-deb/
```

- `scripts/release-linux.ts` in packages/desktop is the counterpart of
  `release-app.ts`. It runs electron-builder with `--linux deb --x64
  --arm64`, stamps the root version, and checks each `.deb` before printing
  its hash. It deletes any `.deb` that fails, the same guarantee the stapler
  check gives the `.dmg`. The checks are:
  - `dpkg-deb -c` shows `chrome-sandbox` as `-rwsr-xr-x root`;
  - the AppArmor profile and `yaac.desktop` are present;
  - the unpacked `pty.node` has the target ELF machine.
- `scripts/package-deb.ts` ends with the same kind of check for its
  packages: the helper is root-owned and 0755, the polkit policy is valid
  XML naming the helper's path, and the keyring's key has the published
  fingerprint.
- `install-app.ts` branches on platform. macOS keeps `ditto`, and Linux runs
  `sudo apt install --reinstall ./dist-app/yaac-desktop_*.deb`.
- The release steps go in a sibling `linux/README.md`, because `homebrew/` is
  mirrored into the tap verbatim:
  1. after `pnpm publish`, run `pnpm package:deb`, which fetches the tarball
     by version;
  2. run `pnpm desktop:release-linux`;
  3. upload the `.deb`s and the signed `SHA256SUMS` to the same `v<VERSION>`
     release as the `.dmg`;
  4. run `pnpm publish:apt`, which uploads the apt repo.
- Every Linux artifact builds on any x64 Debian or Ubuntu host. The arm64
  ones are cross-staged and smoke-tested under `qemu-user-static`. There is
  no CI today, and this plan adds none. A GitHub Actions job on
  `ubuntu-24.04` and `ubuntu-24.04-arm` is the next step once releases are
  frequent enough to need it.

## Verification

- **Unit tests (`packages/desktop/test/`).**
  - `local-setup.test.ts`: the Linux plans, the `needs-package` block and its
    copy, the grant step's skip, and `CLUSTER_SUPPORTED` per platform and
    arch.
  - `menu.test.ts`: the Linux template.
  - `tray-icon.test.ts`: the colored bitmap.
  - `server-process.test.ts`: the per-platform extra PATH dirs.
  - `packages/server/test/drivers/containerless/`: `userEnvironment` appends
    the exec dir only when it is absent.
  - `packages/server/test/drivers/k8s/install/`: the install fetches kind
    and kubectl into the cache, refuses one whose hash does not match, reuses
    a cached copy, and runs them by path even with other copies on PATH. A
    stub HTTP server stands in for the download.

  All of these run on any host, with `process.platform` injected.
- **Package contents.** A small `test/packaging/` script (not a vitest
  project, since it needs the built artifacts) installs the three `.deb`s
  into clean `debian:trixie` and `ubuntu:24.04` containers. It runs `yaac
  --version` and `yaac host check`, then a containerless `yaac server start`
  plus a workspace create with a stub agent, which proves that `node`, `npm`
  and `fd` resolve for workspaces. It then runs
  `grant-podman-access` with a fake `PKEXEC_UID` and checks the drop-in and
  the ACLs. It then checks that the helper refuses uid 0 and a missing
  `PKEXEC_UID`, and that `revoke-podman-access` removes both. Finally, it
  grants again, runs `apt remove yaac-cluster`, and checks that the drop-in
  and the live ACL entries are both gone while `~/.yaac-server` stays.
  On a host with systemd, it also checks the generated drop-in with
  `systemd-analyze verify`, and confirms that a failing grant line (say,
  with `acl` removed) leaves `podman.socket` `active (listening)` after a
  restart.
- **The desktop app, by hand.** The README's "Verifying by hand" list, run
  on Ubuntu 24.04 (GNOME, Wayland), Debian 13 (GNOME without AppIndicator)
  and KDE Plasma (X11). Beyond that list, check that:
  - the window draws, drags and resizes;
  - the tray glyph is visible and its menu works;
  - a waiting workspace notifies, and clicking the notification focuses the
    window;
  - Ctrl+Shift+C/V work in a terminal;
  - a cluster setup prompts once through polkit and lands on the new
    cluster.

  The existing `test-playwright-scripts/desktop-*.js` scripts take a
  packaged build's path, so they also run against `linux-unpacked/yaac` under
  `xvfb-run`.
- **The cluster.** On a clean Ubuntu 24.04 VM and a clean Debian 13 VM:
  install `yaac-cluster` with no `kind` or `kubectl` on PATH, run the setup
  from the app, then run `yaac cluster check` and the k8s e2e tier against
  the result. Passing is what lists a release as supported. On a Mac, a
  `yaac cluster install` with the formula's `kind` and `kubernetes-cli`
  uninstalled checks the same fetch.

## Later: a home-dir install

For distros without a `.deb`, the no-root route would be the one rustup, uv
and Claude Code take: a self-contained runtime under `~/.local/share/yaac`
(the CLI, Node, and static tmux, socat, fd and ripgrep) with a link in
`~/.local/bin`. A downloadable app (an AppImage or a tarball) could then set
up a containerless server with no root at all. It is left out for three
reasons:

- **It conflicts with a package install.** Debian's `~/.profile` puts
  `~/.local/bin` ahead of `/usr/bin`, and both copies share `~/.yaac-server`
  and `~/.yaac-client/server.json`. Two versions would then manage one
  server and migrate one database, and the tray's "restart to update" would
  compare against whichever `yaac` came first. The installer would have to
  refuse when a dpkg-installed `yaac-server` is present, and the setup would
  have to treat one as done.
- **It does not reach a cluster.** `yaac cluster install` fetches `kind`
  and `kubectl` itself, but rootful podman, netavark, aardvark-dns and nftables cannot,
  and neither can the QEMU a `podman machine` VM would need. A cluster user
  would install those with their distro's package manager and sudo anyway.
- **It needs its own updater**, which neither the Mac nor the apt side has.

It becomes worth building if users on other distros ask for the desktop app.
Until then, they use docs/install-from-source.md, and the desktop app builds
from source there too (`pnpm desktop:package`).

**A remote-only AppImage is a smaller option, and it can ship on its own.**
None of the reasons above apply to an app with no CLI. It would be what
`--no-install-recommends` gives on Debian: a client of servers elsewhere,
plus a local one if the user installs the CLI some other way. It is
deferred for reasons of its own:
- It has no updater, and no package manager to stand in for one.
- With no postinst to install the AppArmor profile, it cannot start
  sandboxed on Ubuntu 23.10+, and it must never run with `--no-sandbox`.
  That leaves it usable only on the distros it is meant for.
- On distros where it can start, check whether electron-builder's
  AppImage runtime still needs `libfuse2`.

It is one more electron-builder target if a user of another distro asks for
it.

## Docs to update when this ships

- packages/desktop/README.md: a "Packaging (Linux)" section. The
  macOS-only statements in "Shell behavior" (tray, Dock, Finder PATH) become
  per-platform, and the setup table gets its Linux column.
- `linux/README.md` (new): the end-user install, the packages, the podman
  helper, the release flow and the key.
- docs/cluster-setup.md "Linux: rootful podman": the helper as the packaged
  way to grant access, with the manual steps kept for source installs.
- docs/install-from-source.md: Debian and Ubuntu users are pointed at the
  apt repo first. The manual `kind` and `kubectl` downloads are dropped,
  since `yaac cluster install` fetches them.
- homebrew/README.md and `Formula/yaac-cluster.rb`: the formula no longer
  depends on `kind` or `kubernetes-cli`.
- docs/cluster-setup.md: "kind and Kubernetes versions" names the pinned
  versions and the cache dir, instead of a minimum version on PATH.
- The root README's install section.
- This plan is deleted once its material has moved into those references.

## Phases

1. **The CLI packages.** `yaac cluster install` fetching kind and kubectl
   (which can ship first and on its own, for macOS as well), then
   `yaac-server`, `yaac-cluster` with the podman helper, the
   `userEnvironment` PATH append, the keyring package, the apt repo and
   `linux/README.md`. This is useful without the desktop app, since it
   replaces the nvm-and-source build for CLI users.
2. **The desktop app on Linux.** The shell changes, the electron-builder
   `linux` block, and the `.deb` with its AppArmor profile, followed by a
   release.
3. **Follow-ups, if wanted.** arm64 cluster support, rootless podman for
   `--byo`, CI builds, an RPM
   (another electron-builder target, though the CLI package and a dnf repo
   are the real work), and the home-dir install above.

## Open questions

- **The repo's domain.** Any domain yaac controls will do. The keyring
  package can move the URL later, but the keyring's own download link is
  printed in docs and in the app's setup copy, so pick one before the first
  public release.
