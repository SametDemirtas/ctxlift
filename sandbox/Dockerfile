# Agent sandbox: Python (uv), Node and Claude Code. Runs as the calling user's uid with a throwaway home.
FROM ghcr.io/astral-sh/uv:0.9.30-python3.12-bookworm-slim
ARG NODE_VERSION=24.11.1
ARG CLAUDE_CODE_VERSION=2.1.328
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils \
 && NODE_ARCH=$(dpkg --print-architecture | sed 's/amd64/x64/') \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz\$" | sha256sum -c - \
 && tar -xJf "node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -C /usr/local --strip-components=1 \
 && rm "node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && apt-get purge -y curl xz-utils && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* /root/.npm
COPY proxy.mjs /opt/ctxlift/proxy.mjs
ENV HOME=/home/agent CLAUDE_CONFIG_DIR=/home/agent/.claude UV_CACHE_DIR=/home/agent/.cache/uv
WORKDIR /workspace
