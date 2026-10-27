FROM node:22-bookworm-slim

ARG YTDLP_VERSION=2026.10.26

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PYTHONUNBUFFERED=1 \
    VENV_PATH=/opt/yt-dlp-venv \
    CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg chromium fonts-liberation python3 python3-venv ca-certificates tini \
    && python3 -m venv "$VENV_PATH" \
    && "$VENV_PATH/bin/pip" install --no-cache-dir --upgrade pip "yt-dlp==$YTDLP_VERSION" \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="$VENV_PATH/bin:$PATH"

COPY package*.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY . .

RUN mkdir -p /app/downloads \
    && chown -R node:node /app

USER node

ENTRYPOINT ["tini", "--"]
CMD ["npm", "start"]
