# AutoOps

A self-hosted web automation platform — schedule form logins, OTP handling, CAPTCHA solving, and Cloudflare bypass at scale.

## Features

- **Task scheduling** — cron-based or manual execution
- **Workflow steps** — navigate, click (text / CSS / XPath), fill, wait, screenshot, dismiss popups, and more
- **Popup / overlay cleanup** — auto-dismisses cookie banners, GDPR consent, modal overlays and ad layers (built into every navigation, plus an explicit "Dismiss Popups" step)
- **Form & OTP login** — handles TOTP, email OTP, and standard password forms
- **Cookie / session mode** — persist a logged-in session per task; the next run auto-detects a valid session and skips login, re-authenticating and re-persisting only when the session is gone
- **Session isolation** — each run uses a fresh browser context, so a previous run's login state never leaks into the next task
- **Per-task proxy** — HTTP, SOCKS5, and (via bundled sing-box) VLESS, VMess, Trojan, Hysteria2, TUIC, Shadowsocks, and Cloudflare WARP, configured independently for each task
- **Headed / headless toggle** — run any task with a visible browser (over Xvfb) for troubleshooting
- **CAPTCHA support** — 2Captcha, Capsolver, Anti-Captcha (token + image)
- **Cloudflare bypass** — full-page interstitial ("Just a moment…" managed / non-interactive challenges) cleared automatically before every login and navigation, plus JS-challenge and Turnstile click simulation
- **Browser providers** — bundled Chromium (default), browserless.io, or any CDP-compatible remote
- **Encrypted credentials** — AES-256-GCM storage for all saved passwords and persisted sessions

---

## Quick Start (Docker Compose)

### 1. Clone the repo

