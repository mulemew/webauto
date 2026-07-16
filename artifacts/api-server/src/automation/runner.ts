import path from "path";
  import fs from "fs";
  import { execFile } from "child_process";
  import { db, tasksTable, credentialsTable, savedCredentialsTable, logsTable, eq } from "@workspace/db";
  import { startLocalProxy } from "./proxy-manager";
  import { logger } from "../lib/logger";
  import { decrypt } from "../lib/encryption";
  import { createBrowserProvider } from "./browser-provider";
  import { createCaptchaSolverFromConfig } from "./captcha-solver";
  import { loadBrowserConfig, loadCaptchaConfig, loadTaskTimeoutConfig, loadConcurrencyConfig } from "../lib/appSettings";
  import { emitTaskProgress, emitTaskDone, getTaskEmitter, clearTaskEventBuffer } from "../lib/taskEvents";
  import { executeWorkflowSteps, CaptchaBlockedError, type WorkflowStep, type StepResult } from "./step-executor";
  import { loadBrowserSession, saveBrowserSession, clearBrowserSession, taskUsesCookieMode } from "../lib/browserSessionStore";

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

  export async function runTask(
    taskId: number,
    dryRun = false,
    triggeredBy: "manual" | "cron" | "dry_run" = "manual",
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

      // ── Cookie mode: restore + capture browser session (storage state) ──────
      // If any login step in this task enables cookie mode, seed the browser
      // context with the previously-saved storage state and register a dumper
      // so we can persist the updated session after a successful run.
      const _taskSteps = (task.steps as WorkflowStep[] | null) ?? [];
      const cookieModeStep = _taskSteps.find(
        (s) => s.type === "login" && (s as Record<string, unknown>).cookieMode === true,
      ) as (Record<string, unknown> | undefined);
      const cookieModeEnabled = !!cookieModeStep;
      const cookieSessionKey =
        (cookieModeStep?.sessionKey as string | undefined)?.trim() || "default";
      let dumpStorageState: (() => Promise<unknown>) | null = null;

      if (cookieModeEnabled) {
        const saved = await loadBrowserSession(taskId, cookieSessionKey);
        if (saved) {
          browserConfig.storageState = saved;
          emitTaskProgress(taskId, "Restored saved browser session (cookie mode)-¦");
          logger.info({ taskId, cookieSessionKey }, "Cookie mode — restored saved session");
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

      // ── Proxy precheck — FATAL when the proxy itself can't reach the target ──
      //
      // Unlike the informational check above (which dials from the server IP), this
      // goes THROUGH the task's proxy. If the tunnel is dead or the target is
      // unreachable via it, the whole run is doomed — better to fail in seconds than
      // to burn the browser + login + captcha budget first. We only treat a
      // *connection* failure as fatal: a reachable target answering 403/503 is
      // normal for non-browser requests behind Cloudflare, so that just informs.
      {
        const _bc = (task.browserConfig ?? {}) as { proxyUrl?: string; proxyType?: string };
        const _proxyUrl = (_bc.proxyUrl ?? "").trim();
        const _proxyType = (_bc.proxyType ?? "").trim();
        const _hasProxy = !!(_proxyUrl || _proxyType === "warp");
        if (_hasProxy && task.targetUrl && stepCount > 0) {
          emitTaskProgress(taskId, "Pre-checking proxy connectivity-¦");
          let _probe: Awaited<ReturnType<typeof startLocalProxy>> = null;
          try {
            _probe = await startLocalProxy({
              proxyUrl: _proxyUrl || undefined,
              proxyType: (_proxyType || undefined) as never,
            });
            if (_probe) {
              const _curlProxy = _probe.serverUrl.replace(/^socks5:\/\//i, "socks5h://");
              const _code = await new Promise<string>((resolve, reject) => {
                execFile(
                  "curl",
                  ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", "-x", _curlProxy, task.targetUrl],
                  { timeout: 25_000 },
                  (err, out) => (err ? reject(err) : resolve(String(out).trim())),
                );
              });
              // curl reports 000 when it never got an HTTP response (tunnel down,
              // DNS/connect refused, timeout) — that's the fatal case.
              if (_code === "000" || _code === "") {
                throw new Error(
                  `target is unreachable through the configured proxy (${_proxyType || "proxy"}) — ` +
                    `the proxy is down or the site is blocking it`,
                );
              }
              const _msg = `Proxy precheck: HTTP ${_code} via ${_proxyType || "proxy"}`;
              emitTaskProgress(taskId, `${_msg}-¦`);
              collectedStepLogs.unshift({ stepIndex: -1, type: "precheck", success: true, message: _msg });
            }
          } catch (proxyErr) {
            const _m = proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
            collectedStepLogs.unshift({ stepIndex: -1, type: "precheck", success: false, message: `Proxy precheck failed: ${_m}` });
            throw new Error(`Proxy precheck failed: ${_m}`);
          } finally {
            if (_probe) await _probe.stop().catch(() => {});
          }
        }
      }

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
          const jar = saved?.cookies ?? [];
          if (jar.length) {
            const added = await (page as unknown as {
              setCookies: (c: Array<Record<string, unknown>>, url?: string) => Promise<number>;
            }).setCookies(jar, task.targetUrl || undefined);
            emitTaskProgress(taskId, `Restored ${added} saved cookie(s)-¦`);
            logger.info({ taskId, cookieSessionKey, added, of: jar.length }, "Cookie mode — cookies restored (cf-proxy)");
          }
        } catch (ckErr) {
          logger.warn({ taskId, ckErr }, "Cookie mode — restore failed (continuing; login step will run)");
        }
      }

      try {
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
                );
                finalPage = stepsPage;
                fullMessage = stepResults.map((r) => r.message).join("\n");
                if (stepResults.some((r) => !r.success)) overallSuccess = false;
              } catch (err) {
                if (err instanceof CaptchaBlockedError) {
                  emitTaskProgress(taskId, "Captcha detected - taking screenshot-¦");
                  const shot = await finalPage.screenshot({ type: "png" });
                  const buffer = Buffer.isBuffer(shot) ? shot : Buffer.from(shot as unknown as Uint8Array);
                  screenshotPath = await saveScreenshot(taskId, buffer);
                  const msg = `${dryRun ? "[DRY RUN] " : ""}${err.message}\n\nA captcha screenshot has been saved.`;
                  await writeLog(taskId, false, msg, screenshotPath, Date.now() - startTime, dryRun ? "dry_run" : triggeredBy, collectedStepLogs);
                  if (!dryRun) await db.update(tasksTable).set({ status: "needs_attention", lastRunAt: new Date() }).where(eq(tasksTable.id, taskId));
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

            if (dryRun) fullMessage = `[DRY RUN] ${fullMessage}`;
            await writeLog(taskId, overallSuccess, fullMessage, screenshotPath, Date.now() - startTime, dryRun ? "dry_run" : triggeredBy, collectedStepLogs);
            if (!dryRun) {
              await db.update(tasksTable).set({ status: overallSuccess ? "success" : "failed", lastRunAt: new Date() }).where(eq(tasksTable.id, taskId));
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
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (cancelCheckInterval) clearInterval(cancelCheckInterval);
        if (finalPage !== page) await finalPage.close().catch(() => {});
        await page.close().catch(() => {});
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
      await writeLog(taskId, false, errMsg, outerScreenshotPath, Date.now() - startTime, dryRun ? "dry_run" : triggeredBy, collectedStepLogs);
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
