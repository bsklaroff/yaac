# Source of truth for the bsklaroff/homebrew-yaac tap's cask (see
# ../README.md). <VERSION>/<SHA256> are filled from the released DMG by
# `pnpm release` (scripts/release.ts). Token is yaac-desktop, not yaac,
# so the cask never collides with the tap's yaac formula.
cask "yaac-desktop" do
  version "<VERSION>"
  sha256 "<SHA256>"

  url "https://github.com/bsklaroff/yaac/releases/download/v#{version}/yaac-#{version}-arm64.dmg"
  name "yaac"
  desc "Desktop shell for the yaac agent sandbox manager"
  homepage "https://github.com/bsklaroff/yaac"

  depends_on arch: :arm64

  app "yaac.app"

  caveats <<~EOS
    The desktop app bundles its own yaac server, but sessions still need
    the local cluster; if you haven't already, install the CLI stack and
    set it up:

      brew install bsklaroff/yaac/yaac
      yaac cluster setup
  EOS
end
