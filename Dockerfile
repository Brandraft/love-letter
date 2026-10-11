# Build: podman build -t love-letter .
# Run:   podman run -p 127.0.0.1:8080:8080 -v love-letter-data:/data -e BASE_URL=https://example.com love-letter
FROM docker.io/library/node:24-slim AS build
RUN npm install -g pnpm@12.10.1 --no-audit --no-fund
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

FROM docker.io/library/node:24-slim
RUN npm install -g pnpm@12.10.1 --no-audit --no-fund
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter @love-letter/server... \
 && npm uninstall -g pnpm && npm cache clean --force
COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "packages/server/dist/main.js"]
