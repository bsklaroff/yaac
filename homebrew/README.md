# Homebrew tap source

Source of truth for the `bsklaroff/homebrew-yaac` tap. The formulas here are
copied verbatim into that repo's `Formula/` directory — this directory exists
so formula changes are reviewed alongside the code they package.

End-user install (macOS, arm64):

```sh
brew trust bsklaroff/yaac
brew trust libkrun/krun
brew tap libkrun/krun
brew install bsklaroff/yaac/yaac
yaac cluster install
```

## Formulas

- **`yaac.rb`** — installs the published npm tarball (`@bsklaroff/yaac`; the
  unscoped `yaac` npm name was already taken) into `libexec` and symlinks
  `bin/yaac`. Depends on core `node`, `kubernetes-cli`,
  `podman` (≥ 6.0), `kind` (≥ v0.33.0 — see "kind and Kubernetes versions"
  in docs/cluster-setup.md), and — on macOS/arm64 — the tap's
  `yaac-krunkit` (which pulls `yaac-libkrun`).
  It also carries what the containerless driver needs on the host, since
  that mode has no session image to supply anything: `tmux` (the worktree
  supervisor) and `socat` (the ACP chat transport), both of which a create
  refuses without, plus `fd` and `ripgrep` for the agents' own file search.
  `git`, `curl` and `lsof` are `uses_from_macos` — provided there, installed
  on Linux.
- **`yaac-libkrun.rb`** — **temporary.** Upstream libkrun v1.19.4 plus a
  one-line backport (main's d33afa5) forcing `LinuxComplete` virtiofs
  semantics — krunkit ≤ 1.3.x always passes `Simplified` and podman's
  generated device string can't override it. `Simplified` reports the
  accessing process as every file's owner and swallows chown, which breaks
  hostPath writes from gVisor session pods: the runsc gofer stats files as
  root, so the sentry sees root-owned files and denies session-uid writes.
  `LinuxComplete` reports real host ownership (and advertises FUSE
  `ALLOW_IDMAP` — the userns-era symptom that first surfaced this,
  [yaac#27](https://github.com/bsklaroff/yaac/issues/27)). The upstream
  fix (d33afa5) is stranded behind libkrun's 2.0 C-API break, which krunkit
  1.3.x cannot load. Keg-only; consumed by `yaac-krunkit` via its opt path.
- **`yaac-krunkit.rb`** — **temporary.** Upstream krunkit v1.3.2 built
  against `yaac-libkrun`'s fully-qualified opt path, so the bare name
  `libkrun` appears nowhere — no "found in multiple taps" ambiguity and no
  `/opt/homebrew/opt/libkrun` link races with the `libkrun/krun` tap. No
  gvproxy dep (podman vendors its own). Conflicts with upstream `krunkit`
  (same `bin/krunkit` and firmware paths); migrating from an install that
  used the `libkrun/krun` tap:
  `brew uninstall --ignore-dependencies krunkit libkrun`, then
  `brew install bsklaroff/yaac/yaac-krunkit`. Quick ownership probe, no
  cluster needed (prints your real uid, e.g. `501`, under `LinuxComplete`;
  the container uid `12345` under stock `Simplified` semantics):
  `podman run --rm --user 12345 -v $HOME:/mnt:ro alpine stat -c %u /mnt`
  Delete both formulas (and return `yaac.rb` to `libkrun/krun/krunkit`)
  once krunkit ships against libkrun 2.x, where `LinuxComplete` is the
  builder default.

## Release flow

1. Bump `version` in the root `package.json` (the CLI reads it at build time),
   then publish: `pnpm publish` (the `prepublishOnly` hook rebuilds `dist/`).
   Use `pnpm publish`, not `npm publish` — pnpm rewrites the `catalog:`
   version specifiers to their pinned versions in the published manifest.
2. Compute the tarball hash:

   ```sh
   curl -fsSL https://registry.npmjs.org/@bsklaroff/yaac/-/yaac-<VERSION>.tgz | shasum -a 256
   ```

3. Mirror this directory into the `bsklaroff/homebrew-yaac` repo — deleting
   formulas removed here, so a retired one stops being installable — then
   fill in the `<VERSION>` and `sha256` placeholders in `yaac.rb` and push:

   ```sh
   rsync -a --delete homebrew/Formula/ <tap>/Formula/
   cp homebrew/tap_migrations.json <tap>/
   ```

## Migrating an existing install

Brew cannot carry these over by itself, so each is a one-time manual step:

- **`yaac-kind` → core `kind`.** The tap's retired pinned kind build
  conflicts with core `kind`: installing `kind` beside it leaves `kind`
  unlinked, so uninstalling `yaac-kind` afterwards leaves no `kind` on PATH.
  `--ignore-dependencies` is there because an installed `yaac` from before
  this change still lists `yaac-kind` as a dependency:
  `brew uninstall --ignore-dependencies yaac-kind && brew install kind && brew link kind`.
  `tap_migrations.json` redirects a stale `bsklaroff/yaac/yaac-kind` name
  to core `kind`, but it does not migrate an installed keg.
- **`virglrenderer` → `virglrenderer-krun`.** The `libkrun/krun` tap renamed
  its virglrenderer fork without a rename file, and the new formula
  conflicts with a still-installed old keg, so `yaac-libkrun`'s rebuild
  aborts until that keg is gone:
  `brew uninstall --ignore-dependencies virglrenderer && brew upgrade yaac-libkrun`.

## Creating the tap (one-time)

Create a GitHub repo named `bsklaroff/homebrew-yaac` containing a `Formula/`
directory with these files, plus `tap_migrations.json` at its root. `brew tap bsklaroff/yaac` then resolves it
automatically (`brew install bsklaroff/yaac/yaac` taps implicitly).
