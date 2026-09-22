FROM docker.io/node:22.22.2-slim
# ca-certificates: provides /etc/ssl/certs/ca-certificates.crt, the public
# roots the proxy folds together with the MITM CA into the combined trust
# bundle nested containers use (see k8s/proxy/ca-bundle.ts).
RUN apt-get update \
    && apt-get install -y --no-install-recommends tor openssh-client socat ca-certificates \
    && rm -rf /var/lib/apt/lists/*
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
COPY secure-compare.ts /app/secure-compare.ts
COPY objects.ts /app/objects.ts
COPY object-watch.ts /app/object-watch.ts
COPY agent-keys.ts /app/agent-keys.ts
COPY mama-queue.ts /app/mama-queue.ts
COPY ssh-agent-relay.ts /app/ssh-agent-relay.ts
COPY torrc /etc/tor/torrc
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
USER node
EXPOSE 10255
CMD ["/app/entrypoint.sh"]
