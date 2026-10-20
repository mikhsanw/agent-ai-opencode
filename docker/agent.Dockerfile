# OpenCode agent image. Add the toolchains your projects need (php, composer,
# python...) in the apt-get line below; the container cannot install them at runtime.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates dumb-init openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/otb/agent
COPY deploy/agent/package.json deploy/agent/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

RUN groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --home-dir /home/agent --create-home --shell /usr/sbin/nologin agent

USER 10001:10001
WORKDIR /srv/workspace
ENTRYPOINT ["dumb-init", "--"]
CMD ["/opt/otb/agent/node_modules/.bin/opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
