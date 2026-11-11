# Homebrew tap source

Source for the `bsklaroff/homebrew-yaac` tap. `Formula/` and `Casks/` are
copied verbatim into the tap's directories of the same names; they live here
so packaging changes are reviewed with the code they package.

End-user install (macOS, arm64):

```sh
brew install --cask bsklaroff/yaac/yaac-desktop   # the app alone

# The CLI, for a containerless server:
brew install bsklaroff/yaac/yaac-server
yaac server start && yaac host check

# The CLI and a local Kubernetes cluster's tools:
brew install bsklaroff/yaac/yaac-server bsklaroff/yaac/yaac-cluster
yaac cluster install
```

None of these needs `brew trust bsklaroff/yaac`. Since Homebrew 6, an
`install` that names an item fully qualified trusts that item for good
(recorded in Homebrew's `trust.json`, so `brew upgrade` keeps moving it),
but a tap formula it depends on must already be trusted. So the cask depends
on no formula here, and `yaac-cluster`, which depends on `yaac-server`, is
installed with `yaac-server` named too, unless an earlier install named it.
The app's own setups (packages/desktop/README.md, "Setup") run these same
commands.

The app works fully as a client of a remote server without the CLI, and
sets up a server on this Mac through Homebrew when asked. The `.dmg` on the
GitHub Release can also be dragged into `/Applications` without brew: the
app in it is notarized, so it opens, but nothing updates it. Mixing it with
the cask leaves brew's record stale: `brew install --cask` refuses over a
hand-installed app until given `--force`, and a hand install over the cask is
replaced by the next newer tap version or removed by `brew uninstall --cask`.

## Packages

- **`Casks/yaac-desktop.rb`** installs the signed, notarized `yaac.app` from
  the `.dmg` on the `v<version>` GitHub Release. The app runs the
  `yaac-server` formula's CLI for any server on this Mac, so the server code
  has one copy, but the cask does not depend on it (see above). It has no
  `auto_updates` and the app has no updater: `brew upgrade` moves it, and
  the formulas with it. Its `zap` trashes only the app's own support dir and
  preferences, never a server's data dir.

- **`Formula/yaac-server.rb`** installs the published npm tarball (`@bsklaroff/yaac`;
  the unscoped `yaac` name was taken) into `libexec` and links `bin/yaac`.
  Its dependencies come from `npm ci` against the tarball's
  `dist/npm-shrinkwrap.json`, which `pnpm build` writes from `pnpm-lock.yaml`,
  so a brew install gets the versions and integrity hashes the repo locked
  under its release-age gate, never a fresh resolution.
  - Depends on core `node`, plus what the containerless driver needs on the
    host, which has no session image: `tmux` (runs each workspace) and
    `socat` (the ACP chat transport), which a create refuses to run without,
    plus `fd` and `ripgrep` for the agents' file search.
  - `git`, `curl` and `lsof` are `uses_from_macos`: provided by macOS,
    installed on Linux.
- **`Formula/yaac-cluster.rb`** installs nothing of its own. It depends on
  `yaac-server` plus what `yaac cluster install` runs: `kubernetes-cli`,
  `podman` (6.0 or newer), `kind` (v0.33.0 or newer; see "kind and
  Kubernetes versions" in docs/cluster-setup.md), and `krunkit` on
  macOS/arm64, which runs the podman machine (see "macOS: the podman
  machine" there). It fetches the same tarball as
  `yaac-server` only so the two share a version, and `brew upgrade` carries
  a change to its dependencies with each release.

A Mac that got `yaac-server` from an older `yaac-desktop`, which depended on
it, has it recorded as a dependency only. Once the tap carries a cask without
that dependency, Homebrew's autoremove (run by `brew uninstall`, a bare
`brew cleanup`, and the periodic cleanup after an upgrade) deletes it unless
`yaac-cluster` is installed. Keep it by marking it requested:

```sh
brew tab --installed-on-request yaac-server
```

A Mac may still have the tap's retired `yaac-krunkit` and `yaac-libkrun`
installed, with their dependencies from the `libkrun/krun` tap.
`yaac cluster install` works with that `krunkit` too. To move onto
Homebrew's own:

```sh
podman machine stop
brew uninstall --ignore-dependencies yaac-krunkit yaac-libkrun virglrenderer-krun libkrun/krun/libkrunfw
brew install krunkit
brew untap libkrun/krun
yaac cluster install
```

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
4. Upload the `.dmg` to a `v<VERSION>` GitHub Release, with notes saying
   anything an existing install must do by hand:

   ```sh
   gh release create v<VERSION> packages/desktop/dist-app/yaac-<VERSION>-arm64.dmg \
     --notes "<notes>"
   ```

   The first release whose cask has no `yaac-server` dependency must tell
   cask users to run `brew tab --installed-on-request yaac-server` (see
   above), since nothing else reaches them before autoremove does.

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
