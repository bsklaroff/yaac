# Ship the desktop app as a Homebrew cask

## Goal

Distribute the Electron desktop app to macOS users as a signed, notarized
`.app`, installed by a cask in the existing `bsklaroff/homebrew-yaac` tap:

```sh
brew install --cask bsklaroff/yaac/yaac-desktop
```

Homebrew uses formulas for CLI software and casks for prebuilt GUI bundles
installed into `/Applications`. The `yaac` formula (`homebrew/Formula/yaac.rb`)
installs the npm tarball, which ships only `dist/` and never the desktop app.
So brew users get the CLI and no app.

## Current state

Packaging exists but produces only a local, unsigned build
(packages/desktop/README.md, "Packaging (macOS)"):

- `pnpm desktop:package` runs `pnpm -w build`, `tsup`,
  `scripts/stage-server.ts` and `electron-builder`, producing
  `packages/desktop/dist-app/`. `pnpm desktop:install` then copies it into
  `/Applications` with `ditto`.
- `stage-server.ts` stages the real publish artifact (`pnpm pack` plus
  `npm install --omit=dev`) and a copy of the build machine's `node`
  binary. `scripts/after-pack.cjs` copies both into
  `yaac.app/Contents/Resources`. The app uses them only to run the CLI's
  auth-daemon (`yaac auth server run`). It starts no server: it connects to
  whichever server `~/.yaac-client/server.json` selects.

The gaps are all in `packages/desktop/electron-builder.yml`:

- `mac.target: [dir]` builds a bare `.app`, not a distributable artifact.
- `mac.identity: null` leaves it unsigned.
- `asar: false`, with the bundled Node and `node_modules` (including
  node-pty's native `.node` file) shipped as plain files under
  `Resources/`. This matters for notarization (below).

## Phase 1: signing and notarization

This is most of the work. A cask download gets the `com.apple.quarantine`
attribute, and Gatekeeper refuses an app that is not notarized ("damaged
and can't be opened"). Shipping an unsigned cask that strips quarantine is
what Homebrew discourages, so notarization is required, not polish.

Needed:

1. An Apple Developer ID Application certificate (paid Apple Developer
   account) and an app-specific password or API key for `notarytool`.
2. In `electron-builder.yml`: set `mac.identity`, `mac.hardenedRuntime:
   true`, `mac.entitlements` / `mac.entitlementsInherit`, and
   `mac.notarize: true` (electron-builder runs `notarytool` and staples the
   ticket).
3. Signing identity and notarization credentials come from the
   environment (CI secrets). Local builds keep `identity: null`, so
   `pnpm desktop:install` still works without a certificate.

Every Mach-O binary in the bundle must be signed under the hardened
runtime, or notarization rejects the submission. That includes the copied
`node` binary and node-pty's `.node` file, which `after-pack.cjs` adds as
plain files. Two things to check:

- Signing must happen after `after-pack.cjs` copies those files in, and
  must cover them. Confirm the hook runs before electron-builder's sign
  step; if not, sign them explicitly in the hook or in an `afterSign`
  step.
- The copied `node` carries whatever signature it came with. Prefer
  re-signing it under our identity. Only if that fails, fall back to the
  `com.apple.security.cs.disable-library-validation` (or
  `allow-unsigned-executable-memory`) entitlement.

Exit check: a notarized, stapled `.app` downloaded with quarantine set (a
real browser download, or `xattr -w com.apple.quarantine …`) opens with no
Gatekeeper prompt, starts the auth-daemon, and drives a workspace end to
end against a registered server.

## Phase 2: a `.dmg` on a GitHub Release

- Add `dmg` to `mac.target` (add `zip` only if we pick self-updating
  below).
- Upload the `.dmg` as an asset on the `v<version>` GitHub Release. The
  cask's `url` uses `version` and is pinned by `sha256`, the same way
  `yaac.rb` pins the npm tarball.

## Phase 3: the cask

Add `homebrew/Casks/yaac-desktop.rb` next to `homebrew/Formula/`, so it is
reviewed with the code it packages, and mirror it into the tap's `Casks/`
directory on release:

```ruby
cask "yaac-desktop" do
  version "0.x.y"
  sha256 "<dmg sha256>"

  url "https://github.com/bsklaroff/yaac/releases/download/" \
      "v#{version}/yaac-#{version}-arm64.dmg"
  name "yaac"
  desc "Desktop shell for the yaac agent sandbox manager"
  homepage "https://github.com/bsklaroff/yaac"

  depends_on arch: :arm64
  depends_on formula: "bsklaroff/yaac/yaac"   # CLI + toolchain

  app "yaac.app"                              # productName in the yml

  zap trash: [
    "~/Library/Application Support/yaac",
    # NOT ~/.yaac or ~/.yaac-client: server data and server registration
  ]
end
```

Decisions:

- **Depend on the `yaac` formula (recommended).** The app starts no server.
  A user needs `yaac server start` or `yaac cluster install` first, and
  both come from the formula along with their dependencies (podman, kind,
  krunkit, tmux, socat). Re-declaring those in the cask would duplicate
  `yaac.rb`.
- **Who handles upgrades (open; recommend brew).**
  - Brew-managed: a `livecheck` block and no `auto_updates`, so
    `brew upgrade --cask` updates it. The app loads its UI from the server,
    so it cannot drift out of sync with it, and background self-updates
    buy little.
  - Self-updating: `electron-updater` against a `latest-mac.yml` feed
    (needs the `zip` target) plus `auto_updates true`. More infrastructure
    for a thin shell; defer unless background updates are wanted.

Verify `brew install --cask bsklaroff/yaac/yaac-desktop` on a clean
machine.

## Release flow

Add a desktop track to the release flow in `homebrew/README.md`:

1. Bump `version` in the root `package.json` (the single version source).
2. Run `pnpm desktop:package` with signing and notarization credentials in
   the environment.
3. Upload the `.dmg` to the `v<version>` GitHub Release.
4. `shasum -a 256` the `.dmg` and fill `version` and `sha256` into
   `homebrew/Casks/yaac-desktop.rb`.
5. Mirror `homebrew/Casks/` into the tap alongside `Formula/` and push.

## Phase 4 (optional): automation

Once the manual flow works, a CI job on a version tag can run steps 2-5:
electron-builder can publish the Release (`--publish`), and existing
actions can regenerate cask stanzas.

## Out of scope

- **Intel Macs.** The macOS stack is arm64-only (`yaac.rb` already
  declares `depends_on arch: :arm64`).
- **Linux and Windows packages** (AppImage, deb, MSI). Brew delivery is
  macOS-only.
- **homebrew-core.** The cask depends on the tap's `yaac` formula, which
  depends on the tap's `yaac-krunkit`. Core cannot depend on taps.

## Sources

- Homebrew Cask Cookbook: https://docs.brew.sh/Cask-Cookbook
- Homebrew acceptable casks: https://docs.brew.sh/Acceptable-Casks
- electron-builder code signing: https://www.electron.build/code-signing
- electron-builder mac config: https://www.electron.build/configuration/mac
- Apple notarization:
  https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- Hardened runtime:
  https://developer.apple.com/documentation/security/hardened-runtime
