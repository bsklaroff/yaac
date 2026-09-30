# Homebrew tap source

Source for the `bsklaroff/homebrew-yaac` tap. The formulas here are copied
verbatim into that repo's `Formula/` directory; they live here so formula
changes are reviewed with the code they package.

End-user install (macOS, arm64):

```sh
brew trust bsklaroff/yaac
brew trust libkrun/krun
brew tap libkrun/krun
brew install bsklaroff/yaac/yaac
yaac cluster install
```

## Formulas

- **`yaac.rb`** installs the published npm tarball (`@bsklaroff/yaac`; the
  unscoped `yaac` name was taken) into `libexec` and links `bin/yaac`.
  - Depends on core `node`, `kubernetes-cli`, `podman` (6.0 or newer) and
    `kind` (v0.33.0 or newer; see "kind and Kubernetes versions" in
    docs/cluster-setup.md), plus the tap's `yaac-krunkit` on macOS/arm64.
  - Also depends on what the containerless driver needs on the host, which
    has no session image: `tmux` (runs each workspace) and `socat` (the ACP
    chat transport), which a create refuses to run without, plus `fd` and
    `ripgrep` for the agents' file search.
  - `git`, `curl` and `lsof` are `uses_from_macos`: provided by macOS,
    installed on Linux.
- **`yaac-libkrun.rb`** (temporary) is upstream libkrun v1.19.4 plus a
  one-line backport (upstream d33afa5) that forces `LinuxComplete` virtiofs
  semantics. krunkit 1.3.x always asks for `Simplified`, and podman cannot
  override it. `Simplified` reports the accessing process as every file's
  owner and ignores chown. That breaks hostPath writes from gVisor workspace
  pods: the runsc gofer sees files as root-owned and denies the workspace
  uid. `LinuxComplete` reports real host ownership (see
  [yaac#27](https://github.com/bsklaroff/yaac/issues/27)). The upstream fix
  needs libkrun 2.0, whose C API krunkit 1.3.x cannot load. Keg-only;
  `yaac-krunkit` uses it through its opt path.
- **`yaac-krunkit.rb`** (temporary) is upstream krunkit v1.3.2 built against
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

Delete both temporary formulas, and point `yaac.rb` back at
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

3. Mirror this directory into the `bsklaroff/homebrew-yaac` repo (deleting
   formulas removed here, so retired ones stop being installable), fill in
   `<VERSION>` and `sha256` in `yaac.rb`, and push:

   ```sh
   rsync -a --delete homebrew/Formula/ <tap>/Formula/
   cp homebrew/tap_migrations.json <tap>/
   ```

## Migrating an existing install

Brew cannot carry these over by itself, so each is a one-time manual step:

- **`yaac-kind` → core `kind`.** The tap's retired kind build conflicts with
  core `kind`. Installing `kind` beside it leaves `kind` unlinked, so
  uninstalling `yaac-kind` afterwards would leave no `kind` on PATH.
  `--ignore-dependencies` is needed because an older installed `yaac` still
  lists `yaac-kind` as a dependency:
  `brew uninstall --ignore-dependencies yaac-kind && brew install kind && brew link kind`.
  `tap_migrations.json` redirects the old `bsklaroff/yaac/yaac-kind` name to
  core `kind`, but does not migrate an installed keg.
- **`virglrenderer` → `virglrenderer-krun`.** The `libkrun/krun` tap renamed
  its virglrenderer fork without a rename file. The new formula conflicts with
  an installed old keg, so rebuilding `yaac-libkrun` fails until it is gone:
  `brew uninstall --ignore-dependencies virglrenderer && brew upgrade yaac-libkrun`.

## Creating the tap (one-time)

Create a GitHub repo named `bsklaroff/homebrew-yaac` with a `Formula/`
directory holding these files and `tap_migrations.json` at its root.
`brew install bsklaroff/yaac/yaac` then taps it implicitly.
