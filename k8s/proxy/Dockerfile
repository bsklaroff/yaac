FROM docker.io/node:22.22.2-slim
ARG SSL_CERT_FILE
RUN apt-get update \
    && apt-get install -y --no-install-recommends tor openssh-client socat \
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
RUN if [ -n "$SSL_CERT_FILE" ] && [ -f "$SSL_CERT_FILE" ]; then \
      NODE_EXTRA_CA_CERTS="$SSL_CERT_FILE" npm install --omit=dev; \
    else \
      npm install --omit=dev; \
    fi
COPY proxy.ts /app/proxy.ts
COPY torrc /etc/tor/torrc
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
USER node
EXPOSE 10255
CMD ["/app/entrypoint.sh"]
