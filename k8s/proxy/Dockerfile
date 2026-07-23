FROM docker.io/node:22.22.2-slim
# ca-certificates: provides /etc/ssl/certs/ca-certificates.crt, the public
# roots the /ca-bundle.pem endpoint folds together with the MITM CA into the
# combined trust bundle nested containers use (see k8s/proxy/ca-bundle.ts).
RUN apt-get update \
    && apt-get install -y --no-install-recommends tor openssh-client socat ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data && chown node:node /data
# The ssh-agent socket lives in /ssh-agent (a shared hostPath volume).
# entrypoint.sh runs the real agent on a private socket here and bridges
# a 0666 socket alongside it (socat). Still required under gVisor (which
# replaced the userns/idmap era): the socket is a real host socket via
# the runsc handlers' host-uds=all, dialed cross-sandbox by session pods
# whose users (the session uid, or in-sandbox root) don't match the
# proxy's node user — without the world-writable bridge those connects
# fail EACCES and git-over-ssh breaks in every session.
RUN mkdir -p /ssh-agent && chown node:node /ssh-agent
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY proxy.ts /app/proxy.ts
COPY tool-providers.generated.ts /app/tool-providers.generated.ts
COPY tools-report.ts /app/tools-report.ts
COPY ca-bundle.ts /app/ca-bundle.ts
COPY transparent.ts /app/transparent.ts
COPY pp2.ts /app/pp2.ts
COPY pod-watch.ts /app/pod-watch.ts
COPY dns-stub.ts /app/dns-stub.ts
COPY activator.ts /app/activator.ts
COPY activator-main.ts /app/activator-main.ts
COPY secure-compare.ts /app/secure-compare.ts
COPY spawn-queue.ts /app/spawn-queue.ts
COPY torrc /etc/tor/torrc
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
USER node
EXPOSE 10255
CMD ["/app/entrypoint.sh"]
