#!/bin/bash
# FAITHFUL gVisor datapath test for stock-k8s-multi-node.md §4:
#   real runsc sandbox (fdbased AF_PACKET netstack, exactly like a session pod)
#   -> veth -> peer netns where the node agent's TPROXY + IP_TRANSPARENT
#   forwarder intercepts egress and recovers the original destination.
set -u
PROBE=/tmp/tproxy_probe
CONNECT=/tmp/connect_probe
O=/tmp/gvout.txt; : > "$O"
RUNSC=/usr/local/bin/runsc
cleanup() {
  $RUNSC --root=/run/gvspike delete --force gvtest 2>/dev/null
  ip netns del gv 2>/dev/null; ip netns del enf2 2>/dev/null
  rm -rf /tmp/bundle
}
cleanup
# --- netns + veth: gv (sandbox side) <-> enf2 (enforcement/peer side) ---
ip netns add gv; ip netns add enf2
ip link add eth0 netns gv type veth peer name pgv netns enf2
ip netns exec gv ip addr add 10.98.0.2/24 dev eth0
ip netns exec gv ip link set eth0 up; ip netns exec gv ip link set lo up
ip netns exec gv ip route add default via 10.98.0.1
ip netns exec enf2 ip addr add 10.98.0.1/24 dev pgv
ip netns exec enf2 ip link set pgv up; ip netns exec enf2 ip link set lo up
ip netns exec enf2 sysctl -q -w net.ipv4.ip_forward=1 net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.pgv.rp_filter=0 net.ipv4.conf.all.route_localnet=1 net.ipv4.conf.all.accept_local=1
ip netns exec enf2 ip rule add fwmark 0x1/0x1 lookup 100
ip netns exec enf2 ip route add local 0.0.0.0/0 dev lo table 100
ip netns exec enf2 iptables -t mangle -N DIVERT
ip netns exec enf2 iptables -t mangle -A DIVERT -j MARK --set-mark 0x1/0x1
ip netns exec enf2 iptables -t mangle -A DIVERT -j ACCEPT
ip netns exec enf2 iptables -t mangle -A PREROUTING -p tcp -m socket -j DIVERT
ip netns exec enf2 iptables -t mangle -A PREROUTING -i pgv -p tcp --dport 443 -j TPROXY --tproxy-mark 0x1/0x1 --on-port 15001

# --- OCI bundle for the sandbox workload ---
mkdir -p /tmp/bundle/rootfs
cp "$CONNECT" /tmp/bundle/rootfs/connect
cd /tmp/bundle
$RUNSC spec   # writes config.json (default: run "sh")
# patch: run our connect probe; no tty; join the pre-created gv netns
perl -0777 -i -pe 's/"terminal":\s*true/"terminal": false/' config.json
perl -0777 -i -pe 's/"args":\s*\[\s*"sh"\s*\]/"args": ["\/connect", "203.0.113.7", "443"]/' config.json
perl -0777 -i -pe 's/"type":\s*"network"\n(\s*)\}/"type": "network",\n            "path": "\/var\/run\/netns\/gv"\n$1}/' config.json
echo "### patched config.json args+netns:" >>"$O"
grep -n -A2 '"args"\|"type": "network"' config.json >>"$O" 2>&1

echo "### forwarder in enf2 (peer netns):" >>"$O"
ip netns exec enf2 "$PROBE" 15001 1 >"$O.fwd" 2>&1 &
FWD=$!
sleep 0.4
echo "### running REAL gVisor sandbox (runsc run, fdbased netstack):" >>"$O"
timeout 12 $RUNSC --root=/run/gvspike --network=sandbox run --bundle /tmp/bundle gvtest >"$O.sb" 2>"$O.sberr"
echo "rc=$?" >>"$O"
sleep 0.3
echo "### sandbox stdout:" >>"$O"; cat "$O.sb" >>"$O" 2>&1
echo "### sandbox stderr (tail):" >>"$O"; tail -3 "$O.sberr" >>"$O" 2>&1
echo "### enf2 TPROXY counters:" >>"$O"; ip netns exec enf2 iptables -t mangle -L PREROUTING -v -n | grep TPROXY >>"$O" 2>&1
echo "### forwarder output (INTERCEPTED = success):" >>"$O"; cat "$O.fwd" >>"$O" 2>&1
kill $FWD 2>/dev/null
cleanup
cat "$O"; echo "### END"
