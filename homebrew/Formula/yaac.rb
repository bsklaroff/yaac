# Source of truth for the bsklaroff/homebrew-yaac tap (see ../README.md for
# the release/sync flow). Lives in a tap rather than homebrew-core because the
# macOS path depends on this tap's own krunkit/libkrun pair (and yaac-kind),
# and core formulas cannot depend on tap formulas.
class Yaac < Formula
  desc "Agent sandbox manager - parallel agent sessions on a local Kubernetes cluster"
  homepage "https://github.com/bsklaroff/yaac"
  url "https://registry.npmjs.org/@bsklaroff/yaac/-/yaac-<VERSION>.tgz"
  # Recompute on every release: curl -fsSL <url> | shasum -a 256
  sha256 "REPLACE_WITH_TARBALL_SHA256_AFTER_NPM_PUBLISH"
  license "MIT"

  depends_on "kubernetes-cli"
  depends_on "node"
  # Core podman is >= 6.0 (needed for krunkit --timesync passthrough on
  # macOS); podman 6.x in turn requires a kind with kind#4203, which no
  # kind release has yet - hence the tap-pinned yaac-kind. Switch to core
  # "kind" and delete yaac-kind once core ships kind >= v0.33.0.
  depends_on "podman"
  depends_on "bsklaroff/yaac/yaac-kind"

  # The containerless driver (`yaac server start`, which is what a host
  # server is) runs worktrees as host processes, so what a session image would have
  # supplied has to be on this machine instead. macOS ships none of these.
  # tmux supervises every worktree and socat carries the ACP chat transport;
  # `yaac host check` reports both, and a create refuses without them.
  depends_on "tmux"
  depends_on "socat"
  # Agent file-search tools, the same pair the session images carry. Nothing
  # gates on them: pi downloads its own fd when none is on PATH, and an
  # agent without ripgrep just searches more slowly.
  depends_on "fd"
  depends_on "ripgrep"
  # Provided by macOS, installed on Linux. git arrives with the Command Line
  # Tools that installing Homebrew itself requires, so it is here for Linux
  # and for the record: the containerless driver spawns all three directly
  # (git for every checkout, curl for the in-session yaac-mama helper, lsof
  # for port detection).
  uses_from_macos "curl"
  uses_from_macos "git"
  uses_from_macos "lsof"

  on_macos do
    # libkrun is the only macOS virtualization stack whose virtiofs can
    # report real file ownership, which gVisor session pods writing hostPath
    # volumes require (the runsc gofer stats files as root; the sentry
    # enforces permissions on what it sees) — but only under LinuxComplete
    # permission semantics, which the libkrun/krun tap's krunkit (<= 1.3.x)
    # never selects: its Simplified semantics report the accessing process
    # as every file's owner, like Apple's applehv/vz virtiofs, so session
    # uids cannot write hostPath mounts
    # (https://github.com/bsklaroff/yaac/issues/27 is the userns-era
    # symptom of the same limitation). yaac-krunkit is upstream krunkit
    # built against the tap's patched yaac-libkrun; both are temporary
    # carries — see Formula/yaac-krunkit.rb. krunkit/libkrun are arm64-only.
    depends_on arch: :arm64
    depends_on "bsklaroff/yaac/yaac-krunkit"
  end

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
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

      To run worktrees as host processes instead - no cluster, no image and
      no sandbox - just start the server and verify the host rather than a
      cluster. A host server IS the containerless driver; the k8s one runs
      in the cluster `yaac cluster install` builds:

        yaac server start
        yaac host check

      That mode has no session image, so install the agent CLI you want to
      run (claude, codex, opencode, pi) on this machine; `yaac host check`
      names the commands.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/yaac --version")
  end
end
