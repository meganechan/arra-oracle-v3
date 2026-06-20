# Deploy image for fleet-kb (Coolify). Additive deploy-infra — does not change app code.
# Build tools needed: better-sqlite3 compiles via node-gyp (python3/make/g++);
# @lancedb/lancedb + sqlite-vec use prebuilt binaries. bun:sqlite is built-in.
FROM oven/bun:1-slim
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

ENV PORT=47778 \
    ORACLE_PORT=47778 \
    HOME=/data \
    ORACLE_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 47778

CMD ["bun", "src/server.ts"]
