FROM node:22-bookworm-slim

# Chromium + fonts + the libs Puppeteer needs (the puppeteer npm package's
# bundled Chromium is x64-only and Mac mini M4 is arm64, so we install
# Debian's Chromium and tell Puppeteer to use it).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      tzdata \
      fonts-noto-core \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      fonts-noto-extra \
      fonts-liberation \
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libasound2 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV TZ=Asia/Jerusalem

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# data/ is mounted as a volume at runtime so the SQLite DB survives restarts
RUN mkdir -p /app/data

EXPOSE 3030

CMD ["node", "src/server.js"]
