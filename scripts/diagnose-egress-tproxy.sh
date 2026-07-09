#!/usr/bin/env bash
# diagnose-egress-tproxy.sh — localize why session-egress TPROXY redirect fails.
#
# Runs against the cluster kubectl currently points at (works on both the mac
# and linux setups; run on the working cluster first for a PASS baseline).
#
# Usage:
#   ./scripts/diagnose-egress-tproxy.sh                 # all checks
#   SKIP_CAPTURE=1 ./scripts/diagnose-egress-tproxy.sh  # skip tcpdump/drop-trace
#   SKIP_SYNTHETIC=1 ...                                # skip the kernel-only test
#   NS=yaac SINKHOLE=198.18.0.1 CURLS=5 ...             # tunables
#
# Non-destructive except: one privileged hostNetwork debug pod (deleted at exit),
# one iptables TPROXY rule scoped to a throwaway veth (deleted by the test), and
# temporarily enabling the skb:kfree_skb tracepoint.

set -uo pipefail

NS=${NS:-yaac}
SINKHOLE=${SINKHOLE:-198.18.0.1}
CURLS=${CURLS:-5}
NETSHOOT_IMAGE=${NETSHOOT_IMAGE:-nicolaka/netshoot:latest}
DBG_POD=tproxy-diag
TMP=$(mktemp -d)

if [ -t 1 ]; then
  GRN=$'\e[32m'; RED=$'\e[31m'; YEL=$'\e[33m'; BLD=$'\e[1m'; NC=$'\e[0m'
else
  GRN=""; RED=""; YEL=""; BLD=""; NC=""
fi
declare -a SUMMARY=()
pass() { echo "${GRN}  PASS${NC}  $1"; SUMMARY+=("${GRN}PASS${NC}  $1"); }
fail() { echo "${RED}  FAIL${NC}  $1"; SUMMARY+=("${RED}FAIL${NC}  $1"); }
warn() { echo "${YEL}  WARN${NC}  $1"; SUMMARY+=("${YEL}WARN${NC}  $1"); }
note() { echo "        $1"; }
hdr()  { echo; echo "${BLD}=== $1 ===${NC}"; }

cleanup() {
  kubectl delete pod "$DBG_POD" --ignore-not-found --wait=false >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

cilsh()  { kubectl -n kube-system exec "$CIL" -c cilium-agent -- sh -c "$1" 2>/dev/null; }
dbgsh()  { kubectl exec "$DBG_POD" -- sh -c "$1" 2>&1; }
sesssh() { kubectl -n "$NS" exec "$SESS" -c "$SESS_CTR" -- sh -c "$1" 2>&1; }

# (re)create the debug pod if it is not currently Running — pods can complete or
# be evicted mid-run; every check that needs it must call this first.
# A Pending pod is left alone (it is probably still pulling the image — deleting
# it would restart the pull from scratch).
ensure_dbg() {
  local phase
  phase=$(kubectl get pod "$DBG_POD" -o jsonpath='{.status.phase}' 2>/dev/null)
  [ "$phase" = "Running" ] && return 0
  if [ "$phase" != "Pending" ]; then
    kubectl delete pod "$DBG_POD" --ignore-not-found --wait=true >/dev/null 2>&1
    kubectl run "$DBG_POD" --image="$NETSHOOT_IMAGE" --restart=Never --overrides='{
      "spec":{"hostNetwork":true,"tolerations":[{"operator":"Exists"}],
      "containers":[{"name":"c","image":"'"$NETSHOOT_IMAGE"'","command":["sleep","36000"],
      "securityContext":{"privileged":true}}]}}' >/dev/null 2>&1
  fi
  note "(waiting for debug pod — first run pulls $NETSHOOT_IMAGE, which is large; up to 300s)"
  kubectl wait --for=condition=Ready pod/"$DBG_POD" --timeout=300s >/dev/null 2>&1
}

