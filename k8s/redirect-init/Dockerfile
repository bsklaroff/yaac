FROM docker.io/library/alpine:3.20
# iptables: alpine's default backend (legacy xtables) — validated against
# the kind node's kernel end to end by `yaac cluster check`. The
# transparent-egress design's other halves (SO_ORIGINAL_DST recovery, the
# cluster-check redirect probe) live in the yaac-relay image, so this
# image needs nothing beyond iptables.
RUN apk add --no-cache iptables
COPY redirect.sh /redirect.sh
RUN chmod +x /redirect.sh
CMD ["/redirect.sh"]
