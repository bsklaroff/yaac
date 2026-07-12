# Temporary carry for https://github.com/bsklaroff/yaac/issues/27 (see
# yaac-libkrun.rb): upstream krunkit built against the tap's patched
# yaac-libkrun, so its virtiofs advertises FUSE ALLOW_IDMAP and yaac's
# user-namespaced session pods can idmap-mount their hostPath volumes.
# Delete both formulas (and return yaac.rb to libkrun/krun/krunkit) once
# krunkit ships against libkrun 2.x, where LinuxComplete is the builder
# default.
#
# Differences from libkrun/krun/krunkit:
# - depends on the fully-qualified bsklaroff/yaac/yaac-libkrun, so the bare
#   name "libkrun" appears nowhere (no "found in multiple taps" ambiguity,
#   no /opt/homebrew/opt/libkrun link races with the libkrun/krun tap).
# - no gvproxy dep: yaac drives krunkit exclusively through podman, which
#   vendors its own gvproxy (libexec/podman/gvproxy).
# - conflicts with upstream krunkit: both install bin/krunkit and
#   share/krunkit/KRUN_EFI.silent.fd.
class YaacKrunkit < Formula
  desc "CLI tool to start Linux KVM or macOS HVF VMs using the libkrun"
  homepage "https://github.com/libkrun/krunkit"
  url "https://github.com/containers/krunkit/archive/refs/tags/v1.3.2.tar.gz"
  sha256 "ce714476e62db927cc872e4d2f066f5f756f6f54fef2f0cc4fc82329be75c86d"
  license "Apache-2.0"

  depends_on "rust" => :build
  # libkrun only supports Hypervisor.framework on arm64
  depends_on arch: :arm64
  depends_on "bsklaroff/yaac/yaac-libkrun"
  depends_on :macos

  conflicts_with "krunkit", because: "both install `krunkit` and its EFI firmware"

  def install
    # build.rs adds $PREFIX/lib to the link search path; pointing PREFIX at
    # yaac-libkrun's opt prefix links against the patched dylib, and the
    # binary records the dylib's version-independent install name
    # (/opt/homebrew/opt/yaac-libkrun/lib/libkrun.1.dylib). The Makefile
    # codesigns with the hypervisor entitlements as its last step, so the
    # binary must not be modified afterwards.
    system "make", "PREFIX=#{formula_opt_prefix("bsklaroff/yaac/yaac-libkrun")}"
    bin.install "target/release/krunkit"
    # krunkit resolves its firmware relative to the executable
    # (<bin>/../share/krunkit/), through both the /opt/homebrew/bin symlink
    # and the real Cellar path — so this must be share/krunkit, NOT
    # pkgshare (which would be share/yaac-krunkit).
    (share/"krunkit").install "edk2/KRUN_EFI.silent.fd"
  end

  test do
    system "#{bin}/krunkit", "--version"
  end
end
