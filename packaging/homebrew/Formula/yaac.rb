# Source of truth for the bsklaroff/homebrew-yaac tap (see ../README.md for
# the release/sync flow). Lives in a tap rather than homebrew-core because the
# macOS path depends on krunkit from the libkrun/krun tap, and core formulas
# cannot depend on tap formulas.
class Yaac < Formula
  desc "Agent sandbox manager - parallel agent sessions on a local Kubernetes cluster"
  homepage "https://github.com/bsklaroff/yaac"
  url "https://registry.npmjs.org/@bsklaroff/yaac/-/yaac-<VERSION>.tgz"
  # Recompute on every release: curl -fsSL <url> | shasum -a 256
  sha256 "REPLACE_WITH_TARBALL_SHA256_AFTER_NPM_PUBLISH"
  license "MIT"

  depends_on "cilium-cli"
  depends_on "kubernetes-cli"
  depends_on "node"
  # Core podman is >= 6.0 (needed for krunkit --timesync passthrough on
  # macOS); podman 6.x in turn requires a kind with kind#4203, which no
  # kind release has yet - hence the tap-pinned yaac-kind. Switch to core
  # "kind" and delete yaac-kind once core ships kind >= v0.33.0.
  depends_on "podman"
  depends_on "bsklaroff/yaac/yaac-kind"

  on_macos do
    # libkrun is the only macOS virtualization stack whose virtiofs supports
    # idmapped mounts, which user-namespaced session pods writing hostPath
    # volumes require. libkrun/krunkit are arm64-only.
    depends_on arch: :arm64
    depends_on "libkrun/krun/krunkit"
  end

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Create the local cluster yaac runs sessions on (podman machine on
      macOS, local registry, kind cluster, Cilium, node fixups):

        yaac cluster setup

      The node fixups it applies do not survive a node or VM restart;
      re-apply them without recreating the cluster:

        yaac cluster setup --repair

      Verify everything with:

        yaac cluster check

      If installing krunkit failed on a tap-trust error, run
      `brew trust libkrun/krun` and retry.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/yaac --version")
  end
end
