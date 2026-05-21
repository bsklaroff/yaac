FROM docker.io/node:22.22.2-slim
ARG SSL_CERT_FILE
RUN apt-get update \
    && apt-get install -y --no-install-recommends tor \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data && chown node:node /data
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
