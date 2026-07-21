# Ship the desktop app as a Homebrew cask

## Goal

Deliver the Electron desktop shell to macOS users the way Homebrew
distributes GUI apps — a signed, notarized `.app` in a versioned artifact,
tracked by a **cask** in the existing `bsklaroff/homebrew-yaac` tap:

```sh
brew install --cask bsklaroff/yaac/yaac-desktop
```

Today there is no brew path to the desktop app at all. The npm tarball ships
only `dist` (root `package.json` `files: ["dist"]`), `pnpm build` never
bundles the Electron shell (CLAUDE.md), and therefore the `yaac` **formula**
(`homebrew/Formula/yaac.rb`, which just `npm install`s that tarball and
symlinks `bin/yaac`) delivers the CLI and nothing else. The only way to get
the app is `pnpm desktop:install`, which produces an unsigned, local-only
`.app`.

## Why a cask, not the formula

Homebrew's own dividing line: **formulas** are CLI / build-from-source
software (what `yaac.rb` is), **casks** are pre-built GUI macOS bundles
installed into `/Applications`. The desktop app is squarely the latter, and
it already builds through `electron-builder`, so the packaging engine is in
place — this plan is about promoting that output to a distributable artifact
and pointing a cask at it.

The cask lives alongside the formulas so it is reviewed with the code it
packages, mirroring the existing arrangement: add `homebrew/Casks/
yaac-desktop.rb` next to `homebrew/Formula/*.rb`, copied verbatim into the
tap repo's `Casks/` dir on release (see `homebrew/README.md` for the sync
model).

## Current state

The `electron-builder` pipeline exists and is wired end to end:

- `pnpm desktop:package` → `@yaac/desktop app:build` → `pnpm -w build && tsup
  && tsx scripts/stage-server.ts && electron-builder --config
  electron-builder.yml`.
- `pnpm desktop:install` → `app:install` → `app:build` then `tsx
  scripts/install-app.ts` (drops the `.app` into `/Applications` locally).
- `apps/desktop/scripts/`: `stage-server.ts` (stages the server bundle +
  prod `node_modules` + standalone Node), `after-pack.cjs` (fs-copies those
  into the app — `extraResources` strips `node_modules`), `install-app.ts`.

The gap is entirely in `apps/desktop/electron-builder.yml`:

- `mac.target: [dir]` — produces a bare `.app`, not a distributable artifact.
- `mac.identity: null` — **unsigned**. The file's own comment calls signing +
  notarization + `.dmg` the intended fast-follow.
- `asar: false` + unpacked standalone Node + `node_modules` (incl. node-pty's
  native `.node`) shipped as real files under `Resources/` — this shape
  matters for notarization (see below).

## The blocker: signing + notarization

This is the bulk of the work; the cask file itself is trivial by comparison.
A cask download gets the `com.apple.quarantine` attribute, and Gatekeeper
refuses an un-notarized bundle ("damaged and can't be opened"). Shipping an
unsigned cask that strips quarantine is exactly what Homebrew discourages and
users should distrust — so this is non-negotiable, not optional polish.

Required:

1. **Apple Developer ID Application** certificate (needs a paid Apple
   Developer account) + an app-specific password / API key for `notarytool`.
2. In `electron-builder.yml`: set `mac.identity` to the Developer ID, add
   `mac.hardenedRuntime: true`, `mac.entitlements` /
   `mac.entitlementsInherit`, and `mac.notarize: true` (electron-builder
   drives `notarytool` + staples the ticket).
3. Feed the signing identity + notarization creds through env (CI secrets);
   local dev keeps `identity: null` so `pnpm desktop:install` stays a
   no-cert double-clickable build.

**Gotcha specific to this app's layout.** Because `asar: false` and the
server, its prod `node_modules`, and a **standalone Node** are copied in as
plain unpacked files (`after-pack.cjs`), every Mach-O in the bundle must be
signed under the hardened runtime — the standalone `node` binary and
node-pty's `.node` included — or notarization rejects the submission. Two
consequences to design for:

- Signing must run **after** `after-pack.cjs` has copied those files in, and
  must sign recursively (deep). Verify `after-pack` ordering vs
  electron-builder's sign step; the copied Node may need an explicit sign
  pass in the hook or an `afterSign` step.
- A separately-downloaded standalone Node ships its own team signature; if
  re-signing it under our identity fights its existing signature, the
  fallback is `com.apple.security.cs.disable-library-validation` (or
  `allow-unsigned-executable-memory`) in the entitlements. Prefer re-signing
  cleanly; reach for the entitlement escape hatch only if that fails.

Exit check for this phase: a notarized, stapled `.app` from a clean download
(with quarantine set — e.g. `xattr -w com.apple.quarantine …` or a real
browser download) launches without any Gatekeeper prompt, and its bundled
server starts a session end to end.

