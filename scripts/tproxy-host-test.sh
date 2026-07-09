#!/usr/bin/env bash
# tproxy-host-test.sh — minimal TPROXY reproducer, no kubernetes/cilium/podman.
#
# Run directly on a Linux host as root:  sudo ./scripts/tproxy-host-test.sh
#
# Recreates exactly the delivery tail cilium's L7 egress redirect relies on:
#   veth ingress -> mangle PREROUTING TPROXY (--on-ip 127.0.0.1)
#   -> fwmark 0x200 -> policy route "local default dev lo"
#   -> transparent (IP_TRANSPARENT) listener socket
#
# PASS = kernel delivers the redirected SYN to the transparent socket.
# FAIL on a kernel where the in-cluster redirect also fails = kernel-level
# confirmation, and this file is the reproducer to attach to a bug report.
#
# Deps: iproute2, iptables, socat, nc (netcat), coreutils timeout.
# Everything it creates is torn down on exit (including on error/ctrl-c).

set -uo pipefail

[ "$(uname -s)" = "Linux" ] || { echo "linux only"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
for t in ip iptables socat nc timeout sysctl; do
  command -v "$t" >/dev/null || { echo "missing dependency: $t"; exit 1; }
done

NETNS=tpxhost
VETH=vtph0
PEER=vtph1
PHANTOM=198.18.0.99      # unroutable destination, stands in for the DNS sinkhole
LPORT=12399              # transparent listener port, stands in for envoy's
TABLE=199                # our own copy of cilium's table-2004 local route
RULEPREF=99

cleanup() {
  iptables -t mangle -D PREROUTING -i "$VETH" -p tcp -d "$PHANTOM" \
    -j TPROXY --on-port "$LPORT" --on-ip 127.0.0.1 --tproxy-mark 0x200/0xffffffff 2>/dev/null
  ip rule del pref "$RULEPREF" 2>/dev/null
  ip route flush table "$TABLE" 2>/dev/null
  pkill -f "TCP-LISTEN:$LPORT" 2>/dev/null
  ip netns del "$NETNS" 2>/dev/null
  ip link del "$VETH" 2>/dev/null
}
trap cleanup EXIT
cleanup 2>/dev/null

echo "== host: $(uname -r) $(uname -m)"

# client netns + veth
ip netns add "$NETNS"
ip link add "$VETH" type veth peer name "$PEER"
ip link set "$PEER" netns "$NETNS"
ip addr add 10.199.0.1/30 dev "$VETH"
ip link set "$VETH" up
sysctl -qw "net.ipv4.conf.$VETH.rp_filter=0"
ip netns exec "$NETNS" sh -c "
  ip addr add 10.199.0.2/30 dev $PEER
  ip link set $PEER up; ip link set lo up
  ip route add default via 10.199.0.1"

# the delivery tail: fwmark 0x200 -> local route on lo (cilium's table-2004 shape)
ip route add local default dev lo table "$TABLE"
ip rule add pref "$RULEPREF" fwmark 0x200/0xf00 lookup "$TABLE"

# the TPROXY rule (scoped to our veth + phantom IP only)
iptables -t mangle -I PREROUTING 1 -i "$VETH" -p tcp -d "$PHANTOM" \
  -j TPROXY --on-port "$LPORT" --on-ip 127.0.0.1 --tproxy-mark 0x200/0xffffffff

# transparent listener (stands in for envoy)
socat -T5 TCP-LISTEN:$LPORT,bind=127.0.0.1,ip-transparent,reuseaddr,fork EXEC:"echo TPROXY-OK" &
sleep 1
ss -tln "sport = :$LPORT" | tail -1

echo "== test: connect to $PHANTOM:443 from the netns"
OUT=$(ip netns exec "$NETNS" sh -c "echo ping | timeout 4 nc $PHANTOM 443; echo rc=\$?")
echo "$OUT" | sed 's/^/   /'
echo "== TPROXY rule counter:"
iptables -t mangle -L PREROUTING 1 -v -n | tail -1 | sed 's/^/   /'

if echo "$OUT" | grep -q TPROXY-OK; then
  echo "== PASS: kernel TPROXY -> transparent-socket delivery works on $(uname -r)"
else
  echo "== FAIL: SYN redirected by TPROXY but never delivered to the transparent"
  echo "   socket on $(uname -r) — kernel-level breakage, independent of any"
  echo "   container runtime. This script is the minimal reproducer."
  exit 1
fi
