# Web Automation Platform (AutoOps)

Universal web automation platform for configuring and running headless browser sign-in automation tasks. Built as a pnpm workspace monorepo with a React dashboard frontend and Express API backend.

## Run & Operate

```bash
# Dev (Replit)
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/web-ui run dev

# Full stack (Docker)
cp .env.example .env  # fill SESSION_SECRET, ENCRYPTION_KEY, DASHBOARD_PASSWORD
docker compose up -d  # db + migrate + app on port 80

# Typecheck all packages
pnpm run typecheck

# After schema changes
pnpm --filter @workspace/db run push   # dev DB
cd lib/db && pnpm exec tsc -p tsconfig.json  # regenerate .d.ts

# After openapi.yaml changes
pnpm --filter @workspace/api-spec run codegen  # regenerate hooks + Zod schemas
```

Required env: `ENCRYPTION_KEY` (64-char hex), `DATABASE_URL`, `PORT`

## Stack

- **Monorepo**: pnpm workspaces, TypeScript 5.9, Node.js 24
- **API**: Express 5 + pino + Drizzle ORM + PostgreSQL
- **Validation**: Zod v4 (db) / Zod v3 (api-zod) + Orval codegen from OpenAPI
- **Automation**: Puppeteer + Playwright (playwright-core) + otplib (TOTP) + node-cron; remote CDP only
- **Frontend**: React + Vite + Tailwind + shadcn/ui + wouter + React Query
- **Security**: AES-256-GCM credential encryption via `ENCRYPTION_KEY`

## Where things live

```
lib/db/src/schema/tasks.ts       — DB schema (source of truth for columns)
lib/api-spec/openapi.yaml        — OpenAPI spec (source of truth for API types)
lib/api-zod/src/generated/api.ts — Zod validation schemas (manually maintained)
lib/api-client-react/src/generated/api.schemas.ts — TS types for frontend
artifacts/api-server/src/automation/step-executor.ts — workflow step engine
artifacts/api-server/src/automation/runner.ts — task orchestrator
artifacts/web-ui/src/components/StepEditor.tsx — step list editor UI
```

## Architecture decisions

- **Workflow steps replace step2Config**: tasks now store `steps: jsonb` (array of `WorkflowStep`); login is always implicit step 0; subsequent steps are explicit navigate/click/fill/wait/waitFor/screenshot actions
- **Click supports text + CSS + XPath**: `ClickStep.selectorType` is `'text' | 'css' | 'xpath'`; text mode preserves original aria-label/textContent matching
- **One screenshot per run**: final page state is saved to `data/screenshots/` on disk; `screenshot` step type saves intermediate captures to the same dir
- **Manual type files**: `lib/api-zod` and `lib/api-client-react` schemas are hand-maintained (not auto-generated) because the codegen runs outside Replit
- **Encrypted credentials**: AES-256-GCM, key must not change after tasks are created

## Product

- GitHub OAuth login and standard form login with TOTP 2FA
- Multi-step workflow builder: navigate, click (text/CSS/XPath), fill, wait, waitFor, screenshot
- Cron-scheduled runs with execution logs and screenshots
- Browser provider abstraction: Puppeteer or Playwright, both via remote CDP WebSocket (browserless default)
- Stealth mode, Cloudflare challenge bypass, captcha solver integration
- Encrypted credential vault per task

## User preferences

- Personal use (sign-in / 签到), no high concurrency needed

## Gotchas

- After editing `lib/db/src/schema/`, always recompile: `cd lib/db && pnpm exec tsc -p tsconfig.json`
- After editing `lib/api-zod/src/generated/api.ts`, recompile: `cd lib/api-zod && pnpm exec tsc -p tsconfig.json`
- After editing `lib/api-client-react/src/generated/api.schemas.ts`, recompile: `cd lib/api-client-react && pnpm exec tsc -p tsconfig.json`
- `drizzle-kit push --force` prompts interactively when columns are added; use raw SQL `ALTER TABLE … ADD COLUMN IF NOT EXISTS` instead for dev

## Pointers

- Docker: `Dockerfile` (API+UI, no bundled Chrome), `Dockerfile.migrate` (schema migration one-shot), `docker-compose.yml` includes browserless service as default browser backend
- GitHub Actions builds `ghcr.io/kuailedubage/webauto:latest`
- Screenshots stored at `data/screenshots/` (Docker volume `autoops_data` → `/app/data`)