## Artifact: a `.dmg` on a GitHub Release

- Add `dmg` to `mac.target` (keep or drop `dir`; add `zip` only if we choose
  the self-update model below). Output stays under `dist-app/`.
- Publish the `.dmg` as a **GitHub Release asset** on the version tag —
  standard for tap casks and parallel to how `yaac.rb` pins the npm tarball.
  The cask's `url` templates on `version`, pinned by `sha256`.

## The cask

`homebrew/Casks/yaac-desktop.rb`:

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
  depends_on formula: "bsklaroff/yaac/yaac"   # CLI + cluster toolchain

  app "yaac.app"                              # productName in the yml

  zap trash: [
    "~/Library/Application Support/yaac",
    # deliberately NOT ~/.yaac — it holds cluster/session state
  ]
end
```

Two decisions to lock before writing it:

- **Toolchain dependency.** The packaged app bundles its own server + Node,
  so it is self-contained *as a process* — but it still cannot run a session
  without the cluster stack (podman, kind, cilium, krunkit) that lives in the
  `yaac` formula. `depends_on formula: "bsklaroff/yaac/yaac"` pulls the whole
  stack and gives a desktop-first user `yaac cluster setup`, keeping one
  source of truth for the toolchain. **Recommended.** (Alternative:
  re-declare the toolchain deps in the cask — rejected, duplicates
  `yaac.rb`.)
- **Who owns upgrades** (open — recommend the first):
  - *Brew-managed*: add a `livecheck` block, no `auto_updates`. `brew upgrade
    --cask` bumps it; the release flow stays identical in shape to the
    formula's. Fewest moving parts, and it fits "the SPA comes from the
    server it talks to" — version skew is already impossible, so silent
    background self-updates buy little. **Recommended.**
  - *Self-updating*: ship `electron-updater` against a `latest-mac.yml` feed
    (needs the `zip` target) and set `auto_updates true` so Homebrew stops
    managing versions (the Slack/VS Code cask pattern). More infra for a thin
    shell — defer unless we want background updates.

## Release flow

Extend `homebrew/README.md`'s existing formula flow with a desktop track:

1. Bump `version` in root `package.json` (already the single version source).
2. `pnpm desktop:package` with signing + notarization creds in the
   environment → notarized `.dmg` in `dist-app/`.
3. Create/attach to the `v<version>` GitHub Release; upload the `.dmg`.
4. `shasum -a 256` the `.dmg`; fill `version` + `sha256` into
   `homebrew/Casks/yaac-desktop.rb`.
5. Copy `Casks/*.rb` (alongside `Formula/*.rb`) into the tap repo; push.

`electron-builder` can auto-publish the Release (`--publish`) and there are
actions that regenerate cask stanzas — worth automating once the manual flow
is proven, so a tag push does steps 2–5.

## Phases

1. **Signing + notarization** (the hard part). Developer ID cert;
   `electron-builder.yml` mac signing/notarize/hardened-runtime; solve the
   unpacked-Node / node-pty signing ordering. Exit: notarized `.app` opens
   clean from a quarantined download and runs a session.
2. **Distributable artifact.** `dmg` target; publish to a GitHub Release with
   a versioned URL.
3. **The cask.** Add `homebrew/Casks/yaac-desktop.rb`, land the toolchain-dep
   and upgrade-ownership decisions, extend `homebrew/README.md`. Verify
   `brew install --cask bsklaroff/yaac/yaac-desktop` on a clean machine.
4. **Automation (optional).** `livecheck` for `brew outdated --cask`; CI
   release job so a version tag signs, notarizes, publishes, and opens the
   tap PR.

## Deliberately out of scope

- **Intel macs.** The whole macOS stack is arm64-only (`yaac.rb` already
  `depends_on arch: :arm64`); the cask matches.
- **Linux / Windows desktop distribution** (AppImage/deb/MSI) — a separate
  track; brew delivery is macOS-only anyway.
- **The self-update / `electron-updater` model**, unless phase 3 picks it.
- **homebrew-core cask submission.** The cask depends on the tap's own `yaac`
  formula (which itself depends on tap formulas `yaac-kind`/`yaac-krunkit`),
  and core can't depend on taps — same reason `yaac.rb` lives in the tap.

## Sources

- Homebrew Cask cookbook (stanzas, `app`, `zap`, `livecheck`, `depends_on`):
  https://docs.brew.sh/Cask-Cookbook
- Homebrew acceptable casks / quarantine policy:
  https://docs.brew.sh/Acceptable-Casks
- electron-builder macOS code signing:
  https://www.electron.build/code-signing
- electron-builder notarization (`notarize`, notarytool):
  https://www.electron.build/configuration/mac
- Apple notarization + stapling (`notarytool`, `stapler`):
  https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- Hardened runtime entitlements:
  https://developer.apple.com/documentation/security/hardened-runtime
