#!/bin/bash
# FAITHFUL viability test for in-sandbox-netstack-dnat.md.
#   real runsc sandbox (--network=sandbox, fdbased netstack, exactly like a
#   session pod) with a `nat` OUTPUT DNAT rule installed in its netstack via
#   `--reproduce-nat`. Proves (or refutes) that netstack rewrites a packet's
#   destination to the proxy pod IP BEFORE it leaves the sandbox, so the CNI
#   just routes it. Also probes the two things that can sink the design:
#   fail-closed for un-DNAT'd traffic, and the net-raw / raw-IP-socket bypass.
#
# Topology: gv (sandbox, eth0 10.98.0.2) <-veth-> enf2 (peer, pgv 10.98.0.1).
# The "proxy pod" is simulated at 10.98.0.1:15443 (on-link from the sandbox).
# The sandbox dials 203.0.113.7 (TEST-NET, unroutable here) so that ANY arrival
# at the proxy listener PROVES the destination was rewritten in-sandbox.
set -u
RUNSC=/usr/local/bin/runsc
PROBE=/tmp/tproxy_probe      # reused as a PLAIN listener (dst is local here)
CONNECT=/tmp/connect_probe
RAW=/tmp/raw_send_probe
PKT=/tmp/pkt_send_probe
PROXY_IP=10.98.0.1
PROXY_PORT=15443
ORIG_IP=203.0.113.7
O=/tmp/dnatout.txt; : > "$O"

cleanup() {
  $RUNSC --root=/run/dnatspike delete --force dnat 2>/dev/null
  ip netns del gv 2>/dev/null; ip netns del enf2 2>/dev/null
  rm -rf /tmp/dbundle
}
cleanup

# --- netns + veth ---
ip netns add gv; ip netns add enf2
ip link add eth0 netns gv type veth peer name pgv netns enf2
ip netns exec gv ip addr add 10.98.0.2/24 dev eth0
ip netns exec gv ip link set eth0 up; ip netns exec gv ip link set lo up
ip netns exec gv ip route add default via 10.98.0.1
ip netns exec enf2 ip addr add $PROXY_IP/24 dev pgv
ip netns exec enf2 ip link set pgv up; ip netns exec enf2 ip link set lo up
ip netns exec enf2 sysctl -q -w net.ipv4.ip_forward=1 net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.pgv.rp_filter=0

# raw-table PREROUTING counters on the peer, keyed by DESTINATION, to see what
# actually crossed the wire: rewritten (-> proxy) vs original (bypass).
ip netns exec enf2 iptables -t raw -A PREROUTING -i pgv -d $PROXY_IP -p tcp --dport $PROXY_PORT -j ACCEPT
ip netns exec enf2 iptables -t raw -A PREROUTING -i pgv -d $ORIG_IP -j ACCEPT
ip netns exec enf2 iptables -t raw -A PREROUTING -i pgv -d 10.98.0.123 -j ACCEPT
# per-ifindex dsts for the AF_PACKET brute-force (203.0.113.8..11)
for d in 8 9 10 11; do ip netns exec enf2 iptables -t raw -A PREROUTING -i pgv -d 203.0.113.$d -j ACCEPT; done
# swallow forwarded originals so nothing leaks; keep counters meaningful.
ip netns exec enf2 iptables -A FORWARD -j DROP

# --- the DNAT rule, installed in the gv netns KERNEL nat table so
#     --reproduce-nat can scrape it into the sandbox netstack at boot ---
ip netns exec gv iptables -t nat -A OUTPUT -p tcp --dport 443 \
  -j DNAT --to-destination $PROXY_IP:$PROXY_PORT
echo "### gv-netns kernel nat OUTPUT (to be scraped by --reproduce-nat):" >>"$O"
ip netns exec gv iptables -t nat -S OUTPUT >>"$O" 2>&1

mk_bundle() { # $1=argv-json  -> /tmp/dbundle with config.json
  rm -rf /tmp/dbundle; mkdir -p /tmp/dbundle/rootfs
  cp "$CONNECT" /tmp/dbundle/rootfs/connect
  cp "$RAW"     /tmp/dbundle/rootfs/rawsend
  cp "$PKT"     /tmp/dbundle/rootfs/pktsend
  cd /tmp/dbundle
  $RUNSC spec
  perl -0777 -i -pe 's/"terminal":\s*true/"terminal": false/' config.json
  perl -0777 -i -pe "s/\"args\":\\s*\\[\\s*\"sh\"\\s*\\]/\"args\": $1/" config.json
  perl -0777 -i -pe 's/"type":\s*"network"\n(\s*)\}/"type": "network",\n            "path": "\/var\/run\/netns\/gv"\n$1}/' config.json
  # Grant CAP_NET_RAW in every cap set — the nested session class has it
  # (pod-spec.ts), and it's what the raw/packet bypass phases actually test.
  perl -0777 -i -pe 's/"CAP_NET_BIND_SERVICE"/"CAP_NET_BIND_SERVICE",\n                "CAP_NET_RAW"/g' config.json
}

