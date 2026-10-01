FROM docker.io/node:24.21.0-slim
# ca-certificates provides the public roots for the combined trust bundle
# (see ca-bundle.ts).
RUN apt-get update \
    && apt-get install -y --no-install-recommends tor openssh-client socat ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY proxy.ts /app/proxy.ts
COPY tool-providers.generated.ts /app/tool-providers.generated.ts
COPY ca-bundle.ts /app/ca-bundle.ts
COPY transparent.ts /app/transparent.ts
COPY pp2.ts /app/pp2.ts
COPY pod-watch.ts /app/pod-watch.ts
COPY dns-stub.ts /app/dns-stub.ts
COPY secure-compare.ts /app/secure-compare.ts
COPY refresh-flight.ts /app/refresh-flight.ts
COPY live-tunnels.ts /app/live-tunnels.ts
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
