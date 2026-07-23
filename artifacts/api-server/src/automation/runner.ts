import path from "path";
  import fs from "fs";
  import { db, tasksTable, credentialsTable, savedCredentialsTable, logsTable, fingerprintProfilesTable, proxyProfilesTable, eq } from "@workspace/db";
  import { logger } from "../lib/logger";
  import { decrypt } from "../lib/encryption";
  import { createBrowserProvider } from "./browser-provider";
  import { createCaptchaSolverFromConfig } from "./captcha-solver";
  import { loadBrowserConfig, loadCaptchaConfig, loadTaskTimeoutConfig, loadConcurrencyConfig } from "../lib/appSettings";
  import { emitTaskProgress, emitTaskDone, getTaskEmitter, clearTaskEventBuffer } from "../lib/taskEvents";
  import { executeWorkflowSteps, CaptchaBlockedError, type WorkflowStep, type StepResult } from "./step-executor";
  import { loadBrowserSession, saveBrowserSession, clearBrowserSession, taskUsesCookieMode } from "../lib/browserSessionStore";

/**
 * After a failed run, book the next attempt if the task has retries configured.
 *
 * Reuses the scheduler's existing one-shot mechanism: setting nextRunAt makes its
 * 30s polling loop fire the task when the time arrives — no extra timer to leak or
 * lose across restarts. retryAttempt tracks the CURRENT failure streak and is reset
 * on success (or once the budget is spent), so a task that fails next week starts
 * over with a full allowance rather than being permanently out of retries.
 *
 * Returns a short suffix for the run's log message, or "" when retries are off.
 */
async function scheduleRetryIfConfigured(taskId: number): Promise<string> {
  try {
    const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!t) return "";
    const max = Number(t.retryCount ?? 0);
    if (!max || max <= 0) return "";
    const used = Number(t.retryAttempt ?? 0);
    if (used >= max) {
      await db.update(tasksTable).set({ retryAttempt: 0 }).where(eq(tasksTable.id, taskId));
      logger.info({ taskId, used, max }, "Retry budget exhausted — waiting for the normal schedule");
      return ` (retries exhausted: ${used}/${max})`;
    }
    const mins = Math.max(1, Number(t.retryIntervalMinutes ?? 5));
    const nextRunAt = new Date(Date.now() + mins * 60_000);
    await db
      .update(tasksTable)
      .set({ retryAttempt: used + 1, nextRunAt })
      .where(eq(tasksTable.id, taskId));
    logger.info({ taskId, attempt: used + 1, max, mins }, "Retry scheduled after failure");
    return ` (retry ${used + 1}/${max} in ${mins}m)`;
  } catch (err) {
    logger.warn({ taskId, err }, "Failed to schedule retry");
    return "";
  }
}

/**
 * Parse a document.cookie-style string ("a=1; b=2") into driver cookie objects.
 *
 * Users paste only the site's login-ticket cookie (its name differs per site —
 * Pterodactyl/Laravel panels use remember_web_*, GitHub uses _github_session), so we
 * stay name-agnostic. The domain is derived from the task's target URL; values are
 * left exactly as pasted (they're opaque tokens, and splitting on the FIRST "=" only
 * matters because base64 values contain "=" padding).
 */
function parseCookieHeader(raw: string, targetUrl: string): Array<Record<string, unknown>> {
  if (!raw || !raw.trim()) return [];
  let domain = "";
  let secure = false;
  try {
    const u = new URL(targetUrl);
    domain = u.hostname;
    secure = u.protocol === "https:";
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const part of raw.split(";")) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    const name = s.slice(0, eq).trim();
    const value = s.slice(eq + 1).trim();
    if (!name) continue;
    // Playwright's storageState wants the full shape; Selenium ignores extras. We do
    // NOT set httpOnly: WebDriver can't reliably set it, and it only governs JS
    // access — the cookie is still sent on requests, which is all auth needs.
    out.push({
      name,
      value,
      domain,
      path: "/",
      secure,
      expires: -1, // session cookie; the site re-issues a dated one once it accepts us
      sameSite: "Lax",
    });
  }
  return out;
}