run_sandbox() { # $1=extra runsc flags ; leaves stdout in $O.sb
  timeout 12 $RUNSC --root=/run/dnatspike --network=sandbox --reproduce-nat $1 \
    run --bundle /tmp/dbundle dnat >"$O.sb" 2>"$O.sberr"
  echo "runsc rc=$?" >>"$O"
}

reset_counters() {
  ip netns exec enf2 iptables -t raw -Z PREROUTING
  ip netns exec enf2 iptables -Z FORWARD
}
show_counters() { # $1=label
  echo "### [$1] enf2 raw PREROUTING counters (pkts to proxy vs orig):" >>"$O"
  ip netns exec enf2 iptables -t raw -L PREROUTING -v -n | grep -E "dpt:$PROXY_PORT|$ORIG_IP|10.98.0.123" >>"$O" 2>&1
}

# =====================================================================
# PHASE A — core viability: connect(203.0.113.7:443) must land on the
# proxy listener at 10.98.0.1:15443 => netstack DNAT'd before egress.
# =====================================================================
echo "" >>"$O"; echo "########## PHASE A: netstack DNAT on OUTPUT ##########" >>"$O"
reset_counters
ip netns exec enf2 "$PROBE" $PROXY_PORT 1 >"$O.fwd" 2>&1 &
FWD=$!; sleep 0.4
mk_bundle '["\/connect", "203.0.113.7", "443"]'
run_sandbox ""
sleep 0.3
echo "### sandbox stdout:" >>"$O"; cat "$O.sb" >>"$O"
echo "### proxy listener (INTERCEPTED src=podIP -> origdst=proxyIP = SUCCESS):" >>"$O"
cat "$O.fwd" >>"$O" 2>&1
show_counters "A"
kill $FWD 2>/dev/null; wait $FWD 2>/dev/null

# =====================================================================
# PHASE B — fail-closed: connect(203.0.113.7:80) has NO DNAT rule; it must
# NOT reach a listener (here: no route -> connect fails/times out).
# =====================================================================
echo "" >>"$O"; echo "########## PHASE B: fail-closed for un-DNAT'd port ##########" >>"$O"
reset_counters
mk_bundle '["\/connect", "203.0.113.7", "80"]'
run_sandbox ""
sleep 0.3
echo "### sandbox stdout (want connect() rc=-1 failed):" >>"$O"; cat "$O.sb" >>"$O"
show_counters "B"

# =====================================================================
# PHASE C — net-raw bypass: with -net-raw=true (the nested session class),
# emit a hand-crafted SYN to 203.0.113.7:443 on a SOCK_RAW/IP_HDRINCL socket.
# If the peer sees dst=203.0.113.7 -> the raw write SKIPPED the OUTPUT nat
# hook (BYPASS). If dst=10.98.0.1 -> the hook still applied.
# =====================================================================
echo "" >>"$O"; echo "########## PHASE C: net-raw / raw-IP-socket bypass ##########" >>"$O"
reset_counters
ip netns exec enf2 "$PROBE" $PROXY_PORT 1 >"$O.fwd2" 2>&1 &
FWD2=$!; sleep 0.4
mk_bundle '["\/rawsend", "203.0.113.7", "443"]'
run_sandbox "-net-raw=true"
sleep 0.3
echo "### sandbox stdout (rawsend result):" >>"$O"; cat "$O.sb" >>"$O"
echo "### proxy listener (any INTERCEPTED => raw pkt was hooked to proxy):" >>"$O"
cat "$O.fwd2" >>"$O" 2>&1
show_counters "C"
kill $FWD2 2>/dev/null; wait $FWD2 2>/dev/null

# =====================================================================
# PHASE D — packet-socket bypass: with -net-raw=true AND
# -allow-packet-socket-write=true (exactly the nested class's runsc flags),
# inject a SYN to 203.0.113.7:443 straight onto eth0 at L2 via AF_PACKET.
# This is below the IP OUTPUT hook. If the peer's raw PREROUTING sees dst=
# 203.0.113.7, the DNAT interception is bypassed for this session class.
# =====================================================================
echo "" >>"$O"; echo "########## PHASE D: AF_PACKET (allow-packet-socket-write) bypass ##########" >>"$O"
reset_counters
ip netns exec enf2 "$PROBE" $PROXY_PORT 1 >"$O.fwd3" 2>&1 &
FWD3=$!; sleep 0.4
mk_bundle '["\/pktsend", "203.0.113.7", "443"]'
run_sandbox "-net-raw=true -allow-packet-socket-write=true"
sleep 0.3
echo "### sandbox stdout (pktsend result):" >>"$O"; cat "$O.sb" >>"$O"
echo "### enf2 raw PREROUTING (any 203.0.113.x with pkts>0 => L2 BYPASS):" >>"$O"
ip netns exec enf2 iptables -t raw -L PREROUTING -v -n | grep -E "203.0.113" >>"$O" 2>&1
kill $FWD3 2>/dev/null; wait $FWD3 2>/dev/null

echo "" >>"$O"; echo "########## END ##########" >>"$O"
cleanup
cat "$O"