```bash
git clone https://github.com/kuailedubage/webauto.git
cd webauto
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — only two values are required:

| Variable | Description |
|---|---|
| `DASHBOARD_PASSWORD` | Initial login password |
| `POSTGRES_PASSWORD` | Password for the bundled PostgreSQL container |

Everything else — browser provider, captcha keys, CORS, secrets — is either auto-generated or configurable later via the Settings page inside the app.

### 3. Start

```bash
docker compose up -d
```

Open **http://localhost** and log in with your `DASHBOARD_PASSWORD`.

---

## Architecture

A single Docker image contains everything:

```
┌─────────────────────────────────┐
│  AutoOps container              │
│                                 │
│  Node.js (Express)              │
│  ├── GET /api/*  → API routes   │
│  └── GET /*      → Web UI SPA   │
│                                 │
│  Chromium (system, via apt)     │
│  └── used by Puppeteer for      │
│      headless browser tasks     │
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  PostgreSQL container           │
│  (or any external PG service)   │
└─────────────────────────────────┘
```

The image is published to GHCR on every push to `main`:

```
ghcr.io/kuailedubage/webauto:latest
```

---

## Using an External PostgreSQL

Set `DATABASE_URL` in your `.env` and use the provided override file to skip the bundled database containers:

```env
DATABASE_URL=postgresql://user:password@your-pg-host:5432/dbname
```

```bash
docker compose -f docker-compose.yml -f docker-compose.external-db.yml up -d
```

Compatible with: Neon, Supabase, Aiven, Railway, Amazon RDS, and any standard PostgreSQL.

To run the migration against your external database:

```bash
docker compose -f docker-compose.yml -f docker-compose.external-db.yml run --rm migrate
```

---

## Configuration Reference

| Variable | Required | Description |
|---|---|---|
| `DASHBOARD_PASSWORD` | First run | Initial login password (stored in DB after first login) |
| `POSTGRES_PASSWORD` | Compose only | Password for the bundled Postgres container |
| `SESSION_SECRET` | No | Auto-generated on first run — set only to restore a backup |
| `ENCRYPTION_KEY` | No | Auto-generated on first run — **never change after first run or saved credentials become unreadable** |
| `DATABASE_URL` | External DB only | PostgreSQL connection string |
| `CORS_ORIGINS` | No | Comma-separated allowed origins (not needed for same-origin) |
| `BROWSER_PROVIDER` | No | `local` (default), `browserless`, or `remote` |
| `BROWSERLESS_URL` | Browserless only | WebSocket endpoint (`wss://...`) |
| `CAPTCHA_PROVIDER` | No | `2captcha`, `capsolver`, or `anticaptcha` |
| `TWO_CAPTCHA_API_KEY` | 2captcha | API key |
| `CAPSOLVER_API_KEY` | Capsolver | API key |
| `ANTICAPTCHA_API_KEY` | Anti-Captcha | API key |
| `PORT` | No | Host port (default `80`) |
| `WARP_CONFIG_PATH` | WARP proxy only | Path to a sing-box WireGuard outbound JSON (generate with `wgcf`/warp-reg) used when a task's proxy type is `warp` |
| `SINGBOX_PROXY_PUBLIC_HOST` | No | Host/IP the **browser** dials to reach the on-demand sing-box SOCKS5 (VLESS/VMess/Trojan/Hysteria2/WARP). Only relevant when the browser runs in a **separate container** (browserless / cf-proxy / remote CDP). Auto-detected from the app container's non-loopback IP when unset; set it explicitly (e.g. the app's compose service name `app`, or the host IP in host-network mode) if auto-detection picks the wrong interface. |
| `SINGBOX_PROXY_LISTEN_HOST` | No | Interface the sing-box SOCKS5 inbound binds to. Defaults to `0.0.0.0` so sibling containers can reach it; set to `127.0.0.1` to restrict it to the local container only (safe only when the browser is the bundled `local` provider). |

> **Backing up secrets**: `SESSION_SECRET` and `ENCRYPTION_KEY` are saved to `data/secrets.json` inside the Docker volume (`autoops_data`). Back up this file if you want to restore credentials after migrating to a new server.

---

## Per-task proxy & session options

Each task has a **浏览器后端 (Browser Backend)** panel (collapsed by default) where you can, independently of the global settings:

- **Proxy type + address** — choose one of:
  - `HTTP/HTTPS` / `SOCKS5` — paste a normal proxy URL (`http://user:pass@host:8080`, `socks5://host:1080`). Chromium connects to it directly.
  - `VLESS` / `VMess` / `Trojan` / `Hysteria2` / `TUIC` / `Shadowsocks` — paste the node share link (`vless://…`, `vmess://…`, `trojan://…`, `hysteria2://…`, `tuic://…`, `ss://…`). A per-run **sing-box** helper is started that dials the node and exposes a SOCKS5 the browser uses. Requires the `sing-box` binary (bundled in the Docker image). When the task's browser backend runs in a **separate container** (browserless / cf-proxy / remote CDP), the app binds sing-box to all interfaces (`0.0.0.0`) and advertises a cross-container-reachable address to the browser instead of `127.0.0.1` — auto-detected, or set `SINGBOX_PROXY_PUBLIC_HOST` to override. For the bundled `local` backend it stays on `127.0.0.1`.
  - `Cloudflare WARP` — set `WARP_CONFIG_PATH` to a sing-box WireGuard outbound JSON; leave the address blank.
- **Headed mode (有头模式)** — run the task with a visible browser window (rendered on the container's Xvfb display) instead of headless, which is useful for troubleshooting. The `seleniumbase` (cf-proxy) backend is always headed.

### Session / cookie mode

On any **Login** step you can enable **会话保持 / Cookie 模式 (Cookie mode)**:

- After a successful run the authenticated browser storage state (cookies + localStorage) is encrypted and saved for that task.
- On the next run the task loads a fresh, isolated browser context, restores the saved state, and **auto-detects whether the session is still valid** — if so it **skips the login step entirely**; if the session is gone it logs in normally and re-persists the new session.
- Sessions are isolated per task (optionally per `sessionKey`), so one task's login state never bleeds into another, and every run starts from a clean context to avoid stale login residue.

---

## Deployment Options

### VM / VPS

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

git clone https://github.com/kuailedubage/webauto.git
cd webauto && cp .env.example .env
# edit .env — set DASHBOARD_PASSWORD and POSTGRES_PASSWORD
docker compose up -d
```

Add Caddy or Traefik in front for HTTPS/TLS termination.

### Pull prebuilt image

```bash
docker pull ghcr.io/kuailedubage/webauto:latest

docker run -d \
  -p 80:8080 \
  -v autoops_data:/app/data \
  -e DATABASE_URL=postgresql://... \
  -e DASHBOARD_PASSWORD=... \
  ghcr.io/kuailedubage/webauto:latest
```

### Kubernetes / Coolify / Portainer

Use the image `ghcr.io/kuailedubage/webauto:latest`. The container:
- Listens on port `8080`
- Requires a PostgreSQL database
- Needs a persistent volume mounted at `/app/data` (stores secrets and screenshots)
- Needs ~512 MB RAM minimum for headless Chrome
- Does **not** need root or privileged mode — `--no-sandbox` is already set

### Serverless note

This app runs cron jobs internally and maintains a persistent Chromium instance. **Do not deploy on platforms that scale to zero** (serverless functions, autoscale containers). Use a VM or always-on container instead.

---

## Development

### Option A — VS Code Dev Container (recommended)

Requires: [VS Code](https://code.visualstudio.com) + [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) + Docker

```bash
git clone https://github.com/kuailedubage/webauto.git
code webauto
# VS Code prompt: "Reopen in Container" → click it
```

The container starts automatically with PostgreSQL, runs migrations, and gives you a full Chromium environment for testing. Hot reload works for both the API and web UI.

### Option B — Local without Docker

Requires: Node.js 20+, pnpm, a running PostgreSQL instance

```bash
pnpm install

# Push schema to local DB
DATABASE_URL=postgresql://... pnpm --filter @workspace/db run push

# Start API + web UI in separate terminals
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/web-ui run dev
```

Note: Chromium is not included — browser automation steps will fail without it installed separately.

---

## Build locally

```bash
# Build the all-in-one image
docker build -t autoops .

# Run it
docker run -d -p 8080:8080 \
  -v autoops_data:/app/data \
  -e DATABASE_URL=... \
  -e DASHBOARD_PASSWORD=... \
  autoops
```
