# AutoOps

A self-hosted web automation platform — schedule form logins, OTP handling, CAPTCHA solving, and Cloudflare bypass at scale.

## Features

- **Task scheduling** — cron-based or manual execution
- **Workflow steps** — navigate, click (text / CSS / XPath), fill, wait, screenshot, and more
- **Form & OTP login** — handles TOTP, email OTP, and standard password forms
- **CAPTCHA support** — 2Captcha, Capsolver, Anti-Captcha (token + image)
- **Cloudflare bypass** — JS challenge and Turnstile click simulation
- **Browser providers** — bundled Chromium (default), browserless.io, or any CDP-compatible remote
- **Encrypted credentials** — AES-256-GCM storage for all saved passwords

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

> **Backing up secrets**: `SESSION_SECRET` and `ENCRYPTION_KEY` are saved to `data/secrets.json` inside the Docker volume (`autoops_data`). Back up this file if you want to restore credentials after migrating to a new server.

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
