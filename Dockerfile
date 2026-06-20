# Deploy image for fleet-kb (Coolify). Additive deploy-infra — does not change app code.
# muninn runs TS directly via Bun; bun:sqlite is built-in, @lancedb/lancedb ships prebuilt
# linux-x64-gnu binaries, pg is pure JS — so no compile toolchain needed.
FROM oven/bun:1-slim
WORKDIR /app

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
