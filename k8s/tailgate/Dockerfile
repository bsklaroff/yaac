FROM docker.io/node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY *.ts /app/
# uid 1000, which the tailnet tunnel's pod runs both containers as, so
# tailgate can use tailscaled's socket.
USER node
CMD ["node_modules/.bin/tsx", "/app/main.ts"]
