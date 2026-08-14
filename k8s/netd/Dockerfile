FROM docker.io/node:22.22.2-slim
# iptables: netd programs its redirect chain through the SAME backend the
# node uses. Debian ships both iptables-legacy and iptables-nft here, and
# netd probes at startup for whichever carries Calico's chains — a kind
# node's alternative points at legacy, so assuming nft would silently
# write a chain nothing consults.
# iproute2: the Calico per-workload host routes are how netd resolves a
# pod IP to the veth its frames arrive on (see routes.ts).
# conntrack: triage only — inspecting the translations the DNAT rules
# create. Nothing flushes them: every pod is DNAT'd to the same per-install
# listener trio and the target is chosen inside Envoy from the source pod
# IP, so a pod's egress target can flip without its ports ever moving.
RUN apt-get update \
    && apt-get install -y --no-install-recommends iptables iproute2 conntrack \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY netd.ts /app/netd.ts
COPY targets.ts /app/targets.ts
COPY cidr.ts /app/cidr.ts
COPY routes.ts /app/routes.ts
COPY rules.ts /app/rules.ts
COPY ports.ts /app/ports.ts
COPY iptables.ts /app/iptables.ts
COPY envoy-config.ts /app/envoy-config.ts
COPY envoy-admin.ts /app/envoy-admin.ts
COPY listeners.ts /app/listeners.ts
COPY k8s-watch.ts /app/k8s-watch.ts
# Runs as root in the host network namespace: programming nat rules needs
# CAP_NET_ADMIN, which the DaemonSet grants narrowly (no privileged: true).
CMD ["node_modules/.bin/tsx", "/app/netd.ts"]