# true if the output looks like a kubectl exec failure rather than real results
exec_failed() { grep -qiE 'cannot exec|error: unable|connection refused|not found|__CLIENT_TIMEOUT__' "$1"; }

# run "$@" writing stdout+stderr to OUTFILE, hard-killed after SECS seconds.
# kubectl exec streams cannot be bounded server-side (--request-timeout does not
# cut an active stream), so every potentially-long exec goes through this.
run_bounded() {
  local secs=$1 out=$2; shift 2
  "$@" > "$out" 2>&1 &
  local p=$! i=0
  while kill -0 "$p" 2>/dev/null; do
    i=$((i+1))
    if [ "$i" -gt "$secs" ]; then
      kill "$p" 2>/dev/null
      echo "__CLIENT_TIMEOUT__ after ${secs}s" >> "$out"
      break
    fi
    sleep 1
  done
  wait "$p" 2>/dev/null
}

# ---------------------------------------------------------------- discovery --
hdr "0. Context"
echo "  kubectl context : $(kubectl config current-context 2>/dev/null)"
CIL=$(kubectl -n kube-system get pod -l k8s-app=cilium -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
if [ -z "$CIL" ]; then echo "${RED}no cilium agent pod found — wrong context?${NC}"; exit 1; fi
NODE=$(kubectl -n kube-system get pod "$CIL" -o jsonpath='{.spec.nodeName}')
echo "  cilium agent    : $CIL (node $NODE)"
echo "  node kernel     : $(cilsh 'uname -r') ($(cilsh 'uname -m'))"
echo "  cilium version  : $(cilsh 'cilium-dbg version 2>/dev/null | head -1' | sed 's/Client: //')"
echo "  boot flag       : $(kubectl -n kube-system logs "$CIL" -c cilium-agent 2>/dev/null | grep -m1 -oE -- "--enable-bpf-tproxy='[a-z]+'")"
echo "  configmap       : kube-proxy-replacement=$(kubectl -n kube-system get cm cilium-config -o jsonpath='{.data.kube-proxy-replacement}'), datapath-mode=$(kubectl -n kube-system get cm cilium-config -o jsonpath='{.data.datapath-mode}')"

SESS=$(kubectl -n "$NS" get pods -o name 2>/dev/null | sed 's|pod/||' | grep -E '^yaac-' | grep -vE '^yaac-(proxy|reg)' | head -1)
SESS_CTR=""
if [ -n "$SESS" ]; then
  CTRS=$(kubectl -n "$NS" get pod "$SESS" -o jsonpath='{.spec.containers[*].name}')
  case " $CTRS " in *" session "*) SESS_CTR=session;; *) SESS_CTR=${CTRS%% *};; esac
  echo "  session pod     : $SESS (container: $SESS_CTR)"
else
  warn "no session pod in ns '$NS' — checks 4-6 will be skipped (start a session first)"
fi

# ------------------------------------------------- 1. rules + bound sockets --
hdr "1. TPROXY rules and listener sockets"
cilsh 'iptables -t mangle -S CILIUM_PRE_mangle 2>/dev/null' > "$TMP/rules.txt"
if ! grep -q 'j TPROXY' "$TMP/rules.txt"; then
  fail "no TPROXY rules in CILIUM_PRE_mangle at all — agent never programmed the proxy redirect"
