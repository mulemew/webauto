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

# Minimal system deps. The app container no longer runs a local browser — all
# browsing goes to the cf-proxy sidecar (SeleniumBase) or a remote CDP service —
# so Chromium's runtime libs, Xvfb/xdotool/fluxbox and screenshot fonts are gone.
# This is what makes the image small and the build fast.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # wget — healthcheck
    wget \
    # curl — /tasks/:id/proxy-geo queries the exit IP's geolocation THROUGH the
    # configured proxy (handles socks5:// and http:// uniformly, unlike undici).
    curl \
    # tini — PID-1 init that reaps orphaned sing-box helpers
    tini \
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

# Install puppeteer + playwright-core ONLY for the remote-CDP providers
# (playwright/puppeteer connect to an external browser service — no local browser
# is downloaded). The "local" Patchright provider was removed, so patchright and
# its bundled Chromium are no longer installed — this is the bulk of the size/
# build-time savings.
COPY artifacts/api-server/package.json ./package-src.json
RUN node -e "\
  const p = JSON.parse(require('fs').readFileSync('./package-src.json', 'utf-8'));\
  const out = { name: 'autoops', version: '1.0.0', type: 'module',\
    dependencies: {\
      puppeteer: p.dependencies.puppeteer,\
      'playwright-core': p.dependencies['playwright-core']\
    }\
  };\
  require('fs').writeFileSync('./package.json', JSON.stringify(out, null, 2));\
  " && rm package-src.json

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev

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

# tini as PID 1 (-g forwards signals to the whole process group) reaps orphaned
# sing-box helpers that reparent to PID 1 if the Node child-registry misses them.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]

# No local browser to launch anymore — just run the Node server (browsing goes to
# the cf-proxy sidecar or a remote CDP service, each with its own display).
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
