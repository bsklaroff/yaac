# TEMPORARY formula: delete (and point yaac.rb's depends_on back at core
# "kind") once homebrew-core ships kind >= v0.33.0.
#
# Why it exists: podman 6.0 changed the container label format from a map to
# a slice, which breaks cluster enumeration in every kind release up to and
# including v0.32.0 (`kind get clusters` exits 125 - kind#4201). The fix,
# kind#4203, is merged to main but unreleased, so this builds from the pinned
# merge commit. `go install sigs.k8s.io/kind@latest` does NOT work as an
# alternative - `@latest` resolves to the broken v0.32.0 tag.
class YaacKind < Formula
  desc "Kubernetes IN Docker, pinned past kind#4203 for podman 6.x"
  homepage "https://kind.sigs.k8s.io/"
  url "https://github.com/kubernetes-sigs/kind.git",
      revision: "f1ec7694f59f57572c81bc9f8b3df46780533959"
  # Merge commit of kind#4203 (2026-06-26). Bump the date suffix when
  # re-pinning to a newer main commit.
  version "0.33.0-alpha.20260626"
  license "Apache-2.0"

  depends_on "go" => :build

  conflicts_with "kind", because: "both install a `kind` binary"

  def install
    # Stamp the pinned commit into the version so `kind version` prints
    # "v0.33.0-alpha+f1ec7694f59f57" instead of a bare "v0.33.0-alpha":
    # yaac's cluster-setup preflight cannot tell whether an unstamped alpha
    # predates the kind#4203 fix, but defers commit-stamped builds to its
    # functional probe. Keep the sha in sync with `revision` above.
    ldflags = %W[
      -s -w
      -X sigs.k8s.io/kind/pkg/cmd/kind/version.gitCommit=f1ec7694f59f57572c81bc9f8b3df46780533959
    ]
    # output: is required - std_go_args defaults the binary name to the
    # formula name ("yaac-kind"), but everything expects `kind` on PATH.
    system "go", "build", *std_go_args(output: bin/"kind", ldflags:)

    generate_completions_from_executable(bin/"kind", shell_parameter_format: :cobra)
  end

  test do
    assert_match "v0.33.0-alpha+f1ec7694f59f57", shell_output("#{bin}/kind version")
  end
end
