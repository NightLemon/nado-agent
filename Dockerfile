# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./

RUN --mount=type=cache,id=nado-npm-cache,target=/root/.npm,sharing=locked \
  npm ci --omit=dev --prefer-offline \
    --fetch-retries=5 \
    --fetch-retry-factor=2 \
    --fetch-retry-mintimeout=1000 \
    --fetch-retry-maxtimeout=30000

COPY README.md AGENTS.md ./
COPY src ./src
COPY docs ./docs

ENV NODE_ENV=production

EXPOSE 8765

ENTRYPOINT ["node", "./src/cli.js"]
CMD ["control", "start", "--host", "0.0.0.0", "--port", "8765", "--data-dir", "/data/control"]

# The public VM runs this target. It intentionally contains neither a terminal
# Agent CLI nor Worker-only process inspection tools.
FROM runtime AS control

ENV HOME=/home/node \
  USER=node

COPY deploy/docker/control-entrypoint.sh /usr/local/bin/nado-control-entrypoint
RUN chmod 0755 /usr/local/bin/nado-control-entrypoint

ENTRYPOINT ["nado-control-entrypoint"]

# Home/lab Workers use this target when they need the bundled Claude preset.
# Keeping it last preserves the historical `docker build .` Worker-capable image.
FROM runtime AS worker

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git procps \
  && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,id=nado-npm-cache,target=/root/.npm,sharing=locked \
  npm install -g @anthropic-ai/claude-code@2.1.96 \
    --prefer-offline \
    --fetch-retries=5 \
    --fetch-retry-factor=2 \
    --fetch-retry-mintimeout=1000 \
    --fetch-retry-maxtimeout=30000
