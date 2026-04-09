FROM docker.io/alpine:3.21
RUN apk add --no-cache openssh-client
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
