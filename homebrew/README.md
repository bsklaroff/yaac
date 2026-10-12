# Homebrew tap source

Source for the `bsklaroff/homebrew-yaac` tap. `Formula/` and `Casks/` are
copied verbatim into the tap's directories of the same names; they live here
so packaging changes are reviewed with the code they package.

End-user install (macOS, arm64):

```sh
brew trust bsklaroff/yaac
brew install --cask bsklaroff/yaac/yaac-desktop   # the app + yaac-server

# Or the CLI alone:
brew install bsklaroff/yaac/yaac-server
yaac server start && yaac host check   # containerless

# For a local Kubernetes cluster:
brew trust libkrun/krun
brew tap libkrun/krun
brew install bsklaroff/yaac/yaac-cluster
yaac cluster install
```

The cask depends on the tap's `yaac-server`, so the tap itself must be
trusted: Homebrew 6 trusts only the named item when installing a fully
qualified name, not the tap formulas it depends on.

The `.dmg` on the GitHub Release can also be dragged into `/Applications`
without brew. The app in it is notarized, so it opens, and it works fully as a client of
a remote server, setting up a server on this Mac through Homebrew when asked.
It gets no CLI until then, and nothing updates it. Mixing it with the cask
leaves brew's record stale: `brew install --cask` refuses over a hand-installed
app until given `--force`, and a hand install over the cask is replaced by the
next newer tap version or removed by `brew uninstall --cask`.

## Packages

- **`Casks/yaac-desktop.rb`** installs the signed, notarized `yaac.app` from
  the `.dmg` on the `v<version>` GitHub Release. It depends on `yaac-server`,
  whose CLI the app runs for any server on this Mac, so the server code has
  one copy. It has no `auto_updates` and the app has no updater:
  `brew upgrade` moves the app and the formula together. Its `zap` trashes
  only the app's own support dir and preferences, never a server's data dir.

- **`Formula/yaac-server.rb`** installs the published npm tarball (`@bsklaroff/yaac`;
  the unscoped `yaac` name was taken) into `libexec` and links `bin/yaac`.
  - Depends on core `node`, plus what the containerless driver needs on the
    host, which has no session image: `tmux` (runs each workspace) and
    `socat` (the ACP chat transport), which a create refuses to run without,
    plus `fd` and `ripgrep` for the agents' file search.
  - `git`, `curl` and `lsof` are `uses_from_macos`: provided by macOS,
    installed on Linux.
  - It has no tap dependencies, so it installs without the `libkrun/krun`
    tap.
- **`Formula/yaac-cluster.rb`** installs nothing of its own. It depends on
  `yaac-server` plus what `yaac cluster install` runs: `kubernetes-cli`,
  `podman` (6.0 or newer), `kind` (v0.33.0 or newer; see "kind and
  Kubernetes versions" in docs/cluster-setup.md), and the tap's
  `yaac-krunkit` on macOS/arm64. It fetches the same tarball as
  `yaac-server` only so the two share a version, and `brew upgrade` carries
  a change to its dependencies with each release.
- **`Formula/yaac-libkrun.rb`** (temporary) is upstream libkrun v1.19.4 plus a
  one-line backport (upstream d33afa5) that forces `LinuxComplete` virtiofs
  semantics. krunkit 1.3.x always asks for `Simplified`, and podman cannot
  override it. `Simplified` reports the accessing process as every file's
  owner and ignores chown. That breaks hostPath writes from gVisor workspace
  pods: the runsc gofer sees files as root-owned and denies the workspace
  uid. `LinuxComplete` reports real host ownership (see
  [yaac#27](https://github.com/bsklaroff/yaac/issues/27)). The upstream fix
  needs libkrun 2.0, whose C API krunkit 1.3.x cannot load. Keg-only;
  `yaac-krunkit` uses it through its opt path.
- **`Formula/yaac-krunkit.rb`** (temporary) is upstream krunkit v1.3.2 built against
  `yaac-libkrun`'s full opt path, so the bare name `libkrun` appears nowhere.
  That avoids "found in multiple taps" errors and link races with the
  `libkrun/krun` tap. It conflicts with upstream `krunkit` (same `bin/krunkit`
  and firmware paths). To switch from an install that used the `libkrun/krun`
  tap's krunkit: `brew uninstall --ignore-dependencies krunkit libkrun`, then
  `brew install bsklaroff/yaac/yaac-krunkit`.

  To check ownership without a cluster, run
  `podman run --rm --user 12345 -v $HOME:/mnt:ro alpine stat -c %u /mnt`. It
  prints your real uid (e.g. `501`) with the patched pair and `12345` with
  stock krunkit.

Delete both temporary formulas, and point `yaac-cluster.rb` back at
`libkrun/krun/krunkit`, once krunkit ships against libkrun 2.x, where
`LinuxComplete` is the default.

## Release flow

1. Bump `version` in the root `package.json` (the CLI reads it at build time)
   and run `pnpm publish` (`prepublishOnly` rebuilds `dist/`). Use pnpm, not
   npm: pnpm rewrites the `catalog:` version specifiers to real versions in
   the published manifest.
2. Compute the tarball hash:

   ```sh
   curl -fsSL https://registry.npmjs.org/@bsklaroff/yaac/-/yaac-<VERSION>.tgz | shasum -a 256
   ```

3. Build the app with the signing identity and notarization credentials in
   the environment (see packages/desktop/README.md, "Packaging"). The
   credentials live in a notarytool keychain profile, stored once with
   `xcrun notarytool store-credentials yaac-notary --apple-id <email>
   --team-id <TEAMID>` (it prompts for an app-specific password):

   ```sh
   CSC_NAME="<Name> (<TEAMID>)" APPLE_KEYCHAIN_PROFILE=yaac-notary \
     pnpm desktop:release
   ```

   It prints the `.dmg` path and its `sha256`.
4. Upload the `.dmg` to a `v<VERSION>` GitHub Release:

   ```sh
   gh release create v<VERSION> packages/desktop/dist-app/yaac-<VERSION>-arm64.dmg
   ```

5. Mirror this directory into the `bsklaroff/homebrew-yaac` repo (deleting
   packages removed here, so retired ones stop being installable), fill in
   `<VERSION>` and the tarball's `sha256` in `yaac-server.rb` and
   `yaac-cluster.rb` and the `.dmg`'s in `yaac-desktop.rb`, and push:

   ```sh
   rsync -a --delete homebrew/Formula/ <tap>/Formula/
   rsync -a --delete homebrew/Casks/ <tap>/Casks/
   ```

## Creating the tap (one-time)

Create a GitHub repo named `bsklaroff/homebrew-yaac` with `Formula/` and
`Casks/` directories holding these files.
`brew install bsklaroff/yaac/yaac-server` then taps it implicitly.
