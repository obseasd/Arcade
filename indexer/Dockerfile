# Portable container for the Arcade Ponder indexer. Works on Railway, Render,
# Fly.io, or any Docker host. Ponder serves its HTTP API (/trades, /candles,
# /health) and follows the chain head; point it at a persistent Postgres via
# DATABASE_URL and a dedicated Arc RPC via PONDER_RPC_URL_5042002.
#
# Build:  docker build -t arcade-indexer .
# Run:    docker run --env-file .env.local -p 42069:42069 arcade-indexer
#
# All config is via env (see .env.example). Ponder binds its server to $PORT
# when set (Railway/Render inject it); defaults to 42069 otherwise.

FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# App source.
COPY . .

# Generate the ponder:* virtual-module types (safe, no network/DB needed).
RUN npx ponder codegen

# Ponder's default server port; hosts that set $PORT override it at runtime.
ENV PORT=42069
EXPOSE 42069

# `ponder start` = production mode: backfill from the start blocks, then follow
# the head, serving the API. (Use `ponder dev` only for local hot-reload.)
# `ponder start` does NOT read $PORT automatically -- it defaults to 42069 -- so
# pass it explicitly for hosts (Railway/Render) that inject a dynamic $PORT.
# Hostname defaults to 0.0.0.0, correct for a container.
CMD ["sh", "-c", "npx ponder start --port ${PORT:-42069}"]
