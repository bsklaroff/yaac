#!/bin/sh
# Pod-netns transparent egress redirect + default-deny for yaac session
# pods.
#
# Runs once as an init container with NET_ADMIN (scoped to the pod's user
# namespace — session pods set hostUsers: false). The session container's
# bounding set has no NET_ADMIN — sudo cannot exceed it, and a nested
# userns only owns namespaces it creates — so the workload cannot remove
# these rules. Two layers compose:
#
#   nat/OUTPUT: outbound udp/53 and tcp 443/80 are REDIRECTed to the
#   per-pod yaac-relay on 127.0.0.1 (DNS stub + HTTPS/HTTP listeners; 443
#   and 80 land on *separate* relay ports so the relay learns the
#   original protocol from which port accepted — no SO_ORIGINAL_DST
#   needed). The relay forwards to the shared MITM proxy with a
#   per-connection session credential (PROXY protocol v2 TLV). No
#   in-cluster excludes: a session container has no legitimate in-cluster
#   443/80 destination, so every 443/80 is captured uniformly.
#
#   filter/OUTPUT: default-deny keyed on the relay's uid. nat runs before
#   filter, so everything the REDIRECTs captured now carries dst
#   127.0.0.1 and passes the loopback-destination ACCEPT; anything else
#   keeps its real destination and is REJECTed unless it is the relay
#   (uid $RELAY_UID) dialing the proxy Service VIP's transparent ports.
#   The relay's upstream is never re-captured: it dials the transport
#   ports, which no nat rule matches.
set -eu

: "${REDIRECT_HTTPS_PORT:?required}"
: "${REDIRECT_HTTP_PORT:?required}"
: "${REDIRECT_DNS_PORT:?required}"
: "${PROXY_CLUSTER_IP:?required}"
: "${RELAY_UID:?required}"
: "${TRANSPARENT_HTTPS_PORT:?required}"
: "${TRANSPARENT_HTTP_PORT:?required}"
: "${TRANSPARENT_TUNNEL_PORT:?required}"

# Must be a literal IPv4 address: iptables resolves hostnames at rule
# install time, and the pod's resolver path is already REDIRECTed to a
# relay that is not running yet — a DNS name here would hang, not fail.
case "$PROXY_CLUSTER_IP" in
  *[!0-9.]*) echo "PROXY_CLUSTER_IP must be an IPv4 address, got: $PROXY_CLUSTER_IP" >&2; exit 1 ;;
esac

# --- nat: capture into the relay ---
# Loopback stays pristine; everything else on 53/443/80 is REDIRECTed.
iptables -t nat -A OUTPUT -o lo -j RETURN
# No in-cluster CIDR excludes: the session container's only legitimate
# egress is the proxy (reached via the relay on the transport ports, not
# 443/80) and DNS (the stub below), so there is no in-cluster 443/80 to
# spare. Capturing it all uniformly means an in-cluster probe (e.g. an
# agent poking the apiserver VIP) is MITM'd and denied at the proxy by
# SNI, and an allowlisted external host that happens to overlap the
# cluster CIDRs still reaches the proxy instead of being silently dropped.
# DNS must never escape the pod — the kube-dns VIP is in-cluster, so
# capturing udp/53 here is what closes the DNS-tunneling channel.
iptables -t nat -A OUTPUT -p udp --dport 53 -j REDIRECT --to-ports "$REDIRECT_DNS_PORT"
iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-ports "$REDIRECT_HTTPS_PORT"
iptables -t nat -A OUTPUT -p tcp --dport 80 -j REDIRECT --to-ports "$REDIRECT_HTTP_PORT"

# --- filter: default-deny with a relay-only carve-out ---
# The carve-out admits exactly relay-uid -> proxy VIP on the transport
# ports. Matching the pinned Service VIP (a /32, not a CIDR-wide rule)
# holds because kube-proxy's Service DNAT happens in the HOST netns —
# every hook in this pod netns still sees the VIP as dst. A socket-LB
# CNI (e.g. Cilium with bpf-lb-sock) would instead rewrite connect()
# in-pod to the backend pod IP and this rule would fail CLOSED (relay
# egress REJECTed, no session traffic at all); yaac's cluster setup
# runs Cilium with socket LB off and kube-proxy present
# (scripts/setup-kind-cluster.sh) — widen this match before ever
# enabling socket LB. dport stays meaningful because the proxy Service
# pins port == targetPort.
PROXY_PORTS="$TRANSPARENT_HTTPS_PORT,$TRANSPARENT_HTTP_PORT,$TRANSPARENT_TUNNEL_PORT"
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Admit the REDIRECTed traffic by DESTINATION, not `-o lo`: every LOCAL_OUT
# hook shares one routing decision computed before nat OUTPUT runs, so the
# `-o` the filter sees is still the original egress device (eth0), not lo —
# `-o lo` would never match a REDIRECTed packet and it would fall to the
# REJECT below. nat already rewrote its dst to 127.0.0.1, so match that.
iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner "$RELAY_UID" -p tcp -d "$PROXY_CLUSTER_IP/32" \
  -m multiport --dports "$PROXY_PORTS" -j ACCEPT
# REJECT, not DROP: agents fail in milliseconds with a clear refusal
# (tcp-reset / port-unreachable) instead of hanging on a timeout.
iptables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset
iptables -A OUTPUT -j REJECT
# v4-only on purpose: pods carry no global v6 address today. If
# dual-stack ever lands, BOTH the nat and filter rules need ip6tables
# mirrors (and the stub AAAA answers) or v6 becomes the bypass.
#
# OUTPUT-only on purpose: everything in the pod (including netns=host
# nested containers) generates locally-originated traffic. If nested
# containers ever get their own netns, their packets traverse
# PREROUTING/FORWARD instead and bypass both tables — mirror the rules
# there before making that change.

echo "yaac-redirect-init: nat 443 -> 127.0.0.1:$REDIRECT_HTTPS_PORT," \
  "80 -> 127.0.0.1:$REDIRECT_HTTP_PORT, udp53 -> 127.0.0.1:$REDIRECT_DNS_PORT" \
  "(direct: lo); filter default-deny" \
  "(carve-out: uid $RELAY_UID -> tcp $PROXY_PORTS at $PROXY_CLUSTER_IP)"
