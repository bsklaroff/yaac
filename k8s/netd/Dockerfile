FROM docker.io/node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY netd.ts /app/netd.ts
COPY k8s-watch.ts /app/k8s-watch.ts
COPY swap.ts /app/swap.ts
COPY pressure.ts /app/pressure.ts
# Runs as root, to write the node's cgroup files.
CMD ["node_modules/.bin/tsx", "/app/netd.ts"]
