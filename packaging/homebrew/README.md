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

The original plan also called for a tap-pinned `yaac-podman`; that is
obsolete — homebrew-core's podman reached 6.0.0 (checked 2026-07-02), which
includes the krunkit `--timesync` passthrough (podman#28527) and the 6.0
machine image's vsock guest-agent wiring (podman-machine-os#238).

## Release flow

1. Bump `version` in `package.json` (and `YAAC_VERSION` in `src/cli.ts`),
   then publish: `pnpm publish` (the `prepublishOnly` hook rebuilds `dist/`).
2. Compute the tarball hash:

   ```sh
   curl -fsSL https://registry.npmjs.org/@bsklaroff/yaac/-/yaac-<version>.tgz | shasum -a 256
   ```

3. Update `url` + `sha256` in `Formula/yaac.rb`.
4. Copy `Formula/*.rb` into the `bsklaroff/homebrew-yaac` repo and push.

## Creating the tap (one-time)

Create a GitHub repo named `bsklaroff/homebrew-yaac` containing a `Formula/`
directory with these files. `brew tap bsklaroff/yaac` then resolves it
automatically (`brew install bsklaroff/yaac/yaac` taps implicitly).
