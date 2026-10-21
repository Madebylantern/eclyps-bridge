# Always-on finisher, testnet or mainnet (finisher/RAILWAY.md). Build context: the repo root.
FROM node:24-bookworm-slim

ENV CI=true ECLYPS_DATA_DIR=/data
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Only what the finisher needs is installed: sdk, the committed Aztec bindings, the finisher.
# (Every workspace manifest is copied so the frozen lockfile matches; the filter skips the rest.)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY sdk/package.json sdk/
COPY aztec/package.json aztec/
COPY finisher/package.json finisher/
COPY scripts/package.json scripts/
COPY app/package.json app/
RUN pnpm install --frozen-lockfile --filter "@eclyps/finisher..."

COPY sdk sdk
COPY aztec/artifacts aztec/artifacts
COPY finisher finisher
COPY deployments deployments

WORKDIR /app/finisher
# `pnpm start`: NETWORK picks testnet (default) or mainnet (which also needs DEPLOYMENT and
# ECLYPS_MAINNET_OK=1, finisher/src/network.ts). The volume is mounted at /data (state, Aztec
# keys, wallet database). A stale lock from the last run is cleared.
CMD ["sh", "-c", "mkdir -p \"$ECLYPS_DATA_DIR\" && rm -f \"$ECLYPS_DATA_DIR\"/*.lock && exec pnpm start"]