else
  # port<TAB>name pairs for tcp TPROXY rules
  awk '/-j TPROXY/ && /-p tcp/ {
        name=""; port="";
        if (match($0, /TPROXY to host [^"]+ proxy/)) name=substr($0, RSTART+15, RLENGTH-21);
        if (match($0, /--on-port [0-9]+/))          port=substr($0, RSTART+10, RLENGTH-10);
        print port "\t" name }' "$TMP/rules.txt" > "$TMP/ports.txt"
  # core = main redirect + vcluster fallback + dns proxy; yaac-vc-* inner-redirect
  # rules accumulate as stale leftovers when vclusters churn — judge those separately
  LIVE_VC=$(kubectl get ns -o name 2>/dev/null | sed 's|namespace/||' | grep '^yaac-vc-' || true)
  CORE_BOUND=1; VC_STALE=0; VC_LIVE_UNBOUND=0
  while IFS=$'\t' read -r port name; do
    case "$name" in
      yaac-vc-*)
        if ! cilsh "ss -tln 'sport = :$port'" | grep -q LISTEN; then
          vcns=${name%%/*}
          if echo "$LIVE_VC" | grep -qx "$vcns"; then
            VC_LIVE_UNBOUND=$((VC_LIVE_UNBOUND+1))
            note "${YEL}port $port NOT BOUND <- $name (namespace still live)${NC}"
          else
            VC_STALE=$((VC_STALE+1))
          fi
        fi ;;
      *)
        if cilsh "ss -tln 'sport = :$port'" | grep -q LISTEN; then
          note "port $port BOUND     <- $name"
        else
          note "${RED}port $port NOT BOUND <- $name${NC}"; CORE_BOUND=0
        fi ;;
    esac
  done < "$TMP/ports.txt"
  [ "$VC_STALE" -gt 0 ] && note "($VC_STALE stale unbound yaac-vc-* rules for destroyed vclusters — CEC-churn leftovers, not the egress bug)"
  [ "$CORE_BOUND" = 1 ] && pass "every core TPROXY rule has a bound listener" \
                        || fail "core TPROXY rule(s) without a bound listener — envoy failed to bind (check cilium-envoy logs for 'failed to bind'/'not permitted')"
  [ "$VC_LIVE_UNBOUND" -gt 0 ] && warn "$VC_LIVE_UNBOUND unbound inner-redirect rule(s) for LIVE vclusters (superseded CEC generation?)"
fi
HTTPS_PORT=$(awk -F'\t' '$2 ~ /yaac-egress-redirect\/yaac-egress-https/ {print $1; exit}' "$TMP/ports.txt")
[ -z "${HTTPS_PORT:-}" ] && HTTPS_PORT=$(awk -F'\t' '$2 ~ /egress-https/ {print $1; exit}' "$TMP/ports.txt")
echo "  main https redirect port: ${HTTPS_PORT:-NOT FOUND}"

# --------------------------------------------- 2. IP_TRANSPARENT on sockets --
hdr "2. IP_TRANSPARENT flag on the https listener sockets (ss --inet-sockopt)"
if [ -n "${HTTPS_PORT:-}" ]; then
  cilsh "ss -tlne --inet-sockopt 'sport = :$HTTPS_PORT'" > "$TMP/ss.txt"
  sed 's/^/        /' "$TMP/ss.txt" | grep -vE '^\s*$'
  NLISTEN=$(grep -c '^LISTEN' "$TMP/ss.txt" || true)
  NTRANS=$(grep -c 'transparent' "$TMP/ss.txt" || true)
  if [ "$NLISTEN" -eq 0 ]; then
    fail "no listener on :$HTTPS_PORT"
  elif ! grep -q 'inet-sockopt' "$TMP/ss.txt"; then
    warn "this ss build did not emit inet-sockopt lines — flag unreadable here (fall back to behavioral checks)"
  elif [ "$NTRANS" -eq "$NLISTEN" ]; then
    pass "all $NLISTEN reuseport sockets on :$HTTPS_PORT have IP_TRANSPARENT"
  else
    fail "only $NTRANS of $NLISTEN sockets have IP_TRANSPARENT — privileged-service setsockopt failing (suspect AppArmor on ubuntu; see check 8)"
  fi
else
  warn "skipped (no https port found)"
fi

# --------------------------------------------------- 3. delivery-path knobs --
hdr "3. Delivery-path routing + sysctls"
IPRULE=$(cilsh "ip rule show" | grep '0x200' || true)
T2004=$(cilsh "ip route show table 2004" || true)
note "ip rule : ${IPRULE:-MISSING}"
note "tbl 2004: ${T2004:-MISSING}"
if echo "$IPRULE" | grep -q 2004 && echo "$T2004" | grep -q 'local default dev lo'; then
  pass "fwmark-0x200 -> table 2004 -> local dev lo route present"
else
  fail "proxy policy-routing missing — TPROXY'd packets cannot be delivered locally"
fi
RPF_ALL=$(cilsh 'cat /proc/sys/net/ipv4/conf/all/rp_filter')
RLN_ALL=$(cilsh 'cat /proc/sys/net/ipv4/conf/all/route_localnet')
SVM_ALL=$(cilsh 'cat /proc/sys/net/ipv4/conf/all/src_valid_mark')
note "rp_filter all=$RPF_ALL (want 0)   route_localnet all=$RLN_ALL (want 1)   src_valid_mark all=$SVM_ALL (want 0)"
if [ "$SVM_ALL" = 1 ]; then
  fail "src_valid_mark=1 — reverse-path source validation reuses the 0x200 TPROXY fwmark, hits table 2004 (local default dev lo), classifies the SOURCE as local and drops the SYN as martian (IP_LOCAL_SOURCE). Typically inherited from the host where wg-quick/VPN set it. Fix: sysctl -w net.ipv4.conf.all.src_valid_mark=0 in the NODE netns"
elif { [ "$RPF_ALL" = 0 ] && [ "$RLN_ALL" = 1 ]; }; then
  pass "sysctls match working baseline"
else
  fail "sysctl mismatch vs working baseline (rp_filter all=0, route_localnet all=1)"
fi

# ------------------------------------------------ 4. live counter delta test --
if [ -n "$SESS" ]; then
  hdr "4. Live test: $CURLS curls, TPROXY + socket-transparent counter deltas"
  snap() {
    cilsh 'iptables -t mangle -L CILIUM_PRE_mangle -v -n 2>/dev/null' | awk '
      /socket --transparent/ { printf "%s|socket-transparent-MARK\n", $1 }
      $3=="TPROXY" && $4=="tcp" {
        name=$0; sub(/.*TPROXY to host /,"",name); sub(/ proxy.*/,"",name);
        printf "%s|TPROXY %s\n", $1, name }'
  }
  snap > "$TMP/before.txt"
  run_bounded $((CURLS * 5 + 30)) "$TMP/curl4.txt" sesssh \
    "for i in \$(seq 1 $CURLS); do curl -sS --max-time 4 -o /dev/null -w '%{http_code}/%{time_total}s ' https://example.com/ 2>&1 | tail -c120; done"
  CURL_OUT=$(cat "$TMP/curl4.txt")
  note "curl results: $CURL_OUT"
  snap > "$TMP/after.txt"
  awk -F'|' 'NR==FNR{b[$2]=$1;next} { d=$1-b[$2]; if (d!=0) printf "        %+5d  %s\n", d, $2 }' \
      "$TMP/before.txt" "$TMP/after.txt" | sort -rn
  D_HTTPS=$(awk -F'|' 'NR==FNR{b[$2]=$1;next} $2 ~ /yaac-egress-redirect\/yaac-egress-https/ {print $1-b[$2]}' "$TMP/before.txt" "$TMP/after.txt" | head -1)
  D_SOCK=$(awk -F'|' 'NR==FNR{b[$2]=$1;next} $2=="socket-transparent-MARK" {print $1-b[$2]}' "$TMP/before.txt" "$TMP/after.txt")
  D_HTTPS=${D_HTTPS:-0}; D_SOCK=${D_SOCK:-0}
  note "delta: TPROXY(https)=$D_HTTPS  socket-transparent=$D_SOCK  (working: ~+$CURLS and ~+$((CURLS*9)); broken: +SYNs*retransmits and 0)"
  if echo "$CURL_OUT" | grep -qE '^(2|3)00|200/'; then
    pass "curl got HTTP responses — egress path fully working"
  elif [ "$D_HTTPS" -gt 0 ] && [ "$D_SOCK" -gt 0 ]; then
    warn "handshake completes (socket-transparent moved) but curl failed — problem is AFTER the redirect (envoy->yaac-proxy upstream)"
  elif [ "$D_HTTPS" -gt 0 ] && [ "$D_SOCK" -eq 0 ]; then
    fail "SYNs hit the TPROXY rule but no flow ever established — drop is at/after the TPROXY target (see checks 5-7)"
  elif [ "$D_HTTPS" -eq 0 ]; then
    fail "TPROXY(https) counter did not move — BPF mark/proxy-port mismatch or BPF not redirecting (restart cilium agent, re-run)"
  fi
