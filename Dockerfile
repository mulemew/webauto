# =============================================================
# AutoOps — single container (API + Web UI + bundled Chromium)
# Includes Patchright's patched Chromium for the "local" browser provider.
# Also works with remote CDP services (browserless, etc.) via the
# "playwright" or "puppeteer" provider settings.
# =============================================================

# ─── Stage 1: Build web UI ───────────────────────────────────
# --platform=$BUILDPLATFORM: compile JS on the build host (amd64) natively.
# The Vite/Rollup output is pure JS — platform-agnostic — so this is safe.
FROM --platform=$BUILDPLATFORM node:20-bookworm AS web-builder

WORKDIR /workspace
RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib/ lib/
COPY artifacts/web-ui/ artifacts/web-ui/

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile

ENV BASE_PATH=/ NODE_ENV=production
RUN pnpm --filter @workspace/web-ui run build

# ─── Stage 2: Build API server ───────────────────────────────
FROM --platform=$BUILDPLATFORM node:20-bookworm AS api-builder

WORKDIR /workspace
RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib/ lib/
COPY artifacts/api-server/ artifacts/api-server/

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

# ─── Stage: sing-box binary source ───────────────────────────
# SagerNet publishes an official multi-arch image on ghcr.io (the same registry
# this workflow already authenticates to and caches against). Copying the binary
# from it is far more reliable in CI than downloading the release tarball from
# github.com, whose asset CDN intermittently times out and broke the build.
# buildx resolves this FROM per target platform, so each arch gets its own binary.
FROM ghcr.io/sagernet/sing-box:v1.11.4 AS singbox

# ─── Stage 3: Production runtime ─────────────────────────────
FROM node:20-bookworm-slim AS runner

# Install system dependencies required by Chromium + wget for healthcheck.
# These are the libraries Playwright's Chromium needs at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    # xdotool + Xvfb + window manager — required for OS-level mouse clicks (bypasses CF Turnstile)
    xdotool xvfb x11-utils fluxbox \
    # Chromium runtime dependencies
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libdbus-1-3 libxkbcommon0 libatspi2.0-0 \
    libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libxshmfence1 \
    # Fonts — needed for proper text rendering in screenshots
    fonts-liberation fonts-noto-color-emoji \
    fonts-noto-cjk fonts-wqy-microhei fonts-wqy-zenhei \
  && rm -rf /var/lib/apt/lists/*

# ─── sing-box (advanced proxy protocols: VLESS/VMess/Trojan/Hysteria2/WARP) ───
# The proxy-manager starts sing-box on demand to expose a local SOCKS5 inbound
# that Chromium can consume. Passthrough http/socks5 proxies do NOT need this.
#
# The binary is copied from SagerNet's official multi-arch image (see the
# "singbox" stage above) rather than downloaded at build time — the release
# CDN on github.com intermittently times out and silently broke the image
# (it shipped WITHOUT sing-box, so every advanced-proxy task failed at runtime
# with "sing-box is not installed on this host"). We still verify the binary
# actually runs so a broken build never reaches production.
COPY --from=singbox /usr/local/bin/sing-box /usr/local/bin/sing-box
RUN set -eux; \
    chmod +x /usr/local/bin/sing-box; \
    /usr/local/bin/sing-box version

WORKDIR /app

# Install puppeteer, playwright-core, and patchright.
# puppeteer: skip download — used only for remote CDP connections.
# patchright: installs its patched Chromium for the "local" browser provider.
COPY artifacts/api-server/package.json ./package-src.json
RUN node -e "\
  const p = JSON.parse(require('fs').readFileSync('./package-src.json', 'utf-8'));\
  const out = { name: 'autoops', version: '1.0.0', type: 'module',\
    dependencies: {\
      puppeteer: p.dependencies.puppeteer,\
      'playwright-core': p.dependencies['playwright-core'],\
      'patchright': p.dependencies['patchright']\
    }\
  };\
  require('fs').writeFileSync('./package.json', JSON.stringify(out, null, 2));\
  " && rm package-src.json

ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm install --omit=dev

# Install Patchright's patched Chromium (used by the "local" provider).
# Patchright patches Chromium at the binary level — no JS injection — so it
# passes Cloudflare Turnstile invisible natively without any extra tricks.
RUN npx patchright install chromium

# API bundle (pino workers are included by esbuild-plugin-pino)
COPY --from=api-builder /workspace/artifacts/api-server/dist ./dist

# Web UI static assets — Express serves these from dist/public at runtime
COPY --from=web-builder /workspace/artifacts/web-ui/dist/public ./dist/public

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data/screenshots

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/healthz || exit 1

# Start Xvfb (virtual display) before the Node process so the local browser
# provider can launch Chromium in headed mode. Headed mode is critical for
# bypassing Cloudflare Turnstile — headless is detectable. Also enables
# xdotool for OS-level mouse clicks that CF cannot distinguish from human input.
CMD ["sh", "-c", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null; Xvfb :99 -screen 0 1920x1080x24 -ac &>/dev/null & export DISPLAY=:99 && sleep 0.5 && fluxbox &>/dev/null & sleep 0.5 && exec node --enable-source-maps dist/index.mjs"]
