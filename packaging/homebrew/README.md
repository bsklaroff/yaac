# Homebrew tap source

Source of truth for the `bsklaroff/homebrew-yaac` tap. The formulas here are
copied verbatim into that repo's `Formula/` directory — this directory exists
so formula changes are reviewed alongside the code they package.

End-user install (macOS, arm64):

```sh
brew trust bsklaroff/yaac
brew trust libkrun/krun
brew install bsklaroff/yaac/yaac
yaac cluster setup
```

## Formulas

- **`yaac.rb`** — installs the published npm tarball (`@bsklaroff/yaac`; the
  unscoped `yaac` npm name was already taken) into `libexec` and symlinks
  `bin/yaac`. Depends on core `node`, `kubernetes-cli`, `cilium-cli`,
  `podman` (≥ 6.0, already in core), the tap's `yaac-kind`, and — on
  macOS/arm64 — `krunkit` from the `libkrun/krun` tap. `helm` is not a
  dependency: yaac downloads a pinned helm on demand (vcluster sessions
  only).
- **`yaac-kind.rb`** — **temporary.** kind built from the pinned kind#4203
  merge commit on `main`, because podman 6.x breaks every kind release
  ≤ v0.32.0 (kind#4201) and v0.33.0 is unreleased. Delete this formula and
  switch `yaac.rb` to core `kind` once homebrew-core ships kind ≥ v0.33.0.
- **`libkrun.rb`** — **temporary.** Upstream libkrun v1.19.4 plus a one-line
  backport (main's d33afa5) forcing `LinuxComplete` virtiofs semantics, so
  the device advertises FUSE `ALLOW_IDMAP` — krunkit ≤ 1.3.x always passes
  `Simplified` and podman's generated device string can't override it, which
  breaks idmapped mounts over virtiofs
  ([yaac#27](https://github.com/bsklaroff/yaac/issues/27)). Deliberately
  shadows `libkrun/krun/libkrun` so krunkit's `/opt/homebrew/opt/libkrun`
  load path resolves to the patched keg; if the upstream one is installed,
  `brew uninstall --ignore-dependencies libkrun` first. Delete this formula
  (and its `yaac.rb` dep) once krunkit ships against libkrun 2.x, where
  `LinuxComplete` is the builder default.

  **Known hazard:** any brew operation that (re)installs krunkit or the
  upstream libkrun (e.g. a krunkit version bump in `brew upgrade`) can pull
  in `libkrun/krun/libkrun` and repoint `/opt/homebrew/opt/libkrun` at the
  unpatched keg. Symptom: session pods fail with `MOUNT_ATTR_IDMAP ...
  invalid argument` after the next podman-machine restart. Fix:
  `brew reinstall bsklaroff/yaac/libkrun` (reclaims the opt link), then
  restart the machine. Quick probe, no cluster needed:
  `podman run --rm -v ~/.yaac:/mnt:idmap --uidmap 0:100000:65536 alpine true`

The original plan also called for a tap-pinned `yaac-podman`; that is
obsolete — homebrew-core's podman reached 6.0.0 (checked 2026-07-02), which
includes the krunkit `--timesync` passthrough (podman#28527) and the 6.0
machine image's vsock guest-agent wiring (podman-machine-os#238).

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