else
  hdr "4-6. skipped (no session pod)"
fi

# ------------------------------------------------------------- debug pod up --
NEED_POD=0
[ -z "${SKIP_CAPTURE:-}" ] && [ -n "$SESS" ] && NEED_POD=1
[ -z "${SKIP_SYNTHETIC:-}" ] && NEED_POD=1
if [ "$NEED_POD" = 1 ]; then
  hdr "debug pod ($NETSHOOT_IMAGE, hostNetwork+privileged)"
  if ensure_dbg; then
    note "ready"
  else
    warn "debug pod failed to start — skipping checks 5-8"
    NEED_POD=0
  fi
fi

# --------------------------------------------------- 5. tcpdump SYN/SYN-ACK --
if [ "$NEED_POD" = 1 ] && [ -z "${SKIP_CAPTURE:-}" ] && [ -n "$SESS" ]; then
  hdr "5. Packet signature: does the transparent socket send a SYN-ACK?"
  if ! ensure_dbg; then warn "check 5 INCONCLUSIVE — debug pod unavailable"; else
  note "(capturing ~10s on the node while curling; bounded at 30s)"
  run_bounded 30 "$TMP/cap.txt" dbgsh "timeout 8 tcpdump -i any -nn -c 60 'host $SINKHOLE and tcp' 2>/dev/null" &
  CAPJOB=$!
  sleep 2
  run_bounded 20 "$TMP/curl5.txt" sesssh "for i in 1 2 3; do curl -sS --max-time 3 -o /dev/null https://example.com/ 2>/dev/null; done; true"
  wait "$CAPJOB" 2>/dev/null
  NSYN=$(grep -cE "> $SINKHOLE.443: Flags \[S\]" "$TMP/cap.txt" || true)
  NSYNACK=$(grep -cE "$SINKHOLE.443 > .*Flags \[S\.\]" "$TMP/cap.txt" || true)
  head -6 "$TMP/cap.txt" | sed 's/^/        /'
  note "SYN in: $NSYN   SYN-ACK out: $NSYNACK"
  if exec_failed "$TMP/cap.txt"; then
    warn "check 5 INCONCLUSIVE — kubectl exec failed mid-capture; re-run"
  elif [ "$NSYNACK" -gt 0 ]; then
    pass "socket answers with SYN-ACK — TCP delivery to the transparent socket works"
  elif [ "$NSYN" -gt 0 ]; then
    fail "SYNs arrive but the socket NEVER answers — kernel is not delivering to the transparent socket (see 6+7)"
  else
    warn "no packets captured — DNS may not resolve to $SINKHOLE, or traffic uses another path"
  fi
  fi
