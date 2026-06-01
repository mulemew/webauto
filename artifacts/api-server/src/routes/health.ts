import net from "net";
  import { Router, type IRouter } from "express";
  import { HealthCheckResponse, BrowserHealthCheckResponse } from "@workspace/api-zod";
  import { db, sql } from "@workspace/db";
  import { requireAuth } from "../middlewares/requireAuth";
  import { loadBrowserConfig } from "../lib/appSettings";
  import { getScheduledJobsCount } from "../scheduler";

  const router: IRouter = Router();

  router.get("/healthz", (_req, res) => {
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  });

  /**
   * TCP reachability probe — works for ANY WebSocket-based browser service
   * (browserless, BrightData, Steel.dev, plain Chrome, etc.) regardless of
   * what HTTP REST API they expose. If the TCP port accepts a connection the
   * service is reachable; no HTTP endpoint assumptions are made.
   */
  function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });

      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeoutMs);

      socket.on("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });

      socket.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  // #3 — requireAuth so the wsEndpoint URL (which may contain auth tokens) is
  // never exposed to unauthenticated callers.
  router.get("/healthz/browser", requireAuth, async (_req, res): Promise<void> => {
    const config = await loadBrowserConfig();
    const wsEndpoint = config.wsEndpoint;

    if (!wsEndpoint) {
      res.json(BrowserHealthCheckResponse.parse({ status: "unconfigured", url: null }));
      return;
    }

    // Mask any token query-param before returning the URL to the client (#3)
    const safeUrl = wsEndpoint.replace(/([?&]token=)[^&]*/g, "$1***");

    // Parse host + port from the WebSocket URL
    let host: string;
    let port: number;
    try {
      const parsed = new URL(
        wsEndpoint.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://"),
      );
      host = parsed.hostname;
      port = parsed.port
        ? parseInt(parsed.port, 10)
        : parsed.protocol === "https:" ? 443 : 80;
    } catch {
      res.json(BrowserHealthCheckResponse.parse({ status: "unreachable", url: safeUrl }));
      return;
    }

    const reachable = await probeTcp(host, port, 4000);
    const status = reachable ? "connected" : "unreachable";
    res.json(BrowserHealthCheckResponse.parse({ status, url: safeUrl }));
  });

  // ── GET /healthz/db ───────────────────────────────────────────────────────────

  router.get("/healthz/db", requireAuth, async (_req, res): Promise<void> => {
    const t0 = Date.now();
    try {
      await db.execute(sql.raw("SELECT 1"));
      const latencyMs = Date.now() - t0;
      res.json({ status: "ok", latencyMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ status: "error", message });
    }
  });

  // ── GET /healthz/scheduler ────────────────────────────────────────────────────

  router.get("/healthz/scheduler", requireAuth, (_req, res): void => {
    res.json({ status: "ok", scheduledJobs: getScheduledJobsCount() });
  });

  export default router;
