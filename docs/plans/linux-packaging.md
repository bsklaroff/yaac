# Linux packaging: the server and the cluster from apt

On macOS a server is two commands: `brew install bsklaroff/yaac/yaac-server`
and `yaac server start`. A local cluster adds the `yaac-cluster` formula and
`yaac cluster install` (homebrew/README.md). On Linux the only route is
a source build (docs/install-from-source.md): Node from nvm, pnpm, kind and
kubectl downloaded by hand, and a systemd drop-in pasted in to grant the
podman socket. The desktop app is a client only on Linux
(packages/desktop/README.md), so it can't do any of this for the user.

This plan gives Debian and Ubuntu the same two packages, served from a
signed apt repository, so a laptop and an always-on server install alike:

```sh
# once: trust the repo
curl -fsSLO https://apt.<domain>/yaac-archive-keyring.deb
sudo apt install ./yaac-archive-keyring.deb && sudo apt update

# a containerless server
sudo apt install yaac-server
yaac server start && yaac host check

# a local kubernetes cluster
sudo apt install yaac-cluster
sudo yaac-podman-access grant
yaac cluster install
```

`apt upgrade` moves the CLI, the server and the cluster's tools together, as
`brew upgrade` does. A server that has to survive a reboot gets one more
command, `yaac server autostart on` ("Surviving a reboot"). The packages are
the same on a laptop and on a server. A server machine only differs in how
clients reach it (docs/remote-hosting.md).

Homebrew on Linux keeps working for `yaac-server`, since the formula already
installs there. `yaac-cluster` has no Linuxbrew route, because its krunkit
dependency is macOS-only and the cluster needs the distro's rootful podman.
Other distros keep the source build ("Later: a home-dir install").

## What ships

| Artifact | Contents | Homebrew counterpart |
|---|---|---|
| `yaac-server_<v>_<arch>.deb` | the CLI and server, a private Node, the containerless driver's host deps | `yaac-server` formula |
| `yaac-cluster_<v>_<arch>.deb` | the cluster's host deps and the podman-access helper | `yaac-cluster` formula |
| `yaac-desktop_<v>_<arch>.deb` | the client-only desktop app, as `pnpm desktop:release` builds it today | `yaac-desktop` cask |
| `yaac-archive-keyring_<v>_all.deb` | the repo's signing key and its `.sources` entry | naming each formula in `brew install` |
| `SHA256SUMS`, `SHA256SUMS.asc` | checksums, signed with the repo key | |

Every package except the keyring is built for amd64 and arm64. They are
attached to the `v<VERSION>` GitHub Release and published in the apt repo.
The repo gives the desktop app an update path, which it lacks today. The
packages don't depend on each other except `yaac-cluster` on `yaac-server`.
A laptop that only connects to a server elsewhere installs `yaac-desktop`
alone, and a headless server installs no desktop app.

Supported releases are Debian 13 (trixie) and Ubuntu 24.04 LTS and later.
Debian 12 is best effort: its tmux (3.3a) clears the containerless driver's
3.3 floor, but `yaac cluster install` has never run on its podman (4.3). A
release counts as supported for clusters only once the k8s e2e tier passes
on its stock podman ("Verification"). The cluster is supported on amd64. On
arm64, gVisor, Calico and kind all publish builds, but yaac's image builds
have never run there, so arm64 is listed once the e2e tier passes on an
arm64 host.

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

- `Depends: tmux (>= 3.3), git, curl, lsof, ca-certificates, libgomp1`.
  A create refuses to run without tmux. git, curl and lsof are the
  formula's `uses_from_macos` set. libgomp1 is for the bundled llama.cpp
  title model (docs/workspace-title-model-eval.md), which would otherwise
  fetch it from a distro mirror at runtime.
- `Recommends: fd-find, ripgrep`, the agents' search tools. As the
  formula's comment explains, nothing gates on them.

**Architecture-specific, not `all`.** Node and `@lydell/node-pty`'s
prebuilt binary differ per arch. `npm ci --os=linux --cpu=<arch>` selects
the matching `@lydell/node-pty-linux-*` optional dependency, so both arches
can be staged on one host.

