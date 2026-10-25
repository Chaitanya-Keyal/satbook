# satbook: build with Bun, run the adapter-node bundle on the Bun runtime (bun:sqlite
# needs it). Deploying: docs/self-hosting.md.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun --bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

ENV DATABASE_PATH=/data/btc.db \
    MIGRATIONS_PATH=/app/drizzle \
    PORT=3000 \
    NODE_ENV=production
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "./build/index.js"]
