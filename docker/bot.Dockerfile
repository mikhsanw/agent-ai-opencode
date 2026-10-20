# Telegram bot image (pinned version, installed from the lockfile).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/otb/bot
COPY deploy/bot/package.json deploy/bot/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

RUN groupadd --gid 10002 bot \
 && useradd --uid 10002 --gid 10002 --home-dir /data --shell /usr/sbin/nologin bot \
 && install -d -m 0700 -o 10002 -g 10002 /data

ENV NODE_ENV=production \
    HOME=/data \
    OPENCODE_TELEGRAM_HOME=/data

USER 10002:10002
WORKDIR /data
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "/opt/otb/bot/node_modules/@grinev/opencode-telegram-bot/dist/cli.js", "start"]
