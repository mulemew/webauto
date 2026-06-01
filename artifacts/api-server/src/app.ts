import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { db, tasksTable, sql } from "@workspace/db";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Frontend and API are co-hosted (Express serves the built React app as static
// files), so same-origin requests never trigger CORS. Disable cross-origin
// access by default — no external domain needs to call this API directly.
app.use(cors({ origin: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Use a lazy wrapper so cookieParser is initialised on the first request,
// not at module evaluation time. auto-secrets.ts calls ensureSecrets() at
// module level which runs before this module, but this pattern ensures
// SESSION_SECRET is always read from process.env at the last possible moment
// as an additional safety net.
let _cookieParser: ReturnType<typeof cookieParser> | null = null;
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!_cookieParser) {
    _cookieParser = cookieParser(process.env.SESSION_SECRET);
  }
  return _cookieParser(req, res, next);
});

// Serve web UI static files in production.
// In Docker the built assets are copied to dist/public alongside the bundle.
// In Replit dev mode this directory does not exist, so nothing is served here
// and the Vite dev server handles the frontend separately.
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

app.use("/api", router);

// SPA fallback — send index.html for any non-/api route so client-side
// routing works. Only active when the public directory is present.
if (existsSync(publicDir)) {
  app.get("*path", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

// Global JSON error handler — must be the LAST middleware registered.
// Express 5's default error handler returns HTML; this ensures all unhandled
// async errors from route handlers are returned as JSON instead, preventing
// "Unexpected token '<'" parse errors on the frontend.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled route error");
  if (res.headersSent) return;
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ── Startup: schema patches + stuck-task reset ────────────────────────────────────────────
    (async () => {
      // 1. Ensure run_at index exists — idempotent, safe to run every boot
      try {
        await db.execute(sql`CREATE INDEX IF NOT EXISTS logs_run_at_idx ON logs (run_at)`);
        logger.info("DB: logs_run_at_idx ensured");
      } catch (err) {
        logger.warn({ err }, "Failed to ensure logs_run_at_idx (non-fatal)");
      }

      // 2. Reset tasks stuck in queued/running after a server restart
      try {
        const result = await db
          .update(tasksTable)
          .set({ status: "idle" })
          .where(sql`${tasksTable.status} IN ('queued', 'running')`)
          .returning({ id: tasksTable.id });
        if (result.length > 0) {
          logger.warn({ count: result.length, ids: result.map(r => r.id) }, "Reset stuck tasks to idle on startup");
        }
      } catch (err) {
        logger.warn({ err }, "Startup task cleanup failed (non-fatal)");
      }
    })();

    export default app;