fi

# ------------------------------------------------- 6. kfree_skb drop reason --
if [ "$NEED_POD" = 1 ] && [ -z "${SKIP_CAPTURE:-}" ] && [ -n "$SESS" ]; then
  hdr "6. Kernel drop reasons during curls (skb:kfree_skb tracepoint)"
  if ! ensure_dbg; then warn "check 6 INCONCLUSIVE — debug pod unavailable"; else
  dbgsh 'mount -t tracefs tracefs /sys/kernel/tracing 2>/dev/null;
         TR=/sys/kernel/tracing; [ -f $TR/trace_pipe ] || TR=/sys/kernel/debug/tracing;
         [ -f $TR/trace_pipe ] || { echo NO_TRACEFS; exit 0; };
         echo "$TR" > /tmp/trdir; echo 1 > $TR/events/skb/kfree_skb/enable; echo ok' > "$TMP/tr.txt"
  if grep -q NO_TRACEFS "$TMP/tr.txt"; then
    warn "tracefs unavailable in debug pod — skipping drop-reason trace"
  else
    run_bounded 30 "$TMP/drops.txt" dbgsh 'TR=$(cat /tmp/trdir); timeout 7 cat $TR/trace_pipe 2>/dev/null | grep protocol=2048' &
    TRJOB=$!
    sleep 1
    run_bounded 20 "$TMP/curl6.txt" sesssh "for i in 1 2 3; do curl -sS --max-time 2 -o /dev/null https://example.com/ 2>/dev/null; done; true"
    wait "$TRJOB" 2>/dev/null
    run_bounded 20 "$TMP/tr-off.txt" dbgsh 'TR=$(cat /tmp/trdir); echo 0 > $TR/events/skb/kfree_skb/enable'
    echo "        top (reason @ kernel function) for IPv4 drops in the window:"
    sed -n 's/.*location=\([^ +]*\).*reason: \([A-Z_0-9]*\).*/\2 @ \1/p' "$TMP/drops.txt" \
      | sort | uniq -c | sort -rn | head -10 | sed 's/^/        /'
    N_NF=$(grep -c 'NETFILTER_DROP' "$TMP/drops.txt" || true)
    N_NOSOCK=$(grep -c 'NO_SOCKET' "$TMP/drops.txt" || true)
    if exec_failed "$TMP/drops.txt"; then
      warn "check 6 INCONCLUSIVE — kubectl exec failed mid-trace; re-run"
    elif [ "$N_NF" -gt 0 ]; then
      fail "NETFILTER_DROP x$N_NF — a netfilter target (the TPROXY target refusing a non-transparent/missing socket) is discarding packets"
    elif [ "$N_NOSOCK" -ge 3 ]; then
      warn "NO_SOCKET x$N_NOSOCK — possible sk-assignment loss; compare count against the working cluster (mac baseline was 5 ambient)"
    else
      note "no smoking-gun drop reason (ambient drops only — this matches the working baseline)"
    fi
  fi
  fi
