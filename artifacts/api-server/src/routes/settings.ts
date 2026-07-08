import { Router, type IRouter } from "express";
  import { db, sql } from "@workspace/db";
  import { logger } from "../lib/logger";
  import {
    loadBrowserConfig, saveBrowserConfig,
    loadCaptchaConfig, saveCaptchaConfig,
    loadTaskTimeoutConfig, saveTaskTimeoutConfig,
    loadRetentionConfig, saveRetentionConfig,
    loadConcurrencyConfig, saveConcurrencyConfig,
    type RetentionConfig,
  } from "../lib/appSettings";
  import type { CaptchaConfig, CaptchaProvider, TaskTimeoutConfig, ConcurrencyConfig } from "../lib/appSettings";
  import { createBrowserProvider } from "../automation/browser-provider";
  import type { BrowserProviderConfig, BrowserProviderType } from "../automation/browser-provider";
  import { runRetentionCleanup } from "../scheduler";
  import { getConcurrencyStatus } from "../automation/runner";
  import path from "path";
  import fs from "fs";

  const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");

  const router: IRouter = Router();

  const VALID_PROVIDERS: BrowserProviderType[] = ["playwright", "puppeteer", "local", "seleniumbase"];

  router.get("/settings/browser", async (_req, res): Promise<void> => {
      try {
        const config = await loadBrowserConfig();
        res.json({
          provider: config.provider,
          wsEndpoint: config.wsEndpoint,
          testUrl: config.testUrl || "https://example.com",
          sessionTimeoutMs: config.sessionTimeoutMs ?? 1_800_000,
          stealth: config.stealth ?? false,
          blockAds: config.blockAds ?? false,
          proxyUrl: config.proxyUrl ?? "",
          proxyType: config.proxyType ?? null,
          headed: config.headed ?? false,
          ignoreHTTPS: config.ignoreHTTPS ?? false,
          viewportWidth: config.viewportWidth ?? null,
          viewportHeight: config.viewportHeight ?? null,
        });
      } catch (err) {
        logger.error({ err }, "Failed to load browser config");
        res.status(500).json({ error: "Failed to load browser configuration" });
      }
    });

  router.put("/settings/browser", async (req, res): Promise<void> => {
      const body = req.body as Partial<BrowserProviderConfig>;
      const { provider, wsEndpoint, testUrl } = body;
      const resolvedProvider: BrowserProviderType = provider && VALID_PROVIDERS.includes(provider) ? provider : "playwright";
      if (resolvedProvider !== "local" && resolvedProvider !== "seleniumbase" && !wsEndpoint?.trim()) { res.status(400).json({ error: "WebSocket endpoint URL is required" }); return; }
      const proxyUrl = typeof body.proxyUrl === "string" ? body.proxyUrl.trim() : "";
      const proxyType =
        typeof body.proxyType === "string" && body.proxyType.trim()
          ? body.proxyType.trim() as BrowserProviderConfig["proxyType"]
          : undefined;
      const config: BrowserProviderConfig = {
        provider: resolvedProvider,
        wsEndpoint: wsEndpoint?.trim() ?? "",
        testUrl: testUrl?.trim() ?? "",
        sessionTimeoutMs: Number.isFinite(Number(body.sessionTimeoutMs)) && Number(body.sessionTimeoutMs) > 0 ? Number(body.sessionTimeoutMs) : 1_800_000,
        stealth: body.stealth === true,
        blockAds: body.blockAds === true,
        proxyUrl,
        ignoreHTTPS: body.ignoreHTTPS === true,
        // Do not persist the UI's default proxyType by itself. A blank proxy
        // address means "no proxy" unless WARP is explicitly selected.
        proxyType: proxyUrl || proxyType === "warp" ? proxyType : undefined,
        headed: body.headed === true,
        viewportWidth: Number.isFinite(Number(body.viewportWidth)) && Number(body.viewportWidth) >= 320 ? Math.floor(Number(body.viewportWidth)) : undefined,
        viewportHeight: Number.isFinite(Number(body.viewportHeight)) && Number(body.viewportHeight) >= 240 ? Math.floor(Number(body.viewportHeight)) : undefined,
      };
      try {
        await saveBrowserConfig(config);
        logger.info({ provider: resolvedProvider, wsEndpoint: config.wsEndpoint }, "Browser config saved");
        res.json({ ok: true, config });
      } catch (err) {
        logger.error({ err }, "Failed to save browser config");
        res.status(500).json({ error: "Failed to save browser configuration" });
      }
    });

  router.post("/settings/browser/test", async (req, res): Promise<void> => {
    const { provider, wsEndpoint, testUrl } = req.body as Partial<BrowserProviderConfig> & { testUrl?: string };
    const resolvedProvider: BrowserProviderType = provider && VALID_PROVIDERS.includes(provider) ? provider : "playwright";
    if (resolvedProvider !== "seleniumbase" && !wsEndpoint?.trim()) { res.json({ ok: false, message: "WebSocket endpoint URL is required" }); return; }
    const config: BrowserProviderConfig = { provider: resolvedProvider, wsEndpoint: wsEndpoint?.trim() ?? "" };
    const connectTimeout = 20_000;
    const navTimeout = 30_000;
    const targetUrl = testUrl?.trim() || "https://example.com";
    let pageAdapter = null as Awaited<ReturnType<ReturnType<typeof createBrowserProvider>["newPage"]>> | null;
    try {
      const browserProvider = createBrowserProvider(config);
      pageAdapter = await Promise.race([
        browserProvider.newPage(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Connection timed out after ${connectTimeout / 1000}s`)), connectTimeout)),
      ]);
      const t0 = Date.now();
      await pageAdapter.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
      const elapsedMs = Date.now() - t0;
      const finalUrl = pageAdapter.url();
      const title = await pageAdapter.title();
      const shot = await pageAdapter.screenshot({ encoding: "base64", type: "png" });
      const screenshotBase64 = typeof shot === "string" ? shot : Buffer.from(shot).toString("base64");
      logger.info({ provider: resolvedProvider, targetUrl, elapsedMs }, "Browser connection test passed");
      res.json({ ok: true, message: `Connected via ${resolvedProvider}. Navigated to "${title}" in ${elapsedMs}ms.`, screenshotBase64, finalUrl, elapsedMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ provider: resolvedProvider, err }, "Browser connection test failed");
      res.json({ ok: false, message });
    } finally {
      if (pageAdapter) await pageAdapter.close().catch(() => {});
    }
  });

  router.get("/settings/task-timeout", async (_req, res): Promise<void> => {
    try { res.json(await loadTaskTimeoutConfig()); }
    catch (err) { logger.error({ err }, "Failed to load task timeout config"); res.status(500).json({ error: "Failed to load task timeout configuration" }); }
  });

  router.put("/settings/task-timeout", async (req, res): Promise<void> => {
    const body = req.body as Partial<TaskTimeoutConfig>;
    const raw = Number(body.timeoutMinutes ?? 30);
    const timeoutMinutes = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 30;
    try {
      await saveTaskTimeoutConfig({ timeoutMinutes });
      logger.info({ timeoutMinutes }, "Task timeout config saved");
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "Failed to save task timeout config");
      res.status(500).json({ error: "Failed to save task timeout configuration" });
    }
  });

  router.get("/settings/captcha", async (_req, res): Promise<void> => {
    try {
      const config = await loadCaptchaConfig();
      res.json({
        provider: config.provider,
        twoCaptchaApiKey: config.twoCaptchaApiKey ? "***" : "",
        capsolverApiKey: config.capsolverApiKey ? "***" : "",
        anticaptchaApiKey: config.anticaptchaApiKey ? "***" : "",
        twoCaptchaKeySet: !!config.twoCaptchaApiKey,
        capsolverKeySet: !!config.capsolverApiKey,
        anticaptchaKeySet: !!config.anticaptchaApiKey,
      });
    } catch (err) {
      logger.error({ err }, "Failed to load captcha config");
      res.status(500).json({ error: "Failed to load captcha configuration" });
    }
  });

  const VALID_CAPTCHA_PROVIDERS: CaptchaProvider[] = ["none", "2captcha", "capsolver", "anticaptcha"];

  router.put("/settings/captcha", async (req, res): Promise<void> => {
    const body = req.body as Partial<CaptchaConfig>;
    const provider: CaptchaProvider = body.provider && VALID_CAPTCHA_PROVIDERS.includes(body.provider) ? body.provider : "none";
    let existing: CaptchaConfig;
    try { existing = await loadCaptchaConfig(); }
    catch { existing = { provider: "none", twoCaptchaApiKey: "", capsolverApiKey: "", anticaptchaApiKey: "" }; }
    const resolve = (incoming: string | undefined, current: string): string => (!incoming || incoming === "***") ? current : incoming.trim();
    const config: CaptchaConfig = {
      provider,
      twoCaptchaApiKey: resolve(body.twoCaptchaApiKey, existing.twoCaptchaApiKey),
      capsolverApiKey: resolve(body.capsolverApiKey, existing.capsolverApiKey),
      anticaptchaApiKey: resolve(body.anticaptchaApiKey, existing.anticaptchaApiKey),
    };
    try {
      await saveCaptchaConfig(config);
      logger.info({ provider }, "Captcha config saved");
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "Failed to save captcha config");
      res.status(500).json({ error: "Failed to save captcha configuration" });
    }
  });

  // ── GET /api/settings/system-info ─────────────────────────────────────────────

  router.get("/settings/system-info", async (_req, res): Promise<void> => {
    const uptimeSeconds = Math.floor(process.uptime());
    let dbStatus: "connected" | "error" = "error";
    try { await db.execute(sql.raw("SELECT 1")); dbStatus = "connected"; } catch { /* leave as error */ }

    // Screenshot directory size
    let screenshotSizeMb = 0;
    try {
      if (fs.existsSync(SCREENSHOTS_DIR)) {
        const files = fs.readdirSync(SCREENSHOTS_DIR).filter((f) => f.endsWith(".png"));
        screenshotSizeMb = Math.round(
          files.reduce((sum, f) => sum + (fs.statSync(path.join(SCREENSHOTS_DIR, f)).size || 0), 0) / (1024 * 1024) * 10
        ) / 10;
      }
    } catch { /* ignore */ }

    res.json({
      version: process.env.npm_package_version ?? "0.0.0",
      nodeVersion: process.version,
      platform: process.platform,
      uptimeSeconds,
      dbStatus,
      screenshotSizeMb,
    });
  });

  // ── GET/PUT /api/settings/retention ──────────────────────────────────────────

  router.get("/settings/retention", async (_req, res): Promise<void> => {
    try { res.json(await loadRetentionConfig()); }
    catch (err) { logger.error({ err }, "Failed to load retention config"); res.status(500).json({ error: "Failed to load retention configuration" }); }
  });

  router.put("/settings/retention", async (req, res): Promise<void> => {
    const body = req.body as Partial<RetentionConfig>;
    const logRetentionDays = Number.isFinite(Number(body.logRetentionDays)) && Number(body.logRetentionDays) >= 0
      ? Math.floor(Number(body.logRetentionDays)) : 7;
    const maxScreenshotsMb = Number.isFinite(Number(body.maxScreenshotsMb)) && Number(body.maxScreenshotsMb) >= 0
      ? Math.floor(Number(body.maxScreenshotsMb)) : 1024;
    try {
      await saveRetentionConfig({ logRetentionDays, maxScreenshotsMb });
      logger.info({ logRetentionDays, maxScreenshotsMb }, "Retention config saved");
      res.json({ ok: true, logRetentionDays, maxScreenshotsMb });
    } catch (err) {
      logger.error({ err }, "Failed to save retention config");
      res.status(500).json({ error: "Failed to save retention configuration" });
    }
  });

  // ── POST /api/settings/retention/cleanup ─────────────────────────────────────

  router.post("/settings/retention/cleanup", async (_req, res): Promise<void> => {
    try {
      await runRetentionCleanup();
      res.json({ ok: true, message: "Retention cleanup completed" });
    } catch (err) {
      logger.error({ err }, "Manual retention cleanup failed");
      res.status(500).json({ error: "Cleanup failed" });
    }
  });

  
    // ── Concurrency config ────────────────────────────────────────────────────────

    router.get("/settings/concurrency", async (_req, res): Promise<void> => {
      try {
        const config = await loadConcurrencyConfig();
        const status = getConcurrencyStatus();
        res.json({ ...config, ...status });
      } catch (err) {
        logger.error({ err }, "Failed to load concurrency config");
        res.status(500).json({ error: "Failed to load concurrency configuration" });
      }
    });

    router.put("/settings/concurrency", async (req, res): Promise<void> => {
      const body = req.body as Partial<ConcurrencyConfig>;
      const maxConcurrent    = Number.isFinite(Number(body.maxConcurrent))    && Number(body.maxConcurrent) >= 1    ? Math.floor(Number(body.maxConcurrent))    : 3;
      const maxQueueDepth    = Number.isFinite(Number(body.maxQueueDepth))    && Number(body.maxQueueDepth) >= 0    ? Math.floor(Number(body.maxQueueDepth))    : 10;
      const queueTimeoutSecs = Number.isFinite(Number(body.queueTimeoutSecs)) && Number(body.queueTimeoutSecs) >= 0 ? Math.floor(Number(body.queueTimeoutSecs)) : 300;
      const config: ConcurrencyConfig = { maxConcurrent, maxQueueDepth, queueTimeoutSecs };
      try {
        await saveConcurrencyConfig(config);
        logger.info(config, "Concurrency config saved");
        res.json({ ok: true });
      } catch (err) {
        logger.error({ err }, "Failed to save concurrency config");
        res.status(500).json({ error: "Failed to save concurrency configuration" });
      }
    });

  export default router;
