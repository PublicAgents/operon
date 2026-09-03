# The wake container: Node 24, git, and the harness CLIs, nothing else.
# The webroot-holds-no-secrets posture, container edition: the image bakes
# in no credentials; everything sensitive arrives per-wake via env from the
# WakeContainer Durable Object.

# Digest-pinned: image content is a pure function of this file and the
# sources it copies, which is what the fleet deploy's drain gate relies
# on. Bump the digest deliberately, as a reviewed change.
FROM node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
COPY tsconfig.docker.json ./tsconfig.json
COPY src ./src
RUN npm install typescript@6.0.3 @types/node@24.13.3 && npx tsc

FROM node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
# The shell tools a mind reaches for (spec 0010 §4): ripgrep, jq and fd
# beside git, curl and python. Claude Code bundles its own search;
# Codex works through the shell and its first wake found rg and jq
# missing. Debian names fd's binary fdfind; the link gives it its name.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl python3 ripgrep jq fd-find \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*
# gitleaks: pinned version + checksum. Its config is baked into the image
# (never read from the scanned repo, which is agent-writable).
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
RUN curl -fsSL -o /tmp/gitleaks.tar.gz \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
  && echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks \
  && rm /tmp/gitleaks.tar.gz \
  && gitleaks version
# Pinned exactly: the image content must be a pure function of these
# sources, because the fleet deploy's drain gate hashes them to decide
# whether an image roll (and therefore a wake drain) is needed. Both
# harness CLIs live in the one image (spec 0010 §6): a wake picks its
# harness, so the image must carry every adapter's CLI.
RUN npm install -g @anthropic-ai/claude-code@2.1.251 @openai/codex@0.153.0 @playwright/mcp@0.0.80
# The local browser (spec 0004 §9): Google Chrome, driven through the
# Playwright MCP server above, for unauthenticated browsing through the
# session's egress. Google publishes the stable channel unpinned, like
# the apt packages above; the version rides the image build's date.
RUN curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
  && apt-get update \
  && apt-get install -y --no-install-recommends /tmp/chrome.deb fonts-liberation \
  && rm -f /tmp/chrome.deb \
  && rm -rf /var/lib/apt/lists/* \
  && google-chrome-stable --version
# Claude Code's managed settings (spec 0010 §3): root-owned, above every
# other settings file, unwritable by the mind. The same off switches the
# adapter puts in the session environment, a layer the mind cannot edit.
COPY managed-settings.json /etc/claude-code/managed-settings.json
RUN chmod 644 /etc/claude-code/managed-settings.json
# The mind session runs as this unprivileged user; the entrypoint stays
# root so the session cannot read the supervisor's /proc environment or
# argv (see entrypoint.ts, privilege split).
RUN useradd --create-home --uid 1001 mind
COPY --from=build /app/dist /opt/operon
COPY gitleaks.toml /opt/operon/gitleaks.toml
# The wake's door handle: a thin client for the entrypoint's loopback
# porch; it holds no credentials (see porch.ts).
RUN printf '#!/bin/sh\nexec node /opt/operon/cli.js "$@"\n' > /usr/local/bin/operon \
  && chmod +x /usr/local/bin/operon
WORKDIR /root
ENTRYPOINT ["node", "/opt/operon/entrypoint.js"]
