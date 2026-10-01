FROM docker.io/node:24.21.0-slim
# iptables: ships both legacy and nft backends; netd picks at startup
# whichever one holds Calico's chains, since writing to the other would
# have no effect.
# iproute2: netd maps a pod IP to its veth via Calico's host routes
# (see routes.ts).
# conntrack: for debugging the DNAT translations only; netd never flushes
# them.
RUN apt-get update \
    && apt-get install -y --no-install-recommends iptables iproute2 conntrack \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY netd.ts /app/netd.ts
COPY targets.ts /app/targets.ts
COPY routes.ts /app/routes.ts
COPY rules.ts /app/rules.ts
COPY ports.ts /app/ports.ts
COPY iptables.ts /app/iptables.ts
COPY envoy-config.ts /app/envoy-config.ts
COPY envoy-admin.ts /app/envoy-admin.ts
COPY listeners.ts /app/listeners.ts
COPY k8s-watch.ts /app/k8s-watch.ts
# Runs as root in the host network namespace. Writing nat rules needs
# CAP_NET_ADMIN, which the DaemonSet grants without privileged: true.
CMD ["node_modules/.bin/tsx", "/app/netd.ts"]
