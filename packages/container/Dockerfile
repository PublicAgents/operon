# The wake container: Node 24, git, and the harness CLIs, nothing else.
# The webroot-holds-no-secrets posture, container edition: the image bakes
# in no credentials; everything sensitive arrives per-wake via env from the
# WakeContainer Durable Object.

FROM node:24-slim AS build
WORKDIR /app
COPY tsconfig.docker.json ./tsconfig.json
COPY src ./src
RUN npm install typescript@6 @types/node@24 && npx tsc

FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
RUN useradd --create-home agent
COPY --from=build /app/dist /opt/operon
USER agent
WORKDIR /home/agent
ENTRYPOINT ["node", "/opt/operon/entrypoint.js"]
