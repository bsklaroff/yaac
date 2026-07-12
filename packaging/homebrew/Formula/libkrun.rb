# Temporary carry for https://github.com/bsklaroff/yaac/issues/27: the
# libkrun/krun tap's krunkit (<= 1.3.x) always passes Simplified permission
# semantics to libkrun's virtiofs (podman's generated device string cannot
# override it), and libkrun only advertises FUSE ALLOW_IDMAP under
# LinuxComplete — so idmapped mounts over virtiofs fail with EINVAL and
# yaac's user-namespaced session pods cannot mount their hostPath volumes.
#
# This is upstream's libkrun v1.19.4 formula plus a one-line backport of
# libkrun main d33afa5's builder behavior (LinuxComplete hardcoded). The
# upstream fix is stranded behind libkrun's 2.0 C-API break, which krunkit
# 1.3.x cannot load. Delete this formula and drop yaac.rb's explicit
# bsklaroff/yaac/libkrun dep once the upstream krunkit+libkrun pair
# advertises idmap out of the box (i.e. krunkit builds against libkrun 2.x).
#
# It deliberately shadows the name "libkrun" so krunkit's
# /opt/homebrew/opt/libkrun load path resolves to this keg. If upstream
# libkrun/krun/libkrun is already installed, replace it:
#   brew uninstall --ignore-dependencies libkrun
#   brew install bsklaroff/yaac/libkrun
class Libkrun < Formula
  desc "Dynamic library providing KVM-based process isolation capabilities"
  homepage "https://github.com/libkrun/libkrun"
  url "https://github.com/containers/libkrun/archive/refs/tags/v1.19.4.tar.gz"
  sha256 "e8775fab2b460972a67ca6cd936296bb79cdb078d852d712a283cb290dd0b284"
  license "Apache-2.0"
  revision 1

  depends_on "lld" => :build
  depends_on "rust" => :build
  # Upstream only supports Hypervisor.framework on arm64
  depends_on arch: :arm64
  depends_on "dtc"
  depends_on "libepoxy"
  depends_on "libkrunfw"
  depends_on "virglrenderer"
  depends_on "xz"

  # Force LinuxComplete semantics so the virtiofs device advertises FUSE
  # ALLOW_IDMAP (one-line backport of libkrun main commit d33afa5).
  patch :DATA

  def install
    system "make", "BLK=1", "NET=1", "GPU=1", "TIMESYNC=1"
    system "make", "PREFIX=#{prefix}", "install"
  end

  def caveats
    <<~EOS
      This is upstream libkrun v1.19.4 plus a one-line backport that fixes
      idmapped mounts over virtiofs (bsklaroff/yaac#27). It shadows
      libkrun/krun/libkrun; return to the upstream formula once krunkit
      ships against libkrun 2.x:
        brew uninstall --ignore-dependencies libkrun
        brew install libkrun/krun/libkrun
    EOS
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
