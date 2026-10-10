# Source of truth for the bsklaroff/homebrew-yaac tap (see ../README.md for
# the release/sync flow). The yaac CLI and server, plus what the containerless
# driver needs on the host. A local cluster's tools come from yaac-cluster,
# which keeps the libkrun/krun tap off this install.
class YaacServer < Formula
  desc "Agent sandbox manager - parallel agent sessions on this machine or Kubernetes"
  homepage "https://github.com/bsklaroff/yaac"
  url "https://registry.npmjs.org/@bsklaroff/yaac/-/yaac-<VERSION>.tgz"
  # Recompute on every release: curl -fsSL <url> | shasum -a 256
  sha256 "REPLACE_WITH_TARBALL_SHA256_AFTER_NPM_PUBLISH"
  license "MIT"

  # The containerless driver (`yaac server start`, which is what a host
  # server is) runs workspaces as host processes, so what a session image
  # would have supplied has to be on this machine instead. macOS ships none
  # of these. tmux supervises every workspace and socat carries the ACP chat
  # transport; `yaac host check` reports both, and a create refuses without
  # them. fd and ripgrep are the agents' file-search tools, the same pair the
  # session images carry. Nothing gates on them: pi downloads its own fd when
  # none is on PATH, and an agent without ripgrep just searches more slowly.
  depends_on "fd"
  depends_on "node"
  depends_on "ripgrep"
  depends_on "socat"
  depends_on "tmux"

  # Provided by macOS, installed on Linux. git arrives with the Command Line
  # Tools that installing Homebrew itself requires, so it is here for Linux
  # and for the record: the containerless driver spawns all three directly
  # (git for every checkout, curl for the in-session yaac-mama helper, lsof
  # for port detection).
  uses_from_macos "curl"
  uses_from_macos "git"
  uses_from_macos "lsof"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Run workspaces as host processes on this machine (the containerless
      driver - no cluster, no image and no sandbox):

        yaac server start
        yaac host check

      That mode has no session image, so install the agent CLI you want to
      run (claude, codex, opencode, pi) on this machine; `yaac host check`
      names the commands.

      To run a local Kubernetes cluster as well (it keeps its own data
      dir, ~/.yaac-cluster), install its tools:

        brew trust libkrun/krun
        brew tap libkrun/krun
        brew install bsklaroff/yaac/yaac-cluster
        yaac cluster install
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/yaac --version")
  end
end
