# What `yaac cluster install` needs to run a local Kubernetes cluster, on
# top of yaac-server. It installs no files of its own. A `--byo` install
# onto someone else's cluster needs only podman and kubectl, but is rare
# enough to share this formula.
class YaacCluster < Formula
  desc "Local Kubernetes cluster tools for the yaac agent sandbox manager"
  homepage "https://github.com/bsklaroff/yaac"
  url "https://registry.npmjs.org/@bsklaroff/yaac/-/yaac-<VERSION>.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256_AFTER_NPM_PUBLISH"
  license "MIT"

  depends_on "bsklaroff/yaac/yaac-server"
  # Core podman is >= 6.0 (needed for krunkit --timesync passthrough on
  # macOS). kind must be >= v0.33.0: podman 6.x breaks older releases
  # (kind#4201), and k8s/kind-config.yaml pins a node image built for it.
  depends_on "kind"
  depends_on "kubernetes-cli"
  depends_on "podman"

  on_macos do
    # The podman machine runs on the tap's patched krunkit, the only macOS
    # VM stack whose virtiofs reports real file ownership to gVisor session
    # pods (see Formula/yaac-krunkit.rb and "macOS: the podman machine" in
    # docs/cluster-setup.md). krunkit/libkrun are arm64-only.
    depends_on arch: :arm64
    depends_on "bsklaroff/yaac/yaac-krunkit"
  end

  def install
    # brew refuses an empty keg, and top-level metafiles like a README do
    # not count, so the marker goes under share/.
    (pkgshare/"README").write "Dependencies for `yaac cluster install`.\n"
  end

  def caveats
    <<~EOS
      Converge the local cluster yaac runs sessions on (podman machine on
      macOS, kind cluster, Calico, node fixups, local registry, and every
      image yaac ships):

        yaac cluster install

      Safe to re-run at any time, and it is what an upgrade runs: it never
      recreates a cluster that already exists, and re-applies the node
      fixups that do not survive a node or VM restart.

      Verify everything with:

        yaac cluster check

      An install of the old `yaac` formula upgrades to this one, which keeps
      every tool it had. If you run only the containerless driver
      (`yaac server start`), keep the CLI and drop the cluster tools with:

        brew install bsklaroff/yaac/yaac-server
        brew uninstall bsklaroff/yaac/yaac-cluster
    EOS
  end

  test do
    system "kind", "version"
  end
end
