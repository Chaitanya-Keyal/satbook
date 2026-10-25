# satbook: build with Bun, run the adapter-node bundle on the Bun runtime (bun:sqlite
# needs it). Deploying: docs/self-hosting.md.
# Bun is pinned by digest to the release CI tests with (.github/workflows/ci.yml);
# bump both together.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun --bun run build

# Runtime dependencies only: adapter-node bundles the devDependencies into the build.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

ENV DATABASE_PATH=/data/btc.db \
    MIGRATIONS_PATH=/app/drizzle \
    PORT=3000 \
    NODE_ENV=production
# Runs as the image's unprivileged bun user (uid 1000). A new data volume starts
# out owned by it; for an existing one, or secret files owned by someone else,
# see docs/self-hosting.md.
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "./build/index.js"]
