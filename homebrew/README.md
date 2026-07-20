# Homebrew tap source

Source of truth for the `bsklaroff/homebrew-yaac` tap. The formulas and the
cask here are copied into that repo's `Formula/` and `Casks/` directories
(`yaac.rb` and the cask with their `<VERSION>`/`<SHA256>` placeholders
filled) — this directory exists so packaging changes are reviewed alongside
the code they package.

End-user install (macOS, arm64):

```sh
brew trust bsklaroff/yaac
brew trust libkrun/krun
brew tap libkrun/krun
brew install bsklaroff/yaac/yaac
yaac cluster setup
```

Desktop app (optional, after the above):

```sh
brew install --cask bsklaroff/yaac/yaac-desktop
```

## Formulas

- **`yaac.rb`** — installs the published npm tarball (`@bsklaroff/yaac`; the
  unscoped `yaac` npm name was already taken) into `libexec` and symlinks
  `bin/yaac`. Depends on core `node`, `kubernetes-cli`, `cilium-cli`,
  `podman` (≥ 6.0, already in core), the tap's `yaac-kind`, and — on
  macOS/arm64 — the tap's `yaac-krunkit` (which pulls `yaac-libkrun`).
  `helm` is not a dependency: yaac downloads a pinned helm on demand
  (vcluster sessions only).
- **`yaac-kind.rb`** — **temporary.** kind built from the pinned kind#4203
  merge commit on `main`, because podman 6.x breaks every kind release
  ≤ v0.32.0 (kind#4201) and v0.33.0 is unreleased. Delete this formula and
  switch `yaac.rb` to core `kind` once homebrew-core ships kind ≥ v0.33.0.
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

## Cask

- **`yaac-desktop.rb`** — installs the signed + notarized desktop app (an
  Electron shell around the yaac webapp, `packages/desktop`) from the DMG
  attached to the matching `vX.Y.Z` GitHub Release. arm64-only, and
  versioned in lockstep with the `yaac` formula — one release covers both.
  The token is `yaac-desktop` so it never collides with the `yaac` formula.

## Release flow

One version (the root `package.json`'s) drives the npm package, the
`vX.Y.Z` git tag and GitHub Release, the desktop app, the formula, and the
cask. Two scripts:

1. `pnpm release:prep [patch|minor|major|X.Y.Z]` (default patch; runs
   anywhere with push rights + `gh`, including a yaac session) — bumps the
   root version, commits and tags `vX.Y.Z`, pushes both, and opens a
   **draft** GitHub Release with notes from the commits since the previous
   release.
2. `pnpm release` (macOS arm64 only; needs `gh` auth, `npm login`, and the
   signing env printed by the script — `YAAC_MAC_SIGNING_IDENTITY`,
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) — checks the
   tag out in a throwaway worktree, publishes to npm with `pnpm publish`
   (pnpm, not npm: it rewrites the `catalog:` version specifiers in the
   published manifest), builds + signs + notarizes the desktop DMG, uploads
   it and publishes the release, then pushes `Formula/` + `Casks/` to the
   tap in one commit (set `YAAC_TAP_DIR` to reuse an existing checkout).
   The publish step is skipped if the version is already on npm, so a
   failed later step can just be re-run.

Manual fallback (what the scripts automate): compute
`curl -fsSL https://registry.npmjs.org/@bsklaroff/yaac/-/yaac-<VERSION>.tgz
| shasum -a 256` (formula) and `shasum -a 256 <dmg>` (cask), copy
`Formula/*.rb` and `Casks/yaac-desktop.rb` into the tap repo with the
`<VERSION>`/`<SHA256>` placeholders filled, and push.

## Creating the tap (one-time)

Create a GitHub repo named `bsklaroff/homebrew-yaac` containing `Formula/`
and `Casks/` directories with these files. `brew tap bsklaroff/yaac` then
resolves it automatically (`brew install bsklaroff/yaac/yaac` taps
implicitly).
