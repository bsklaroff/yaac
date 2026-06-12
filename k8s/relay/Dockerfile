# Pure Node relay (no native code) — runs the TypeScript directly via tsx,
# matching the proxy image's pattern. Alpine base for a small footprint;
# it shares no layers with the proxy's slim base, but the relay is tiny.
FROM docker.io/library/node:22.22.2-alpine
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY relay.ts pp2-frame.ts dns-stub.ts /app/
# uid 1337 (Istio's convention for the proxy uid) — distinct from the
# session image's yaac user so the workload container cannot read the
# relay's token env. The pod securityContext also pins runAsUser: 1337.
USER 1337
CMD ["./node_modules/.bin/tsx", "relay.ts"]
