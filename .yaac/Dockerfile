# This project's own workspace image (docs/image-builds.md), layered on the
# stock one: it adds Go, which `pnpm build` needs to cross-compile acpd.
# Applied like the init steps: `yaac image create <project> dev --file
# .yaac/Dockerfile` then `yaac image default <project> dev`, or `yaac image
# edit <project> dev --file .yaac/Dockerfile` once it exists.
#
# Go comes from the Go module proxy, which a project build's default egress
# allowlist reaches (Docker Hub it does not): the go1.26.10 release as the
# `golang.org/toolchain` module zip, pinned by SHA-256. The zip keeps no file
# modes, so the commands are marked executable as `go` itself does when it
# switches toolchains.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
ARG GO_VERSION=1.26.10
RUN arch="$(dpkg --print-architecture)" && \
    case "$arch" in \
      amd64) SHA256=f64ecb0807852be2c98899561c45288a9ad57f4e88f3cd002ffabeccbd03bfe1 ;; \
      arm64) SHA256=195f18be92553fb272b9c4f9fca6e67b6a04d8831bf6c4b918ac70982fadb444 ;; \
    esac && \
    curl -fsSL -o /tmp/go.zip "https://proxy.golang.org/golang.org/toolchain/@v/v0.0.1-go${GO_VERSION}.linux-${arch}.zip" && \
    echo "${SHA256}  /tmp/go.zip" | sha256sum -c - && \
    mkdir /usr/local/go && bsdtar -xf /tmp/go.zip -C /usr/local/go --strip-components 2 && \
    rm /tmp/go.zip && \
    chmod a+x /usr/local/go/bin/* /usr/local/go/pkg/tool/*/* && \
    /usr/local/go/bin/go version
USER yaac
ENV PATH=/usr/local/go/bin:${PATH}
