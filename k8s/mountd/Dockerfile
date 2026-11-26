# mountd, the arborist and sandbox-bind (docs/generic-workspace-pods.md
# "mountd"), netshim and netd's relay (docs/workspace-egress.md), static
# binaries: CGO off, so they load nothing at run time, and sandbox-bind runs
# when handed to a sandbox by descriptor, where /proc/self/exe is not a
# path. git is for the arborist's native builds. netshim programs a
# sandbox's netstack with iptables-legacy, which needs the extension
# libraries the iptables package carries.
FROM docker.io/library/golang:1.26.10-alpine3.23@sha256:78e7f1e419545bc4b8b5ee8a40a99ddb5df1216d38681dbab2eeb1fdb2427f43 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/ ./cmd/...

FROM docker.io/library/alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2
RUN apk add --no-cache git iptables iptables-legacy
COPY --from=build /out/ /usr/local/bin/
