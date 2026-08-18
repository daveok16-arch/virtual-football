# Dockerfile for the virtual-football prediction bot.
# Installs Chromium + its shared libs so puppeteer can run headless on Render.
FROM node:20-slim

# Chromium runtime dependencies required by headless Chrome.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install npm deps first (cached layer).
COPY package.json package-lock.json* ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev || npm install --omit=dev

# App source.
COPY . .

# Use the system Chromium installed above (skip the bundled download).
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

EXPOSE 10000
# Cap Node.js heap at 384MB and expose GC for manual memory management.
# The --expose-gc flag makes global.gc() available so the 5-min cache flush
# can force a GC cycle to reclaim cleared WS payloads before Render's OOM killer hits.
CMD ["node", "--expose-gc", "--max-old-space-size=384", "bot-runner.js"]
