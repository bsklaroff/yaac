# The builder image (docs/image-builds.md): upstream BuildKit with buildkitd
# rebuilt from the same release's source. Both the source and the images are
# pinned. Its config is written by whoever starts it (buildkitdConfig).
#
# The rebuild exists for one patch. moby/sys/userns decides it is in a user
# namespace unless /proc/self/ns/user has the host kernel's init inode, and
# gVisor reports a different one. containerd then refuses its direct layer
# unpack and extracts every layer through an overlay of all the layers
# below it, which under gVisor is several times slower per file. The patch
# makes the check read uid_map, which is accurate in the sandbox.
FROM docker.io/library/golang:1.26.10-alpine3.23@sha256:78e7f1e419545bc4b8b5ee8a40a99ddb5df1216d38681dbab2eeb1fdb2427f43 AS buildkitd
ARG BUILDKIT_VERSION=v0.34.2
ARG BUILDKIT_COMMIT=8c579433824224dc64a158cf8734495b6e2b186a
ARG BUILDKIT_SHA256=114a26e1a3d30fdb875ac869b404c09264b8f7bd7a085106b89b18dabd8dd651
WORKDIR /src
RUN wget -qO /tmp/buildkit.tar.gz "https://github.com/moby/buildkit/archive/${BUILDKIT_COMMIT}.tar.gz" && \
    echo "${BUILDKIT_SHA256}  /tmp/buildkit.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/buildkit.tar.gz --strip-components=1 && rm /tmp/buildkit.tar.gz
RUN f=vendor/github.com/moby/sys/userns/userns_linux.go && \
    grep -q '^var inUserNS = sync.OnceValue(runningInUserNS)$' "$f" && \
    sed -i 's/^var inUserNS = sync.OnceValue(runningInUserNS)$/var inUserNS = sync.OnceValue(runningInUserNSFromUIDMap)/' "$f"
RUN CGO_ENABLED=0 go build -mod=vendor -trimpath \
      -ldflags "-s -w -X github.com/moby/buildkit/version.Version=${BUILDKIT_VERSION}-yaac -X github.com/moby/buildkit/version.Revision=${BUILDKIT_COMMIT} -X github.com/moby/buildkit/version.Package=github.com/moby/buildkit" \
      -tags "osusergo netgo static_build seccomp" -o /usr/bin/buildkitd ./cmd/buildkitd

FROM docker.io/moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe
COPY --from=buildkitd /usr/bin/buildkitd /usr/bin/buildkitd
