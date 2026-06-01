FROM node:20-bookworm

# Install Chromium + fonts (same as production Dockerfile)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    wget \
    git \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm

# Point Puppeteer to system Chromium (skip bundled download)
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
