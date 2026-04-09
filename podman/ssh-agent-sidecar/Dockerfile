FROM docker.io/alpine:3.21
RUN apk add --no-cache openssh-client
RUN adduser -D yaac
RUN mkdir -p /ssh-agent && chown yaac:yaac /ssh-agent
USER yaac
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
