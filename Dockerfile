FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git procps \
  && npm ci --omit=dev \
  && npm install -g @anthropic-ai/claude-code@2.1.96 \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY README.md AGENTS.md ./
COPY src ./src
COPY docs ./docs

ENV NODE_ENV=production

EXPOSE 8765

ENTRYPOINT ["node", "./src/cli.js"]
CMD ["control", "start", "--host", "0.0.0.0", "--port", "8765", "--data-dir", "/data/control"]