fi

# ------------------------------------------- 7. synthetic kernel-only test --
if [ "$NEED_POD" = 1 ] && [ -z "${SKIP_SYNTHETIC:-}" ]; then
  hdr "7. Synthetic TPROXY test (kernel only — no cilium/envoy involved)"
  if ! ensure_dbg; then warn "check 7 INCONCLUSIVE — debug pod unavailable"; else
  note "(bounded at 120s)"
  run_bounded 120 "$TMP/synth.txt" dbgsh '
    ip link del vtp0 2>/dev/null; ip netns del tpns 2>/dev/null
    iptables -t mangle -D PREROUTING -i vtp0 -p tcp -d 198.18.0.99 -j TPROXY --on-port 12399 --on-ip 127.0.0.1 --tproxy-mark 0x200/0xffffffff 2>/dev/null
    set -e
    ip netns add tpns
    ip link add vtp0 type veth peer name vtp1
    ip link set vtp1 netns tpns
    ip addr add 10.199.0.1/30 dev vtp0; ip link set vtp0 up
    sysctl -qw net.ipv4.conf.vtp0.rp_filter=0
    ip netns exec tpns sh -c "ip addr add 10.199.0.2/30 dev vtp1; ip link set vtp1 up; ip link set lo up; ip route add default via 10.199.0.1"
    iptables -t mangle -I PREROUTING 1 -i vtp0 -p tcp -d 198.18.0.99 -j TPROXY --on-port 12399 --on-ip 127.0.0.1 --tproxy-mark 0x200/0xffffffff
    socat -T5 TCP-LISTEN:12399,bind=127.0.0.1,ip-transparent,reuseaddr,fork EXEC:"echo TPROXY-OK" 2>/dev/null &
    sleep 1
    ip netns exec tpns sh -c "echo ping | timeout 4 nc 198.18.0.99 443; echo nc_exit=\$?"
    iptables -t mangle -L PREROUTING 1 -v -n | tail -1
    iptables -t mangle -D PREROUTING -i vtp0 -p tcp -d 198.18.0.99 -j TPROXY --on-port 12399 --on-ip 127.0.0.1 --tproxy-mark 0x200/0xffffffff
    pkill socat 2>/dev/null || true; ip netns del tpns; ip link del vtp0 2>/dev/null || true
  '
  sed 's/^/        /' "$TMP/synth.txt" | grep -viE 'socat\[|^$'
  if grep -q TPROXY-OK "$TMP/synth.txt"; then
    pass "kernel TPROXY -> transparent socket delivery WORKS on this node"
  elif grep -q 'nc_exit=' "$TMP/synth.txt"; then
    # the test genuinely ran (nc executed) and TPROXY-OK never arrived
    fail "kernel TPROXY delivery BROKEN with zero cilium involvement — kernel-level confirmation (report with this reproducer; try an older kernel or a podman-machine VM)"
  else
    warn "check 7 INCONCLUSIVE — the synthetic test never ran (exec/pod failure above); re-run"
  fi
  fi