/** After a post-completion interval run finishes, write the nextRunAt timestamp into the DB. */
  async function schedulePostCompletionIfNeeded(taskId: number, dryRun: boolean): Promise<void> {
    if (dryRun) return;
    try {
      const [task] = await db
        .select({ cronExpression: tasksTable.cronExpression, enabled: tasksTable.enabled })
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId));
      if (!task?.enabled || !task.cronExpression?.startsWith("@after_completion:")) return;
      const delayMinutes = parseInt(task.cronExpression.split(":")[1] ?? "0", 10);
      if (delayMinutes < 1) return;
      const nextRunAt = new Date(Date.now() + delayMinutes * 60 * 1000);
      await db.update(tasksTable).set({ nextRunAt }).where(eq(tasksTable.id, taskId));
      logger.info({ taskId, delayMinutes, nextRunAt: nextRunAt.toISOString() }, "Post-completion next run scheduled");
    } catch (err) {
      logger.error({ taskId, err }, "Failed to schedule post-completion next run");
    }
  }

  export interface DecryptedCredentials {
    username: string;
    password: string;
    totpSecret?: string;
  }

  const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");
  const MAX_SCREENSHOTS_PER_TASK = 20;

  function ensureScreenshotsDir(): void {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  async function saveScreenshot(taskId: number, buffer: Buffer): Promise<string> {
    ensureScreenshotsDir();
    const filename = `task-${taskId}-${Date.now()}.png`;
    const filePath = path.join(SCREENSHOTS_DIR, filename);
    fs.writeFileSync(filePath, buffer);
    try {
      const prefix = `task-${taskId}-`;
      const files = fs.readdirSync(SCREENSHOTS_DIR)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".png"))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(SCREENSHOTS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .map((f) => f.name);
      for (const old of files.slice(MAX_SCREENSHOTS_PER_TASK)) fs.unlink(path.join(SCREENSHOTS_DIR, old), () => {});
    } catch {}
    return `screenshots/${filename}`;
  }

  let currentConcurrent = 0;
    const waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> | null }> = [];

    /** Returns live concurrency status for the Settings UI. */
    export function getConcurrencyStatus(): { running: number; queued: number } {
      return { running: currentConcurrent, queued: waitQueue.length };
    }

    /**
     * Acquire a semaphore slot before starting a task.
     * Reads maxConcurrent / maxQueueDepth / queueTimeoutSecs from the DB on each
     * call so that changes in Settings take effect on the next task start without
     * requiring a server restart.
     */
    async function acquireSemaphore(): Promise<void> {
      const config = await loadConcurrencyConfig();
      const max = Math.max(1, config.maxConcurrent);

      if (currentConcurrent < max) {
        currentConcurrent++;
        return;
      }

      // Queue depth guard
      if (config.maxQueueDepth > 0 && waitQueue.length >= config.maxQueueDepth) {
        throw new Error(
          `Concurrency queue is full (${waitQueue.length}/${config.maxQueueDepth} tasks waiting). Try again later or increase Max Queue Depth in Settings.`,
        );
      }

      // Enqueue with optional timeout
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const entry = {
          resolve: () => { if (timer) clearTimeout(timer); resolve(); },
          reject:  (err: Error) => { if (timer) clearTimeout(timer); reject(err); },
          timer: null as ReturnType<typeof setTimeout> | null,
        };

        if (config.queueTimeoutSecs > 0) {
          timer = setTimeout(() => {
            const idx = waitQueue.indexOf(entry);
            if (idx !== -1) waitQueue.splice(idx, 1);
            entry.reject(
              new Error(
                `Task waited >${config.queueTimeoutSecs}s in queue and was dropped. Increase Queue Timeout or reduce concurrency load.`,
              ),
            );
          }, config.queueTimeoutSecs * 1000);
          entry.timer = timer;
        }

        waitQueue.push(entry);
      });

      currentConcurrent++;
    }

    function releaseSemaphore(): void {
      currentConcurrent = Math.max(0, currentConcurrent - 1);
      const next = waitQueue.shift();
      if (next) next.resolve();
    }

  const runningTasks = new Set<number>();
  const cancelRequested = new Set<number>();

  export function isTaskRunning(taskId: number): boolean {
    return runningTasks.has(taskId);
  }

  /** Request cancellation of a running task. Effective between steps. */
  export function requestCancelTask(taskId: number): void {
    cancelRequested.add(taskId);
  }

  /**
   * Throw if this run was cancelled. Sprinkled through the STARTUP phase — proxy
   * precheck, sing-box, cookie restore, browser launch — which happens before the
   * Promise.race and used to be completely uncancellable: hitting cancel during
   * those tens of seconds set the flag, nothing looked at it, the task stayed in
   * runningTasks, and the next run answered 409 "already running" while the user had
   * been told it was cancelled.
   */
  function throwIfCancelled(taskId: number): void {
    if (cancelRequested.has(taskId)) throw new Error("Task cancelled by user");
  }

  export async function runTask(
    taskId: number,
    dryRun = false,
    triggeredBy: "manual" | "cron" | "dry_run" | "webhook" = "manual",
  ): Promise<void> {
    if (runningTasks.has(taskId)) {
      logger.warn({ taskId, dryRun }, "Task already running, skipping");
      return;
    }

    runningTasks.add(taskId);
    clearTaskEventBuffer(taskId); // discard stale buffer from any previous run
    const startTime = Date.now();
    let screenshotPage: import("./page-adapter").PageAdapter | undefined;
    let outerScreenshotPath: string | undefined;
    emitTaskProgress(taskId, "Task started - fetching configuration-¦");
    let semaphoreAcquired = false;
    const collectedStepLogs: Array<{ stepIndex: number; type: string; success: boolean; message: string; screenshotPath?: string; durationMs?: number }> = [];

    try {
      // ── 排队中状态 ── 槽位满时先将任务标记为 queued ──────────────────
      if (!dryRun) {
        const _preConcConfig = await loadConcurrencyConfig();
        if (currentConcurrent >= Math.max(1, _preConcConfig.maxConcurrent)) {
          await db.update(tasksTable).set({ status: "queued" }).where(eq(tasksTable.id, taskId));
          emitTaskProgress(taskId, "Queued — waiting for a browser slot-¦");
        }
      }
      await acquireSemaphore();
      semaphoreAcquired = true;

      const globalBrowserConfig = await loadBrowserConfig();
      const captchaConfig = await loadCaptchaConfig();
      const solver = createCaptchaSolverFromConfig(captchaConfig);
      const timeoutConfig = await loadTaskTimeoutConfig();
      const timeoutMs = timeoutConfig.timeoutMinutes > 0 ? timeoutConfig.timeoutMinutes * 60_000 : null;

      const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
      if (!task) { logger.error({ taskId }, "Task not found"); return; }

      // Merge task-level browserConfig (if set) over the global config.
      // This allows each task to use a different browser backend — e.g. one task
      // via seleniumbase CF Proxy, another via Playwright CDP.
      const taskBrowserOverride = (task.browserConfig ?? null) as Partial<import("./browser-provider").BrowserProviderConfig> | null;
      const browserConfig = taskBrowserOverride
        ? { ...globalBrowserConfig, ...taskBrowserOverride }
        : globalBrowserConfig;
      if (taskBrowserOverride) {
        logger.info({ taskId, provider: browserConfig.provider }, "Using task-level browser config override");
      }

      // ── Saved fingerprint / proxy profiles ──────────────────────────────────
      // Backward-compatible: a profile is applied ONLY when its id is set on the
      // task; otherwise the task's inline fingerprint/proxy (the existing UC config)
      // is used unchanged. A deleted/missing profile silently falls back to inline.
      const _profileIds = (browserConfig ?? {}) as { fingerprintProfileId?: number | null; proxyProfileId?: number | null };
      if (_profileIds.proxyProfileId) {
        const [pp] = await db.select().from(proxyProfilesTable).where(eq(proxyProfilesTable.id, _profileIds.proxyProfileId));
        if (pp) {
          browserConfig.proxyUrl = pp.url;
          const scheme = (pp.url.split("://")[0] || "").toLowerCase();
          const t = scheme === "socks5h" ? "socks5" : scheme;
          if (["http", "socks5", "vless", "vmess", "trojan", "hy2", "tuic", "ss"].includes(t)) {
            (browserConfig as { proxyType?: string }).proxyType = t;
          }
          logger.info({ taskId, proxyProfile: pp.name }, "Using saved proxy profile");
        }
      }
      if (_profileIds.fingerprintProfileId) {
        const [fpr] = await db.select().from(fingerprintProfilesTable).where(eq(fingerprintProfilesTable.id, _profileIds.fingerprintProfileId));
        if (fpr) {
          const cfg = (fpr.config ?? {}) as { timezone?: string; locale?: string; screen?: string; fp?: string; preset?: unknown; summary?: { screen?: string } };
          // os "linux" is honest for cf-proxy (its _apply_fingerprint ignores non
          // windows/mac) and a real target for camoufox — pass it through either way.
          // fp/preset are the browserforge pickle / real preset for camoufox's EXACT
          // reproduction (ignored by cf-proxy, which uses os/tz/locale only).
          browserConfig.fingerprint = {
            os: fpr.os,
            timezone: cfg.timezone || "",
            locale: cfg.locale || "",
            // Always allow IP auto-fill: a fingerprint profile has no "off" switch —
            // a blank tz/locale means "auto from the exit IP". Downstream resolution is
            // per-field ("manual wins, else auto"), so filling ONLY one no longer forces
            // the other to a hard-coded default; the empty one still tracks the proxy IP.
            autoGeo: true,
            ...(cfg.fp ? { fp: cfg.fp } : {}),
            ...(cfg.preset !== undefined ? { preset: cfg.preset } : {}),
          };
          const screen = cfg.screen || cfg.summary?.screen;
          if (screen && /^\d+x\d+$/i.test(screen)) {
            const [w, h] = screen.toLowerCase().split("x").map(Number);
            browserConfig.viewportWidth = w;
            browserConfig.viewportHeight = h;
          }
          logger.info({ taskId, fingerprintProfile: fpr.name, os: fpr.os }, "Using saved fingerprint profile");
        }
      }

      // ── Cookie mode: restore + capture browser session (storage state) ──────
      // If any login step in this task enables cookie mode, seed the browser
      // context with the previously-saved storage state and register a dumper
      // so we can persist the updated session after a successful run.
      const _taskSteps = (task.steps as WorkflowStep[] | null) ?? [];
      const cookieModeStep = _taskSteps.find(
        // loginMethod "cookie" means "there is no automated login, drive it purely
        // from cookies" — that implies cookie mode, so don't also require the toggle.
        (s) =>
          s.type === "login" &&
          ((s as Record<string, unknown>).cookieMode === true ||
            (s as Record<string, unknown>).loginMethod === "cookie"),
      ) as (Record<string, unknown> | undefined);
      const cookieModeEnabled = !!cookieModeStep;
      const cookieSessionKey =
        (cookieModeStep?.sessionKey as string | undefined)?.trim() || "default";
      let dumpStorageState: (() => Promise<unknown>) | null = null;

      // The URL the session belongs to: the login step's page if set, else the task
      // target. Cookies are domain-scoped, so deriving this from the wrong one would
      // plant them on a domain the site never reads.
      const cookieOriginUrl =
        ((cookieModeStep?.loginUrl as string | undefined) || "").trim() || task.targetUrl;

      if (cookieModeEnabled) {
        const saved = await loadBrowserSession(taskId, cookieSessionKey);
        if (saved) {
          browserConfig.storageState = saved;
          emitTaskProgress(taskId, "Restored saved browser session (cookie mode)-¦");
          logger.info({ taskId, cookieSessionKey }, "Cookie mode — restored saved session");
        } else {
          // Nothing saved yet — seed Playwright's context from the pasted cookies.
          // (The cf-proxy path seeds the live page after newPage() instead; without
          // this branch a pasted cookie only worked on cf-proxy.)
          const seed = parseCookieHeader((cookieModeStep?.cookies as string | undefined) ?? "", cookieOriginUrl);
          if (seed.length) {
            browserConfig.storageState = { cookies: seed, origins: [] };
            emitTaskProgress(taskId, `Seeded ${seed.length} configured cookie(s)-¦`);
            logger.info({ taskId, count: seed.length }, "Cookie mode — seeded context from configured cookies");
          }
        }
        browserConfig.onContextReady = (dumper) => { dumpStorageState = dumper; };
      }

      const browserProvider = createBrowserProvider(browserConfig);

      if (!dryRun) {
        await db.update(tasksTable).set({ status: "running" }).where(eq(tasksTable.id, taskId));
      }

      emitTaskProgress(taskId, "Connecting to remote browser-¦");

      const [credRow] = await db.select().from(credentialsTable).where(eq(credentialsTable.taskId, taskId));
      let creds: DecryptedCredentials | null = null;
      if (credRow) {
        try { creds = JSON.parse(decrypt(credRow.encryptedData)) as DecryptedCredentials; }
        catch { logger.warn({ taskId }, "Failed to decrypt credentials"); }
      }

      const rawSteps = (task.steps as WorkflowStep[] | null) ?? [];
      const hasLoginStep = rawSteps.some((s) => s.type === "login");
      const effectiveSteps: WorkflowStep[] =
        !hasLoginStep && task.loginType && creds
          ? [{ type: "login" as const, loginMethod: task.loginType as "form" | "github" | "google", loginUrl: task.targetUrl }, ...rawSteps]
          : rawSteps;

      const effectiveStepsWithCreds: WorkflowStep[] = await Promise.all(
        effectiveSteps.map(async (step) => {
          if (step.type === "login") {
            const ls = step as typeof step & { credentialId?: number; inlineUsername?: string };
            if (ls.credentialId && !ls.inlineUsername) {
              const [savedCred] = await db.select().from(savedCredentialsTable).where(eq(savedCredentialsTable.id, ls.credentialId));
              if (savedCred) {
                try {
                  const { password, totpSecret } = JSON.parse(decrypt(savedCred.encryptedData)) as { password: string; totpSecret?: string | null };
                  return { ...step, inlineUsername: savedCred.username, inlinePassword: password, inlineTotp: totpSecret ?? undefined } as WorkflowStep;
                } catch { logger.warn({ taskId, credentialId: ls.credentialId }, "Failed to decrypt saved credential"); }
              }
            }
          }
          return step;
        }),
      );

      const stepCount = effectiveStepsWithCreds.length;

      // Pre-flight URL check — PURELY INFORMATIONAL, never fatal.
      //
      // This is a plain server-side fetch: it does NOT go through the task's
      // proxy and is not a browser, so it dials the target from the server's
      // (datacenter) IP with non-browser headers. Cloudflare-protected or
      // geo-restricted sites routinely answer that with 403/503 even though the
      // real browser+proxy run would succeed. Treating a non-2xx here as fatal
      // therefore killed perfectly runnable tasks before the browser even tried.
      // We keep the check only as an early reachability hint and let the browser
      // step be the actual verdict.
      if (task.targetUrl && stepCount > 0) {
        try {
          emitTaskProgress(taskId, `Pre-checking URL: ${task.targetUrl}-¦`);
          const _ctrl = new AbortController();
          const _urlTimer = setTimeout(() => _ctrl.abort(), 10_000);
          let _preRes = await fetch(task.targetUrl, { method: "HEAD", redirect: "follow", signal: _ctrl.signal })
            .catch(() => fetch(task.targetUrl, { method: "GET", redirect: "follow", signal: _ctrl.signal }));
          clearTimeout(_urlTimer);
          const _ok = _preRes.status >= 200 && _preRes.status < 400;
          const _note = _ok
            ? `Precheck: HTTP ${_preRes.status}`
            : `Precheck: HTTP ${_preRes.status} (non-2xx from server IP; browser will retry via proxy)`;
          emitTaskProgress(taskId, `URL check: ${_note}-¦`);
          getTaskEmitter(taskId).emit("event", { type: "screenshot", message: _note });
          collectedStepLogs.unshift({ stepIndex: -1, type: "precheck", success: true, message: _note });
        } catch (urlErr) {
          const _urlMsg = urlErr instanceof Error ? urlErr.message : String(urlErr);
          emitTaskProgress(taskId, `⚠️ URL pre-check: ${_urlMsg} — proceeding`);
          logger.warn({ taskId, targetUrl: task.targetUrl, err: _urlMsg }, "URL pre-check failed — proceeding");
        }
      }


      throwIfCancelled(taskId); // proxy precheck / sing-box can take tens of seconds

      emitTaskProgress(taskId, stepCount > 0 ? `Running ${stepCount} workflow step${stepCount !== 1 ? "s" : ""}-¦` : "No steps configured-¦");

      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise: Promise<never> = timeoutMs
        ? new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error(`Task timed out after ${timeoutConfig.timeoutMinutes} min`)), timeoutMs); })
        : new Promise<never>(() => {});

      let cancelCheckInterval: ReturnType<typeof setInterval> | null = null;
      const cancelPromise: Promise<never> = new Promise<never>((_, reject) => {
        cancelCheckInterval = setInterval(() => { if (cancelRequested.has(taskId)) reject(new Error("Task cancelled by user")); }, 500);
      });

      const page = await browserProvider.newPage();
      // Browser launch is slow — honour a cancel made during it. The page/session
      // exists now but the try/finally that closes it hasn't been entered yet, so
      // tear it down by hand before throwing; otherwise cancelling at exactly this
      // moment would strand a browser session (and its proxy) with nothing to reap it.
      if (cancelRequested.has(taskId)) {
        await page.close().catch(() => {});
        throw new Error("Task cancelled by user");
      }
      screenshotPage = page;
      let finalPage = page;
      let screenshotPath: string | undefined;

      // ── Cookie mode on the cf-proxy backend ──────────────────────────────────
      // Playwright restores a session at CONTEXT creation via storageState, but the
      // SeleniumBase backend has no such concept — which is why enabling cookieMode
      // did nothing there. It does expose a cookie jar, so restore the saved cookies
      // onto the live page instead. Injection needs a same-origin document, hence
      // passing the target URL for the driver to land on first.
      const _canCookieJar =
        "setCookies" in page &&
        typeof (page as unknown as { setCookies?: unknown }).setCookies === "function";
      if (cookieModeEnabled && _canCookieJar && !dumpStorageState) {
        try {
          const saved = (await loadBrowserSession(taskId, cookieSessionKey)) as
            | { cookies?: Array<Record<string, unknown>> }
            | null;
          let jar = saved?.cookies ?? [];
          // Nothing saved yet → seed from the cookies pasted on the login step.
          // Only the site's login-ticket cookie is needed; its name is site-specific
          // (Pterodactyl/Laravel: remember_web_*), so we take a document.cookie-style
          // string rather than hard-coding names. Once a run succeeds the live jar is
          // persisted and takes over from the pasted seed.
          if (!jar.length) {
            const seed = parseCookieHeader(
              (cookieModeStep?.cookies as string | undefined) ?? "",
              cookieOriginUrl,
            );
            if (seed.length) {
              jar = seed;
              logger.info({ taskId, count: seed.length }, "Cookie mode — seeding from manually configured cookies");
            }
          }
          if (jar.length) {
            const added = await (page as unknown as {
              setCookies: (c: Array<Record<string, unknown>>, url?: string) => Promise<number>;
            }).setCookies(jar, cookieOriginUrl || undefined);
            emitTaskProgress(taskId, `Restored ${added} saved cookie(s)-¦`);
            logger.info({ taskId, cookieSessionKey, added, of: jar.length }, "Cookie mode — cookies restored (cf-proxy)");
          }
        } catch (ckErr) {
          logger.warn({ taskId, ckErr }, "Cookie mode — restore failed (continuing; login step will run)");
        }
      }

      // Replay budget for captcha IP-blocks. Per-task browserConfig.warpRotations wins,
      // else the env default. Each replay = one fresh exit IP + one full re-run.
      const maxIpRotations =
        ("maxProxyRotations" in page &&
        typeof (page as unknown as { maxProxyRotations?: unknown }).maxProxyRotations === "function"
          ? (page as unknown as { maxProxyRotations: () => number | null }).maxProxyRotations()
          : null) ?? Number(process.env.RECAPTCHA_MAX_IP_ROTATIONS ?? 5);
      let ipRotationsUsed = 0;
      let ipRotateError = "";

      try {
        // eslint-disable-next-line no-constant-condition
        for (;;) {
        let replay = false;
        await Promise.race([
          (async () => {
            let fullMessage = "";
            let overallSuccess = true;

            if (effectiveStepsWithCreds.length > 0) {
              let _stepCallbackIdx = 0;
              try {
                const { results: stepResults, finalPage: stepsPage } = await executeWorkflowSteps(
                  page, effectiveStepsWithCreds, DATA_DIR, taskId, creds, solver, task.targetUrl,
                  (r: StepResult) => {
                    const stepIdx = _stepCallbackIdx++;
                    collectedStepLogs.push({
                      stepIndex: stepIdx,
                      type: effectiveStepsWithCreds[stepIdx]?.type ?? "unknown",
                      success: r.success,
                      message: r.message,
                      screenshotPath: r.screenshotPath,
                      durationMs: r.durationMs,
                    });
                    // Always emit progress so the step appears in the live timeline,
                      // then also emit screenshot if one was captured so the thumbnail updates.
                      emitTaskProgress(taskId, r.message);
                      if (r.screenshotPath) {
                        getTaskEmitter(taskId).emit("event", { type: "screenshot", message: r.message, screenshotPath: r.screenshotPath });
                      }
                  },
                  // Actually stop the loop on cancel — the race alone only stopped
                  // waiting for it, leaving the steps driving the browser in the
                  // background after the user cancelled.
                  () => cancelRequested.has(taskId),
                );
                finalPage = stepsPage;
                fullMessage = stepResults.map((r) => r.message).join("\n");
                if (stepResults.some((r) => !r.success)) overallSuccess = false;
              } catch (err) {
                // ── Captcha refused the exit IP → rotate and REPLAY the workflow ──
                //
                // Only a different IP can change an "automated queries" refusal. We
                // replay from step 1 rather than retrying the captcha in place: the
                // captcha is often inside a modal that an earlier step opened
                // (host2play's "Renew server" dialog), so the only way to get a fresh
                // one issued to the new IP is to redo the actions that produced it.
                // (Retrying in place left the widget bound to the old IP; reloading to
                // force a re-issue destroyed the modal — "bframe not found".)
                if (
                  err instanceof CaptchaBlockedError &&
                  err.ipBlocked &&
                  !dryRun &&
                  ipRotationsUsed < maxIpRotations &&
                  "rotateProxy" in page &&
                  typeof (page as unknown as { rotateProxy?: unknown }).rotateProxy === "function"
                ) {
                  const rot = await (page as unknown as {
                    rotateProxy: () => Promise<{ ok: boolean; error?: string }>;
                  })
                    .rotateProxy()
                    .catch((e: unknown) => ({
                      ok: false,
                      error: e instanceof Error ? e.message : String(e),
                    }));
                  if (rot.ok) {
                    ipRotationsUsed++;
                    emitTaskProgress(
                      taskId,
                      `Captcha blocked this IP — rotated to a new exit IP, replaying the workflow (${ipRotationsUsed}/${maxIpRotations})-¦`,
                    );
                    logger.warn({ taskId, attempt: ipRotationsUsed, maxIpRotations }, "captcha IP-blocked — rotated exit IP, replaying workflow");
                    // Drop the aborted attempt's step logs so the run shows the attempt
                    // that actually decided the outcome, not a pile of partial ones.
                    collectedStepLogs.length = 0;
                    _stepCallbackIdx = 0;
                    await new Promise((r) => setTimeout(r, 1500)); // let the tunnel settle
                    replay = true;
                    return; // leave the IIFE; the outer loop re-runs the workflow
                  }
                  logger.warn({ taskId, reason: rot.error }, "captcha IP-blocked but rotation failed — not replaying");
                  ipRotateError = rot.error ?? "unknown error";
                }
                if (err instanceof CaptchaBlockedError) {
                  emitTaskProgress(taskId, "Captcha detected - taking screenshot-¦");
                  // A FAILED screenshot must NOT abandon the captcha log: if this threw,
                  // the whole handler was skipped and the run fell through to the outer
                  // catch — turning a detailed "captcha blocked" log (with steps + reason)
                  // into a blank "Error (retry …)". Capture the screenshot best-effort.
                  try {
                    const shot = await finalPage.screenshot({ type: "png" });
                    const buffer = Buffer.isBuffer(shot) ? shot : Buffer.from(shot as unknown as Uint8Array);
                    screenshotPath = await saveScreenshot(taskId, buffer);
                  } catch (shotErr) {
                    logger.warn({ taskId, shotErr }, "Captcha screenshot failed — logging the block without it");
                  }
                  // Say what happened with the IP, so "blocked" isn't confused with
                  // "we never actually tried another IP".
                  let ipNote = "";
                  if (err.ipBlocked) {
                    if (ipRotateError) {
                      ipNote = `\n\nIP rotation FAILED (${ipRotateError}) — every attempt used the SAME exit IP.`;
                    } else if (ipRotationsUsed > 0) {
                      ipNote = `\n\nStill blocked after ${ipRotationsUsed} IP rotation(s) (limit ${maxIpRotations}); the workflow was replayed from the start on each new IP.`;
                    } else if (maxIpRotations <= 0) {
                      ipNote = "\n\nIP rotation is disabled for this task (rotation limit is 0).";
                    } else if (!("rotateProxy" in page)) {
                      ipNote = "\n\nThis task's proxy cannot rotate its exit IP (set the proxy type to WARP to enable rotation).";
                    }
                  }
                  const msg = `${dryRun ? "[DRY RUN] " : ""}${err.message}${ipNote}\n\nA captcha screenshot has been saved.`;
                  // The captcha/CF step throws BEFORE executeWorkflowSteps records it, so
                  // the timeline would otherwise be empty for the very step that decided
                  // the outcome. Record it explicitly with the real reason + screenshot so
                  // a needs_attention run is actually debuggable.
                  collectedStepLogs.push({
                    stepIndex: collectedStepLogs.length,
                    type: "captcha",
                    success: false,
                    message: err.message,
                    screenshotPath,
                  });
                  emitTaskProgress(taskId, err.message);
                  if (screenshotPath) {
                    getTaskEmitter(taskId).emit("event", { type: "screenshot", message: err.message, screenshotPath });
                  }
                  await writeLog(taskId, false, msg, screenshotPath, Date.now() - startTime, dryRun ? "dry_run" : triggeredBy, collectedStepLogs);
                  if (!dryRun) await db.update(tasksTable).set({ status: "needs_attention", lastRunAt: new Date() }).where(eq(tasksTable.id, taskId));
                  // This branch returns early instead of falling through to the normal
                  // completion path, so it must re-schedule @after_completion tasks itself
                  // — otherwise a CF/captcha block leaves them with no next run and they
                  // silently stop repeating (they re-ran fine when this used to fall
                  // through to the normal path).
                  await schedulePostCompletionIfNeeded(taskId, dryRun);
                  emitTaskDone(taskId, false, dryRun ? "[DRY RUN] Captcha encountered" : "Task paused - captcha needs resolution");
                  logger.warn({ taskId, dryRun }, "Captcha encountered");
                  return;
                }
                try {
                  const fShot = await finalPage.screenshot({ type: "png" });
                  const fBuf = Buffer.isBuffer(fShot) ? fShot : Buffer.from(fShot as unknown as Uint8Array);
                  screenshotPath = await saveScreenshot(taskId, fBuf);
                  outerScreenshotPath = screenshotPath;
                } catch { /* ignore */ }
                throw err;
              }
            } else {
              fullMessage = "No steps configured";
            }

            // Skip the final screenshot when a step already captured a failure screenshot —
              // taking another one on top is redundant and confusing.
              // Always capture on success so the user can see the final page state.
              const hasStepFailScreenshot = collectedStepLogs.some(l => l.screenshotPath);
              if (overallSuccess || !hasStepFailScreenshot) {
                try {
                  emitTaskProgress(taskId, "Capturing final screenshot...");
                  const shot = await finalPage.screenshot({ type: "png", timeout: 8000 });
                  const buffer = Buffer.isBuffer(shot) ? shot : Buffer.from(shot as unknown as Uint8Array);
                  screenshotPath = await saveScreenshot(taskId, buffer);
                  if (screenshotPath) {
                    getTaskEmitter(taskId).emit("event", { type: "screenshot", message: `Postcheck screenshot|${finalPage.url()}`, screenshotPath });
                    collectedStepLogs.push({ stepIndex: stepCount, type: "postcheck", success: overallSuccess, message: `Postcheck: ${finalPage.url()}`, screenshotPath });
                  }
                } catch (screenshotErr) {
                  const screenshotErrMsg = screenshotErr instanceof Error ? screenshotErr.message : String(screenshotErr);
                  logger.warn({ taskId, err: screenshotErrMsg }, "Postcheck screenshot failed");
                  emitTaskProgress(taskId, `⚠️ Postcheck screenshot failed: ${screenshotErrMsg}`);
                  try {
                    if (finalPage !== page) {
                      const fb = await page.screenshot({ type: "png", timeout: 5000 });
                      const fbBuf = Buffer.isBuffer(fb) ? fb : Buffer.from(fb as unknown as Uint8Array);
                      screenshotPath = await saveScreenshot(taskId, fbBuf);
                      logger.warn({ taskId }, "Postcheck screenshot fell back to original page");
                    } else {
                      logger.warn({ taskId }, "Postcheck screenshot failed — page may have closed or timed out");
                    }
                  } catch { /* both pages unavailable */ }
                }
              }

            // A run that finished but FAILED gets a retry too — otherwise only
            // exceptions would, and a task that merely reports failure would sit idle
            // until its next schedule.
            const _retryNote = !dryRun && !overallSuccess ? await scheduleRetryIfConfigured(taskId) : "";
            if (dryRun) fullMessage = `[DRY RUN] ${fullMessage}`;
            await writeLog(taskId, overallSuccess, fullMessage + _retryNote, screenshotPath, Date.now() - startTime, dryRun ? "dry_run" : triggeredBy, collectedStepLogs);
            if (!dryRun) {
              await db.update(tasksTable).set({ status: overallSuccess ? "success" : "failed", lastRunAt: new Date() }).where(eq(tasksTable.id, taskId));
              // Success clears the failure streak so a future failure gets a full
              // retry allowance again.
              if (overallSuccess) {
                await db.update(tasksTable).set({ retryAttempt: 0 }).where(eq(tasksTable.id, taskId)).catch(() => {});
              }
            }
            // Cookie mode: persist the (possibly refreshed) session after a successful run.
            if (!dryRun && overallSuccess && cookieModeEnabled) {
              const _dumper = dumpStorageState as (() => Promise<unknown>) | null;
              if (_dumper) {
                try {
                  const state = await _dumper();
                  if (state) await saveBrowserSession(taskId, state, cookieSessionKey);
                } catch (persistErr) {
                  logger.warn({ taskId, persistErr }, "Failed to persist cookie-mode session");
                }
              } else if (
                "getCookies" in page &&
                typeof (page as unknown as { getCookies?: unknown }).getCookies === "function"
              ) {
                // cf-proxy backend: no storageState dumper — persist the cookie jar in
                // the same {cookies:[...]} shape so restore works either way.
                try {
                  const jar = await (page as unknown as {
                    getCookies: () => Promise<Array<Record<string, unknown>>>;
                  }).getCookies();
                  if (jar.length) {
                    await saveBrowserSession(taskId, { cookies: jar }, cookieSessionKey);
                    logger.info({ taskId, cookieSessionKey, count: jar.length }, "Cookie mode — jar persisted (cf-proxy)");
                  }
                } catch (persistErr) {
                  logger.warn({ taskId, persistErr }, "Failed to persist cookie-mode jar");
                }
              }
            }
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            emitTaskDone(taskId, overallSuccess, overallSuccess ? `Task completed in ${elapsed}s` : `Task failed after ${elapsed}s`);
            await schedulePostCompletionIfNeeded(taskId, dryRun);
            logger.info({ taskId, dryRun, success: overallSuccess }, "Task run completed");
          })(),
          timeoutPromise,
          cancelPromise,
        ]);
        // The captcha refused the old IP; we rotated and want the whole workflow
        // re-run against the new one. Anything else means this run is finished.
        if (!replay) break;
        }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (cancelCheckInterval) clearInterval(cancelCheckInterval);
        if (finalPage !== page) await finalPage.close().catch(() => {});
        await page.close().catch(() => {});
      }
    } catch (err) {
      // Never let the failure log come out blank OR be a useless bare "Error":
      // some errors carry an empty message, which made a retried run's log show only
      // "(retry N/M in Xm)" (or "Error") with no reason. When the message is empty,
      // surface the error TYPE + the first real stack frames so the log says WHERE it
      // was thrown, instead of swallowing it.
      let message: string;
      if (err instanceof Error) {
        const detail = (err.message || "").trim();
        if (detail) {
          message = detail;
        } else {
          const frames = (err.stack || "")
            .split("\n").map((s) => s.trim())
            .filter((s) => s.startsWith("at "))
            .slice(0, 4).join(" ← ");
          message = `${err.name || "Error"} (no message)${frames ? ` — ${frames}` : ""}`;
        }
      } else {
        message = String(err);
      }
      if (!message || !message.trim()) {
        message = "Task failed with no detail — see the failure screenshot and the cf-proxy / server logs.";
      }
      const isCancelled = message === "Task cancelled by user";
      logger.error({ taskId, dryRun, isCancelled, err }, "Task runner error");
      emitTaskDone(taskId, false, isCancelled ? "Task cancelled by user" : `Error: ${message}`);
      const errMsg = dryRun ? `[DRY RUN] ${message}` : message;
      if (!outerScreenshotPath && screenshotPage && !isCancelled) {
        try {
          const eShot = await screenshotPage.screenshot({ type: "png" });
          const eBuf = Buffer.isBuffer(eShot) ? eShot : Buffer.from(eShot as unknown as Uint8Array);
          outerScreenshotPath = await saveScreenshot(taskId, eBuf);
        } catch { /* ignore */ }
      }
      // Make the failure visible on the Run Timeline, not only in the top card: when the
      // run blew up before (or outside) any step recorded itself — a browser launch /
      // connect failure, an early throw — collectedStepLogs is empty and the timeline
      // shows nothing but the final screenshot. Add a terminal error node with the reason
      // + screenshot so the timeline always shows WHERE it failed.
      if (!isCancelled) {
        collectedStepLogs.push({
          stepIndex: collectedStepLogs.length,
          type: "error",
          success: false,
          message,
          screenshotPath: outerScreenshotPath,
        });
      }
      // Book a retry BEFORE writing the log so the message can say when it'll run.
      // Cancellations are deliberate — never retry those.
      const retryNote = !dryRun && !isCancelled ? await scheduleRetryIfConfigured(taskId) : "";
      await writeLog(taskId, false, errMsg + retryNote, outerScreenshotPath, Date.now() - startTime, dryRun ? "dry_run" : triggeredBy, collectedStepLogs);
      if (!dryRun) {
        await db.update(tasksTable).set({ status: isCancelled ? "idle" : "failed", lastRunAt: new Date() }).where(eq(tasksTable.id, taskId));
      }
    } finally {
      runningTasks.delete(taskId);
      cancelRequested.delete(taskId);
      if (semaphoreAcquired) releaseSemaphore();
    }
  }

  async function writeLog(
    taskId: number,
    success: boolean,
    message: string,
    screenshotPath?: string,
    durationMs?: number,
    triggeredBy?: string,
    stepLogs?: Array<{ stepIndex: number; type: string; success: boolean; message: string; screenshotPath?: string }>,
  ): Promise<void> {
    await db.insert(logsTable).values({
      taskId,
      success,
      message,
      screenshotPath: screenshotPath ?? null,
      durationMs: durationMs ?? null,
      triggeredBy: triggeredBy ?? null,
      stepLogs: (stepLogs && stepLogs.length > 0) ? stepLogs : null,
    });
  }
