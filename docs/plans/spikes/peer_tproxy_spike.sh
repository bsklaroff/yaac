#!/bin/bash
set -u
PROBE=/tmp/tproxy_probe
O=/tmp/out.txt; : > "$O"
cleanup() { ip netns del simpod 2>/dev/null; ip netns del enf 2>/dev/null; }
cleanup
ip netns add simpod; ip netns add enf
ip link add eth0 netns simpod type veth peer name penf netns enf
ip netns exec simpod ip addr add 10.99.0.2/24 dev eth0
ip netns exec simpod ip link set eth0 up; ip netns exec simpod ip link set lo up
ip netns exec simpod ip route add default via 10.99.0.1
ip netns exec simpod sysctl -q -w net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.eth0.rp_filter=0
ip netns exec enf ip addr add 10.99.0.1/24 dev penf
ip netns exec enf ip link set penf up; ip netns exec enf ip link set lo up
ip netns exec enf sysctl -q -w net.ipv4.ip_forward=1 net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.penf.rp_filter=0 net.ipv4.conf.all.route_localnet=1 net.ipv4.conf.all.accept_local=1
ip netns exec enf ip rule add fwmark 0x1/0x1 lookup 100
ip netns exec enf ip route add local 0.0.0.0/0 dev lo table 100
ip netns exec enf iptables -t mangle -N DIVERT
ip netns exec enf iptables -t mangle -A DIVERT -j MARK --set-mark 0x1/0x1
ip netns exec enf iptables -t mangle -A DIVERT -j ACCEPT
ip netns exec enf iptables -t mangle -A PREROUTING -p tcp -m socket -j DIVERT
ip netns exec enf iptables -t mangle -A PREROUTING -i penf -p tcp --dport 443 -j TPROXY --tproxy-mark 0x1/0x1 --on-port 15001
# count local delivery via a filter INPUT logging counter
ip netns exec enf iptables -A INPUT -p tcp --dport 443 -j LOG --log-prefix "ENFIN443 " 2>/dev/null || true
ip netns exec enf iptables -A INPUT -p tcp --dport 15001 -j LOG --log-prefix "ENFIN15001 " 2>/dev/null || true

echo "### enf ip rule:" >>"$O"; ip netns exec enf ip rule >>"$O" 2>&1
echo "### enf table 100:" >>"$O"; ip netns exec enf ip route show table 100 >>"$O" 2>&1

ip netns exec enf "$PROBE" 15001 1 >"$O.probe" 2>&1 &
PP=$!
sleep 0.4
( ip netns exec simpod timeout 2 curl -s -o /dev/null --max-time 2 https://203.0.113.7/ ) >/dev/null 2>&1 &
sleep 2.5
echo "### enf tcp sockets (want SYN-RECV origdst 203.0.113.7):" >>"$O"; ip netns exec enf ss -tanH >>"$O" 2>&1
echo "### enf INPUT filter counters:" >>"$O"; ip netns exec enf iptables -L INPUT -v -n >>"$O" 2>&1
echo "### probe:" >>"$O"; cat "$O.probe" >>"$O" 2>&1
kill $PP 2>/dev/null
cleanup
cat "$O"; echo "### END"
