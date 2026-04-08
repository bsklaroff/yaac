FROM docker.io/node:22.22.2-slim
RUN mkdir -p /data && chown node:node /data
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY proxy.mjs /app/proxy.mjs
USER node
EXPOSE 10255
CMD ["node", "proxy.mjs"]
