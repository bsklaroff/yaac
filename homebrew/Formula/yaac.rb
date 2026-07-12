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
    # volumes require. libkrun/krunkit are arm64-only. The tap-pinned libkrun
    # (upstream v1.19.4 + a LinuxComplete-semantics backport) is temporary:
    # without it the krunkit <= 1.3.x + libkrun 1.19.x pair never advertises
    # FUSE ALLOW_IDMAP, so idmapped mounts fail with EINVAL — see
    # Formula/libkrun.rb and https://github.com/bsklaroff/yaac/issues/27.
    # Order matters (and deliberately trips brew audit's dep-order cop):
    # krunkit's own unqualified libkrun dep resolves to libkrun/krun/libkrun,
    # so a fresh install schedules BOTH libkruns into the same rack, and
    # /opt/homebrew/opt/libkrun points at whichever keg installed last.
    # Keeping the patched formula after krunkit guarantees the patched keg
    # owns the opt path.
    depends_on arch: :arm64
    depends_on "libkrun/krun/krunkit"
    depends_on "bsklaroff/yaac/libkrun"
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