fi

# ------------------------------------------------------ 8. AppArmor denials --
if [ "$NEED_POD" = 1 ]; then
  hdr "8. AppArmor / LSM denials on the host (ubuntu-specific suspect)"
  if ! ensure_dbg; then warn "check 8 INCONCLUSIVE — debug pod unavailable"; else
  # fetch raw denial lines once, grep locally so exec errors can't masquerade as findings
  run_bounded 30 "$TMP/dmesg.txt" dbgsh 'dmesg 2>/dev/null | grep -i denied | tail -50; echo __DMESG_DONE__'
  if ! grep -q __DMESG_DONE__ "$TMP/dmesg.txt" || exec_failed "$TMP/dmesg.txt"; then
    warn "check 8 INCONCLUSIVE — could not read dmesg from the debug pod; re-run"
  else
    ENVOY_DENIED=$(grep -iE 'envoy|cilium|setsockopt' "$TMP/dmesg.txt" | grep -v __DMESG_DONE__ || true)
    AA=$(grep -i apparmor "$TMP/dmesg.txt" | grep -v __DMESG_DONE__ | tail -5 || true)
    if [ -n "$ENVOY_DENIED" ]; then
      fail "LSM denial mentions envoy/cilium/setsockopt — this can block IP_TRANSPARENT:"
      echo "$ENVOY_DENIED" | tail -5 | sed 's/^/        /'
    elif [ -n "$AA" ]; then
      warn "AppArmor denials present (none mention envoy — likely unrelated, but review):"
      echo "$AA" | sed 's/^/        /'
    else
      pass "no relevant LSM denials in dmesg"
    fi
  fi
  fi
fi

# -------------------------------------------------------------------- recap --
hdr "SUMMARY"
for line in "${SUMMARY[@]}"; do echo "  $line"; done
cat <<'EOF'

  How to read a broken run:
    check 2 FAIL                  -> envoy/privileged-service can't set IP_TRANSPARENT
                                     (AppArmor? see check 8) — not a kernel bug.
    checks 2,3 PASS + 7 FAIL      -> kernel TPROXY regression CONFIRMED, cilium exonerated.
                                     Reproducer = check 7. Try older kernel / podman-machine VM.
    checks 2,3,7 PASS + 5 FAIL    -> kernel + envoy fine in isolation; cilium-specific
                                     (BPF mark path / sk_assign) — compare check 4 deltas
                                     and check 6 drop reasons.
    check 4 "counter did not move"-> stale proxy-port/mark after restart; bounce cilium
                                     agent and re-run.
EOF
