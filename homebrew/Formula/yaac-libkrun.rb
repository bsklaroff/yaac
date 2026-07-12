# Temporary carry for https://github.com/bsklaroff/yaac/issues/27: libkrun
# only advertises FUSE ALLOW_IDMAP (idmapped mounts over virtiofs, which
# yaac's user-namespaced session pods need for hostPath volumes) under
# LinuxComplete permission semantics, and the libkrun/krun tap's krunkit
# (<= 1.3.x) always passes Simplified — podman's generated device string
# cannot override it. This is upstream libkrun v1.19.4 plus a one-line
# backport of libkrun main d33afa5's builder behavior (LinuxComplete
# hardcoded). The upstream fix is stranded behind libkrun's 2.0 C-API
# break, which krunkit 1.3.x cannot load.
#
# Consumed by yaac-krunkit, which links it via its /opt/homebrew/opt/
# yaac-libkrun path — the bare name "libkrun" appears nowhere, so this
# formula is invisible to (and coexists with) the libkrun/krun tap.
# Delete both formulas once krunkit ships against libkrun 2.x, where
# LinuxComplete is the builder default.
class YaacLibkrun < Formula
  desc "Dynamic library providing KVM-based process isolation capabilities"
  homepage "https://github.com/libkrun/libkrun"
  url "https://github.com/containers/libkrun/archive/refs/tags/v1.19.4.tar.gz"
  sha256 "e8775fab2b460972a67ca6cd936296bb79cdb078d852d712a283cb290dd0b284"
  license "Apache-2.0"

  keg_only "it would shadow the libkrun/krun tap's libkrun when both are installed"

  depends_on "lld" => :build
  depends_on "rust" => :build
  # Upstream only supports Hypervisor.framework on arm64
  depends_on arch: :arm64
  depends_on "dtc"
  depends_on "libepoxy"
  # Fully qualified (upstream's own formula uses bare names): nothing else
  # references the libkrun/krun tap anymore, so on a machine that never
  # tapped it bare names fail to resolve ("No available formula") — and
  # these must be that tap's builds regardless (libkrunfw is tap-only,
  # virglrenderer is their patched fork). Dependency resolution refuses to
  # auto-tap even qualified names, hence the README's explicit
  # `brew tap libkrun/krun`.
  depends_on "libkrun/krun/libkrunfw"
  depends_on "libkrun/krun/virglrenderer"
  depends_on "xz"

  # Force LinuxComplete semantics so the virtiofs device advertises FUSE
  # ALLOW_IDMAP (one-line backport of libkrun main commit d33afa5).
  patch :DATA

  def install
    system "make", "BLK=1", "NET=1", "GPU=1", "TIMESYNC=1"
    system "make", "PREFIX=#{prefix}", "install"
  end

  test do
    (testpath/"test.c").write <<~EOS
      #include <libkrun.h>
      int main()
      {
         int c = krun_create_ctx();
         return 0;
      }
    EOS
    system ENV.cc, "test.c", "-I#{include}", "-L#{lib}", "-lkrun", "-o", "test"
    system "./test"
  end
end

__END__
--- libkrun-1.19.4/src/devices/src/virtio/fs/device.rs
+++ libkrun-1.19.4/src/devices/src/virtio/fs/device.rs
@@ -69,6 +69,12 @@
         read_only: bool,
         virtual_entries: Vec<VirtualDirEntry>,
     ) -> super::Result<Fs> {
+        // Backport of libkrun main d33afa5's builder behavior: only
+        // LinuxComplete semantics advertises FUSE ALLOW_IDMAP, and krunkit
+        // <= 1.3.x always passes Simplified (podman's generated device string
+        // cannot override it), so idmapped mounts over virtiofs fail with
+        // EINVAL. https://github.com/bsklaroff/yaac/issues/27
+        let semantics = PermissionSemantics::LinuxComplete;
         let avail_features = (1u64 << VIRTIO_F_VERSION_1) | (1u64 << VIRTIO_RING_F_EVENT_IDX);

         let tag = fs_id.into_bytes();
