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
yaac cluster setup
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
  semantics, so the device advertises FUSE `ALLOW_IDMAP` — krunkit ≤ 1.3.x
  always passes `Simplified` and podman's generated device string can't
  override it, which breaks idmapped mounts over virtiofs
  ([yaac#27](https://github.com/bsklaroff/yaac/issues/27)). The upstream
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
  `brew install bsklaroff/yaac/yaac-krunkit`. Quick idmap probe, no cluster
  needed:
  `podman run --rm -v ~/.yaac:/mnt:idmap --uidmap 0:100000:65536 alpine true`
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

3. Copy `Formula/*.rb` into the `bsklaroff/homebrew-yaac` repo, filling in
   the `<VERSION>` and `sha256` placeholders in `yaac.rb`, and push.

## Creating the tap (one-time)

Create a GitHub repo named `bsklaroff/homebrew-yaac` containing a `Formula/`
directory with these files. `brew tap bsklaroff/yaac` then resolves it
automatically (`brew install bsklaroff/yaac/yaac` taps implicitly).
