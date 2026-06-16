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
# a 0666 socket alongside it (socat) so user-namespaced session pods —
# whose idmapped view of the agent socket shows its owner as an unmapped
# uid — can still connect.
RUN mkdir -p /ssh-agent && chown node:node /ssh-agent
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY proxy.ts /app/proxy.ts
COPY ca-bundle.ts /app/ca-bundle.ts
COPY transparent.ts /app/transparent.ts
COPY pp2.ts /app/pp2.ts
COPY pod-watch.ts /app/pod-watch.ts
COPY dns-stub.ts /app/dns-stub.ts
COPY torrc /etc/tor/torrc
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
USER node
EXPOSE 10255
CMD ["/app/entrypoint.sh"]