**No maintainer scripts, no system service.** The server is per-user, as on
macOS: `yaac server start` runs it as the user, with its data in
`~/.yaac-server`. A system-wide service would be a different product (a
service account, every user's projects in one place), and docs/multi-user.md
is the place for that. `apt remove` leaves every data dir alone, like the
cask's `zap`. After `apt upgrade` a running server is on the old build until
restarted, as after `brew upgrade`: `yaac server start` says so and names
`yaac server restart`.

**Built with `dpkg-deb --build --root-owner-group`** from a staged tree, by a
new `scripts/package-deb.ts`. This needs neither fpm nor Ruby, and it is the
same tool on every Debian host. The script fetches the tarball by version, as
the formula does, so the `.deb` holds exactly what npm published.

## Surviving a reboot

docs/remote-hosting.md lists this as not yet covered: after a reboot a
containerless server has to be started again by hand, with the flags it was
installed with. A server machine needs it; a laptop can take it or leave it.
It belongs to the CLI rather than the package, so it works the same for a
`.deb`, Homebrew on Linux and a source install:

- **`yaac server autostart on`** writes a systemd **user** unit,
  `~/.config/systemd/user/yaac-server.service`. The unit runs
  `yaac server run` (the existing foreground mode) with the running
  server's flags (`--tailnet <host>` for a tailnet install) and the data dir
  that `YAAC_DATA_DIR` names. It then runs `systemctl --user enable --now`,
  and `loginctl enable-linger` so the user's manager starts at boot with no
  login. systemd's default polkit rule lets a user in an active local
  session turn on lingering for themselves without a password. Where polkit
  wants an admin instead (check an SSH session on each supported release),
  the command fails with `sudo loginctl enable-linger <user>` to run. `autostart off` disables and removes the
  unit and leaves lingering alone, since other things may rely on it.
- **While the unit is enabled, `yaac server start|stop|restart` go through
  `systemctl --user`**, so a restart to update never races systemd's own
  restart of the unit. `yaac server status` reports whether autostart is on.
- **Lingering also keeps workspaces alive across logout** in their systemd
  slices (docs/containerless-driver.md "Lifetime"), which an always-on
  server wants anyway.
- **macOS** gets the counterpart later, a launchd agent written the same way,
  but it isn't part of this plan.

A cluster's server is a Deployment, so it comes back with the cluster. The
cluster itself comes back only if the kind node container restarts at boot.
Before shipping, check the restart policy kind gives the node under podman,
and check whether podman's `podman-restart.service` brings it back. If it
does, `yaac cluster install` enables that service on Linux. Otherwise
`yaac cluster autostart on` gets a small system unit that runs
`yaac cluster start` after `podman.socket`, installed with the same sudo as
the grant.

## The `yaac-cluster` package

This package is the counterpart of `Formula/yaac-cluster.rb`. It adds no
yaac code of its own. It declares the distro packages a cluster needs and
ships the helper below. kind and kubectl are not among them, because `yaac
cluster install` fetches those itself (see "kind and kubectl are fetched,
not packaged").

- `Depends: yaac-server (= <v>), podman, aardvark-dns, nftables, acl`.
  podman, aardvark-dns, nftables and acl are what docs/install-from-source.md
  tells a Linux user to install, and `yaac cluster install` refuses to run
  without aardvark-dns, or without `nft` under netavark's nftables driver.
- **Swap is not touched.** docs/cluster-setup.md "Linux: swap" stays a manual
  prerequisite. It matters most on a laptop's smaller memory, so
  `yaac cluster check` and linux/README.md point to it.
- **A `--byo` install needs this package too.** It creates no kind cluster,
  but it builds every image yaac ships on this machine with podman and pushes
  them through a `kubectl port-forward` (docs/cluster-setup.md "Bring your own
  cluster"). On Linux, `ensureRootfulPodmanReachable` also runs on every
  install, byo included, so it needs the socket grant as well. A byo user
  gets aardvark-dns and nftables without using them, but they are small, and
  splitting off a `yaac-byo` package is not worth a fourth package.

### Podman access with one sudo

Under `k8s` on Linux, the CLI needs read/write access to the root-owned
`/run/podman/podman.sock`, which only an admin can grant
(docs/cluster-setup.md "Linux: rootful podman"). The package installs one
helper for that step, so the user runs a single fixed command instead of
pasting the drop-in:

- **`/usr/sbin/yaac-podman-access grant|revoke`** (root-owned, 0755) is a
  script form of the grant and revoke blocks in docs/cluster-setup.md
  "Linux: rootful podman". `grant` writes the same drop-in, with the same
  `-`-prefixed `ExecStartPost=` lines naming the numeric uid, then runs the
  same `daemon-reload`, `enable` and `restart`. The restart is what makes
  the drop-in apply the grant. It runs once, at setup, when nothing else is
  likely to be using the socket. A test holds it to the doc's blocks, as one
  already does for the hint `yaac cluster install` prints. It is the one
  root entry point in this plan, so it is strict about what it accepts:
  - Its target is `SUDO_UID`, the user who ran sudo. It refuses without it,
    so a root shell can't grant root by accident. It takes no user argument.
  - The uid must resolve (`getent passwd`) and must not be 0.
  - It writes only `/etc/systemd/system/podman.socket.d/yaac-<name>.conf`,
    for the name the uid resolves to, and writes the grant by uid, never by
    name.
  - It sets a fixed `PATH` and calls only absolute paths (`/usr/bin/setfacl`,
    `/usr/bin/systemctl`, `/usr/bin/getent`).
- **`postrm`** handles `remove` and `purge` explicitly. The drop-ins are not
  dpkg-owned files, so neither case would clean them up on its own. For
  each `yaac-*.conf` drop-in, it reads the uid from the drop-in's
  `ExecStartPost=` lines, deletes the drop-in, and runs `setfacl -x u:<uid>`
  on `/run/podman` and the socket. It finishes with one `daemon-reload`.
  Removing the live ACL entries is what withdraws the grant at once, rather
  than at the next reboot. postrm never restarts `podman.socket`, which
  would drop other users' connections.

This grants exactly the access the manual steps grant, which is equivalent
to root on the machine. linux/README.md says so beside the command. When the
socket is unreachable, `yaac cluster install` names
`sudo yaac-podman-access grant` if the helper is installed, and the manual
steps otherwise. sudo works the same on a laptop and over SSH, so there is
no polkit policy: the desktop app, the only GUI that could have used one, is
a client only on Linux.

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
krunkit. podman and krunkit are not fetched on macOS because they need
the VM helpers and libkrun that Homebrew already assembles.

Dev and test hosts keep their own `kind` and `kubectl` on PATH, because the
test harness (`test/global-setup.ts`) calls them
directly. The CLI under test still runs its pinned copies.

## CLI advice that names Homebrew

`install/check.ts` fixes that name `brew install … yaac-cluster` name
`sudo apt install yaac-cluster` when the CLI runs from `/usr/lib/yaac`. The
package root tells it how it was installed. A source install keeps the
manual steps.

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
`InRelease`. It keeps the last three versions in `pool/`, so a rollback is
one `apt install yaac-server=<v>`.

**Hosting.** The tree lives in object storage (Cloudflare R2, which charges
nothing for egress) behind the custom domain. GitHub Pages does not fit:
- its git backing rejects files over 100 MB, and the desktop `.deb` is
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
an ordinary upgrade.

The key is scoped with `Signed-By` and never added to the global trusted
set. Installing the keyring package is the explicit step that trusts the
repo, the apt counterpart of naming a formula in `brew install`, which
trusts that item. Before installing it, a user can check the key's
fingerprint, which is published in linux/README.md, with `dpkg-deb -x` and
`gpg --show-keys`.

The `.deb`s on the GitHub Release also install without the repo (`sudo apt
install ./yaac-server_<v>_amd64.deb`), and nothing updates them until the
keyring package is installed. The packages do not add the repo from a
postinst, as VS Code and Chrome do, because that would be a silent trust
grant, and the Homebrew side keeps trust explicit: it extends only to the
items a command names.

**Signing key.** The repo is signed with a dedicated ed25519 signing
subkey. Its primary key stays offline with the Developer ID material. The
subkey lives on a hardware token, which is plugged into the release machine
only while `pnpm publish:apt` signs. The fingerprint goes in
linux/README.md and docs/install-from-source.md, next to a published
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
would arrive signed by the revoked key. linux/README.md says so, and tells
users to re-fetch `yaac-archive-keyring.deb` by hand, check the new
fingerprint, and install it.

## Build and release

The release machine is the Mac that already builds every desktop artifact
(`pnpm desktop:release`, packages/desktop/README.md "Packaging"). No
GitHub Actions are involved.

```sh
pnpm package:deb    # yaac-server + yaac-cluster .debs for amd64 and arm64, and the keyring
pnpm test:packaging # the package install test, in Linux containers
pnpm publish:apt    # regenerate and sign the repo from the release's .debs
```

- `scripts/package-deb.ts` fetches the published tarball by version, stages
  each package's tree for each arch (`npm ci --os=linux --cpu=<arch>`
  selects node-pty's binary, as it does from any host), and builds it with
  `dpkg-deb --build --root-owner-group`, which Homebrew's `dpkg` provides
  on macOS. It ends by checking what it can without running Linux code: the
  helper is root-owned and 0755, the unpacked `pty.node` and the bundled
  `node` have the target ELF machine, and the keyring's key has the
  published fingerprint. It deletes any `.deb` that fails a check.
- `pnpm test:packaging` runs the package install test below in
  `debian:trixie` and `ubuntu:24.04` containers on the Mac's podman: arm64
  natively, and amd64 under the podman machine's emulation, which is slow
  but fine for a smoke test.
- **Signing and publishing stay on the release machine**, because the
  signing subkey lives on a hardware token. `pnpm publish:apt` signs
  `SHA256SUMS` and the repo's `InRelease`, and uploads the repo.
- The release steps go in a sibling linux/README.md, because `homebrew/` is
  mirrored into the tap verbatim. After `pnpm publish`, run
  `pnpm package:deb` and `pnpm test:packaging`. Upload the `.deb`s and the
  signed `SHA256SUMS` to the `v<VERSION>` release with the desktop
  artifacts (homebrew/README.md), then run `pnpm publish:apt`.

## Verification

- **Unit tests.**
  - `packages/server/test/drivers/containerless/`: `userEnvironment` appends
    the exec dir only when it is absent.
  - `packages/server/test/drivers/k8s/install/`: the install fetches kind
    and kubectl into the cache, refuses one whose hash does not match, reuses
    a cached copy, and runs them by path even with other copies on PATH. A
    stub HTTP server stands in for the download.
  - `packages/cli/test/`: `autostart on` writes a unit with the running
    server's flags and data dir, and `start|stop|restart` go through
    `systemctl --user` while it is enabled. A stub `systemctl` and
    `loginctl` record their calls.
- **Package install test** (`test/packaging/`, run by `pnpm test:packaging`;
  not a vitest project, since it needs the built artifacts). It installs the `.deb`s
  into clean `debian:trixie` and `ubuntu:24.04` containers, then:
  - runs `yaac --version` and `yaac host check`;
  - runs a containerless `yaac server start` plus a workspace create with a
    stub agent, which proves that `node`, `npm` and `fd` resolve for
    workspaces;
  - runs `sudo yaac-podman-access grant` as a test user and checks the
    drop-in and the ACLs;
  - checks that the helper refuses without `SUDO_UID` and for uid 0, and
    that `revoke` removes both the drop-in and the ACLs;
  - grants again, runs `apt remove yaac-cluster`, and checks that the
    drop-in and the live ACL entries are both gone while `~/.yaac-server`
    stays.

  On a host with systemd, it also checks the generated drop-in with
  `systemd-analyze verify`, and confirms that a failing grant line (say,
  with `acl` removed) leaves `podman.socket` `active (listening)` after a
  restart.
- **The cluster and reboots, by hand.** On a clean Ubuntu 24.04 VM and a
  clean Debian 13 VM:
  - install `yaac-cluster` with no `kind` or `kubectl` on PATH, grant, run
    `yaac cluster install`, then `yaac cluster check` and the k8s e2e tier
    against the result. Passing is what lists a release as supported.
  - turn on `yaac server autostart on` for a tailnet containerless server,
    reboot without logging in, and check that a client on the tailnet
    reaches it and its workspaces are back. Do the same for the cluster.
  - on a laptop install (GNOME), check that the desktop app from the repo
    lands on a server started with `yaac server start`.

  On a Mac, a `yaac cluster install` with the formula's `kind` and
  `kubernetes-cli` uninstalled checks the same fetch.

## Later: a home-dir install

For distros without a `.deb`, the no-root route would be the one rustup, uv
and Claude Code take: a self-contained runtime under `~/.local/share/yaac`
(the CLI, Node, and static tmux, fd and ripgrep) with a link in
`~/.local/bin`, installed by `curl … | sh`. It is left out for three reasons:

- **It conflicts with a package install.** Debian's `~/.profile` puts
  `~/.local/bin` ahead of `/usr/bin`, and both copies share `~/.yaac-server`
  and `~/.yaac-client/server.json`. Two versions would then manage one
  server and migrate one database. The installer would have to refuse when a
  dpkg-installed `yaac-server` is present.
- **It does not reach a cluster.** `yaac cluster install` fetches `kind`
  and `kubectl` itself, but rootful podman, netavark, aardvark-dns and
  nftables need the distro's package manager and sudo anyway.
- **It needs its own updater**, which neither the Mac nor the apt side has.

It becomes worth building if users on other distros ask. Until then, they
use docs/install-from-source.md. An RPM and a dnf repo are the other way to
reach them, and most of `package-deb.ts`'s staging would carry over.

## Docs to update when this ships

- `linux/README.md` (new): the end-user install, the packages, the podman
  helper and what its grant means, autostart, the release flow and the key.
- docs/remote-hosting.md: "Server setup" starts from the apt install, and
  "Surviving a reboot" moves out of "Not yet covered" into a section on
  autostart.
- docs/cluster-setup.md "Linux: rootful podman": the helper as the packaged
  way to grant access, with the manual steps kept for source installs.
  "kind and Kubernetes versions" names the pinned versions and the cache
  dir, instead of a minimum version on PATH.
- docs/install-from-source.md: Debian and Ubuntu users are pointed at the
  apt repo first. The manual `kind` and `kubectl` downloads are dropped,
  since `yaac cluster install` fetches them.
- homebrew/README.md and `Formula/yaac-cluster.rb`: the formula no longer
  depends on `kind` or `kubernetes-cli`. The release flow points at
  linux/README.md for the apt step.
- packages/desktop/README.md "Packaging": the Linux `.deb` updates from the
  apt repo.
- The root README's install section.
- This plan is deleted once its material has moved into those references.

## Phases

1. **kind and kubectl fetched by the CLI.** It ships on its own and helps
   macOS too, since the formula drops two dependencies.
2. **The packages and the repo.** `yaac-server` with the `userEnvironment`
   PATH append, `yaac-cluster` with `yaac-podman-access`, the keyring, the
   install test, `publish:apt`, and linux/README.md. This
   replaces the nvm-and-source build for every Debian and Ubuntu user,
   laptop or server.
3. **Autostart.** `yaac server autostart` and the cluster's reboot path,
   once the kind restart behavior is known.
4. **Follow-ups, if wanted.** arm64 cluster support, a launchd agent for
   macOS autostart, rootless podman for `--byo`, an RPM, and the home-dir
   install above.

## Open questions

- **The repo's domain.** Any domain yaac controls will do. The keyring
  package can move the URL later, but the keyring's own download link is
  printed in the docs, so pick one before the first public release.
- **Autostart's home.** A CLI command keeps it the same on every install
  route. The alternative is a packaged `yaac-server@.service` template
  enabled per user. That is more familiar to Linux admins, but it doesn't
  help Homebrew or source installs, and it still needs the user's flags.
