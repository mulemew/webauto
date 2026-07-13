import path from "path";
import fs from "fs";
import type { PageAdapter } from "./page-adapter";
import { logger } from "../lib/logger";
import { dismissPopups } from "./popup-handler";
import { clearCloudflareInterstitial, bypassCloudflareChallenge } from "./cloudflare-bypass";
import { detectAndHandleCaptcha } from "./captcha";
import { formLogin } from "./form-login";
import { githubLogin } from "./github-login";
import { googleLogin } from "./google-login";
import type { CaptchaSolver } from "./captcha-solver";
import type { DecryptedCredentials } from "./runner";
  import { db, savedCredentialsTable, eq } from "@workspace/db";
  import { decrypt } from "../lib/encryption";

export type ConditionType = "text_contains" | "text_not_contains" | "element_visible" | "element_not_visible" | "url_contains";

// An if/else branch action. Either performs a sub-step (click/fill/…), or is a
// control-flow action: continue to the next step, or end the whole task.
export interface ConditionalAction {
  type: "click" | "fill" | "navigate" | "wait" | "keypress" | "screenshot" | "scroll"
    | "continue" | "exitSuccess" | "exitFailure";
  selector?: string;
  selectorType?: "text" | "css" | "xpath";
  url?: string;
  value?: string;
  ms?: number;
  key?: string;
  x?: number;
  y?: number;
  /** For exitSuccess / exitFailure: an optional message recorded in the log. */
  message?: string;
}

export type WorkflowStep =
  | { type: "navigate"; url: string; timeout?: number }
  | { type: "click"; selector: string; selectorType: "text" | "css" | "xpath" }
  | { type: "fill"; selector: string; value: string }
  | { type: "select"; selector: string; value: string }
  | { type: "scroll"; selector?: string; x?: number; y?: number }
  | { type: "hover"; selector: string; selectorType: "css" | "xpath" }
  | { type: "wait"; ms: number }
  | { type: "waitFor"; selector: string; selectorType?: "css" | "text"; timeout?: number }
  | { type: "screenshot" }
  | { type: "dismissPopups" }
  | { type: "cfVerify"; url?: string; maxReloads?: number }
  | { type: "switchToNewPage"; timeout?: number }
  | { type: "keypress"; key: string }
  | { type: "login"; loginMethod: "form" | "github" | "google"; loginUrl: string; inlineUsername?: string; inlinePassword?: string; inlineTotp?: string; successSelector?: string; successText?: string; cookieMode?: boolean; sessionKey?: string }
  | { type: "condition"; conditionType: ConditionType; conditionValue: string; conditionSelector?: string; thenAction: ConditionalAction; elseAction?: ConditionalAction };

export interface StepResult {
  success: boolean;
  message: string;
  screenshotPath?: string;
  durationMs?: number;
}

/** Thrown by the login step when a captcha blocks authentication. */
export class CaptchaBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaBlockedError";
  }
}

/**
 * Thrown by a condition step's exitSuccess / exitFailure branch to END the whole
 * task early (like a return in an if/else). `succeeded` decides the task outcome.
 * Caught by the workflow loop, which records a final step result and stops.
 */
export class TaskExitError extends Error {
  constructor(public readonly succeeded: boolean, message: string) {
    super(message);
    this.name = "TaskExitError";
  }
}

// #9 — maximum allowed wait duration to prevent runner lockup
const MAX_WAIT_MS = 60_000;

// Auto-screenshot helper — captures page state for visual tracing.
  // Returns relative path (screenshots/filename) or undefined on any error.
  async function saveStepScreenshot(
    page: PageAdapter,
    dataDir: string,
    taskId: number,
    stepIndex: number,
    suffix: string,
  ): Promise<string | undefined> {
    try {
      if (page.isClosed()) return undefined;
      const shot = await page.screenshot({ type: "png", timeout: 8000 });
      const buffer = Buffer.isBuffer(shot) ? shot : Buffer.from(shot as unknown as Uint8Array);
      const screenshotsDir = path.join(dataDir, "screenshots");
      fs.mkdirSync(screenshotsDir, { recursive: true });
      const filename = `task-${taskId}-step${stepIndex + 1}-${suffix}-${Date.now()}.png`;
      fs.writeFileSync(path.join(screenshotsDir, filename), buffer);
      return `screenshots/${filename}`;
    } catch {
      return undefined;
    }
  }

  export async function executeWorkflowSteps(
  page: PageAdapter,
  steps: WorkflowStep[],
  dataDir: string,
  taskId: number,
  creds: DecryptedCredentials | null,
  solver: CaptchaSolver | null,
  targetUrl: string,
  onStepDone?: (result: StepResult) => void,
): Promise<{ results: StepResult[]; finalPage: PageAdapter }> {
  const results: StepResult[] = [];
  let currentPage = page;

  for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const label = `Step ${i + 1} [${step.type}]`;

      // Pre-step auto-recovery: if currentPage closed between steps (e.g. OAuth popup closed
      // after auth, window.close() from the page, etc.), switch to the sole remaining open
      // page before attempting the next step.
      // Only auto-switches when exactly ONE page is left — that is unambiguous.
      // Multiple open pages require an explicit switchToNewPage step from the user.
      if (currentPage.isClosed()) {
        const openPages = currentPage.getOpenPages().filter((p) => !p.isClosed());
        if (openPages.length === 1) {
          logger.info(
            { taskId, stepIndex: i, type: step.type, newUrl: openPages[0].url() },
            "currentPage closed between steps — auto-recovered to the sole remaining open page",
          );
          currentPage = openPages[0];
        }
        // 0 or multiple pages: fall through, let the step fail with a natural error message.
      }

      const _stepStart = Date.now();
      const MAX_STEP_RETRIES = 1;
      let _stepErr: unknown = null;
      let _stepResult: { message: string; newPage?: PageAdapter; screenshotPath?: string } | null = null;
      let _taskExit: TaskExitError | null = null;
      for (let _attempt = 0; _attempt <= MAX_STEP_RETRIES; _attempt++) {
        try {
          _stepResult = await executeStep(currentPage, step, dataDir, taskId, i, creds, solver, targetUrl);
          _stepErr = null;
          break;
        } catch (err) {
          if (err instanceof CaptchaBlockedError) throw err;
          // Intentional if/else exit — don't retry; end the task with this outcome.
          if (err instanceof TaskExitError) { _taskExit = err; break; }
          _stepErr = err;
          if (_attempt < MAX_STEP_RETRIES) {
            logger.warn({ taskId, stepIndex: i, type: step.type, attempt: _attempt + 1 }, "Step failed, retrying once");
            await new Promise<void>((r) => setTimeout(r, 2000));
          }
        }
      }
      if (_taskExit) {
        const screenshotPath = await saveStepScreenshot(currentPage, dataDir, taskId, i, "cond").catch(() => undefined);
        const exitResult: StepResult = {
          success: _taskExit.succeeded,
          message: `${label}: ${_taskExit.message}`,
          screenshotPath,
          durationMs: Date.now() - _stepStart,
        };
        results.push(exitResult);
        onStepDone?.(exitResult);
        logger.info({ taskId, stepIndex: i, succeeded: _taskExit.succeeded, msg: _taskExit.message }, "Task ended early by a condition step");
        break;
      }
      if (_stepErr !== null || !_stepResult) {
        const msg = _stepErr instanceof Error ? _stepErr.message : String(_stepErr);
        const failScreenshotPath = await saveStepScreenshot(currentPage, dataDir, taskId, i, "fail");
        const failResult: StepResult = { success: false, message: `${label} FAILED: ${msg}`, screenshotPath: failScreenshotPath, durationMs: Date.now() - _stepStart };
        results.push(failResult);
        onStepDone?.(failResult);
        logger.error({ taskId, stepIndex: i, type: step.type, err: _stepErr }, "Workflow step failed after retry");
        break;
      } else {
        const { message, newPage, screenshotPath } = _stepResult;
        if (newPage) currentPage = newPage;
        const result: StepResult = { success: true, message: `${label}: ${message}`, screenshotPath, durationMs: Date.now() - _stepStart };
        results.push(result);
        onStepDone?.(result);
        logger.info({ taskId, stepIndex: i, type: step.type }, "Workflow step completed");
      }
  }

  return { results, finalPage: currentPage };
}

interface StepExecResult {
  message: string;
  newPage?: PageAdapter;
  screenshotPath?: string;
}

/**
 * Poll for a captcha widget (reCAPTCHA / Turnstile / hCaptcha / ALTCHA) to appear
 * in the DOM, up to `timeoutMs`. Captcha widgets in modals (e.g. host2play's
 * "Verify that you're not a robot" dialog that opens after clicking Renew) load
 * asynchronously — checking once, too early, finds nothing and the step gives up.
 * Returns true as soon as any widget is present.
 */
async function waitForCaptchaWidget(page: PageAdapter, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ("fetchFrames" in page && typeof (page as { fetchFrames?: unknown }).fetchFrames === "function") {
      await (page as unknown as { fetchFrames: () => Promise<unknown> }).fetchFrames().catch(() => {});
    }
    const present = await page.evaluate(() => {
      // Require a RENDERED captcha iframe (width/height > 0), not just the
      // container (.g-recaptcha / [data-sitekey] / .cf-turnstile exist immediately,
      // before the widget script injects and renders its iframe — matching those
      // made cfVerify judge "not solved" before the reCAPTCHA had even appeared).
      const iframeSels = [
        "iframe[src*='recaptcha']", "iframe[src*='api2/anchor']", "iframe[src*='api2/bframe']",
        "iframe[src*='turnstile']", "iframe[src*='challenges.cloudflare.com']", "iframe[src*='hcaptcha']",
      ];
      for (const s of iframeSels) {
        const el = document.querySelector(s) as HTMLElement | null;
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
      }
      // Token input / ALTCHA controls only exist once the widget has mounted.
      if (document.querySelector("input[name='cf-turnstile-response']")) return true;
      if (document.querySelector("[class*='altcha' i] input, [class*='altcha' i] button")) return true;
      return false;
    }).catch(() => false) as boolean;
    if (present) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

async function executeStep(
  page: PageAdapter,
  step: WorkflowStep,
  dataDir: string,
  taskId: number,
  stepIndex: number,
  creds: DecryptedCredentials | null,
  solver: CaptchaSolver | null,
  targetUrl: string,
): Promise<StepExecResult> {
  switch (step.type) {
    case "navigate": {
      // #fix-navigate — use domcontentloaded instead of networkidle2 to avoid
      // timeouts on pages with continuous background requests (SPAs, polling, etc.)
      await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: step.timeout ?? 30000 });
      // ── Clear a full-page Cloudflare interstitial before continuing ───────
      // If the destination sits behind a CF challenge ("Just a moment…"),
      // subsequent steps (fill/click/waitFor) would operate on the challenge
      // page instead of the real content. Clear it up-front, at parity with the
      // SeleniumBase/cf-proxy backend's per-navigation uc_open_with_reconnect.
      try {
        await clearCloudflareInterstitial(page, { url: step.url });
      } catch (cfErr) {
        logger.warn({ url: step.url, cfErr }, "Cloudflare interstitial clear on navigate threw — continuing");
      }
      // Wait for URL to stabilize — JS SPAs often redirect after domcontentloaded.
      // Without this, subsequent steps may operate on an already-closed page.
      {
        let _lastUrl = page.url();
        let _stableMs = 0;
        const _POLL = 400;
        const _STABLE = 600; // URL stable for 0.6 s → settled
        const _deadline = Date.now() + 3000;
        while (Date.now() < _deadline) {
          await new Promise((r) => setTimeout(r, _POLL));
          const _cur = page.url();
          if (_cur !== _lastUrl) { _lastUrl = _cur; _stableMs = 0; }
          else { _stableMs += _POLL; if (_stableMs >= _STABLE) break; }
        }
      }
      await dismissPopups(page);
      // Auto-screenshot shows the landed page for visual tracing
        return { message: `Navigated to ${step.url} (landed on: ${page.url()})` };
    }

    case "click": {
      const urlBefore = page.url();

      if (step.selectorType === "text") {
        let found = await clickByText(page, step.selector);
        if (!found) {
          // The target may be gated behind a Cloudflare challenge/Turnstile that
          // only clears once passed. Clear it and retry the click once.
          if (await clearCloudflareIfPresent(page)) {
            found = await clickByText(page, step.selector);
          }
        }
        if (!found) throw new Error(`No visible element with text "${step.selector}" found`);
        await settleAfterClick(page, urlBefore);
        return { message: `Clicked element matching text "${step.selector}"` };
      }

      if (step.selectorType === "xpath") {
        const xpathSel = `xpath=${step.selector}`;
        await waitForSelectorWithCf(page, xpathSel, 5000);
        await page.click(xpathSel);
        await settleAfterClick(page, urlBefore);
        return { message: `Clicked XPath "${step.selector}"` };
      }

      await waitForSelectorWithCf(page, step.selector, 5000);
      await page.click(step.selector);
      await settleAfterClick(page, urlBefore);
      return { message: `Clicked CSS "${step.selector}"` };
    }

    case "fill": {
      await page.waitForSelector(step.selector, { timeout: 5000 });
      // #fix-fill — click to focus the element before clearing and typing.
      await page.click(step.selector);
      await page.evaluate((sel: string) => {
        const el = document.querySelector<HTMLInputElement>(sel);
        if (el) el.value = "";
      }, step.selector as unknown as never);
      await page.keyboard.type(step.value, { delay: 30 });
      return { message: `Filled "${step.selector}"` };
    }

    case "select": {
      await page.waitForSelector(step.selector, { timeout: 5000 });
      await page.evaluate(
        ({ sel, val }: { sel: string; val: string }) => {
          const el = document.querySelector<HTMLSelectElement>(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.value = val;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("input", { bubbles: true }));
        },
        { sel: step.selector, val: step.value } as unknown as never,
      );
      return { message: `Selected value "${step.value}" in "${step.selector}"` };
    }

    case "hover": {
      const sel = step.selectorType === "xpath" ? `xpath=${step.selector}` : step.selector;
      await page.waitForSelector(sel, { timeout: 5000 });
      await page.hover(sel);
      return { message: `Hovered over ${step.selectorType} "${step.selector}"` };
    }

    case "scroll": {
      if (step.selector) {
        await page.waitForSelector(step.selector, { timeout: 5000 });
        await page.evaluate((sel: string) => {
          const el = document.querySelector(sel);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }, step.selector as unknown as never);
        return { message: `Scrolled element "${step.selector}" into view` };
      }
      const x = step.x ?? 0;
      const y = step.y ?? 0;
      await page.evaluate(
        ({ sx, sy }: { sx: number; sy: number }) => window.scrollBy(sx, sy),
        { sx: x, sy: y } as unknown as never,
      );
      return { message: `Scrolled page by (${x}, ${y})` };
    }

    case "wait": {
      // #9 — cap wait duration to prevent runner lockup
      const clamped = Math.min(step.ms, MAX_WAIT_MS);
      if (clamped < step.ms) {
        logger.warn({ taskId, stepIndex, requested: step.ms, clamped }, "wait step ms clamped to MAX_WAIT_MS");
      }
      await new Promise((r) => setTimeout(r, clamped));
      return { message: `Waited ${clamped}ms${clamped < step.ms ? ` (requested ${step.ms}ms, capped at ${MAX_WAIT_MS}ms)` : ""}` };
    }

    case "waitFor": {
          const timeout = step.timeout ?? 120_000;
          const isTextWait = step.selectorType === "text" || step.selector.startsWith("text:");
          if (isTextWait) {
            const needle = step.selectorType === "text" ? step.selector : step.selector.slice("text:".length).trim();
            const deadline = Date.now() + timeout;
            while (true) {
              if (page.isClosed()) throw new Error(`waitFor aborted — page was closed before text "${needle}" appeared`);
              const bodyText = ((await page.evaluate(() => document.body?.innerText).catch(() => null)) ?? "") as string;
              if (bodyText.includes(needle)) break;
              if (Date.now() >= deadline) throw new Error(`Text "${needle}" did not appear within ${timeout}ms`);
              await new Promise((r) => setTimeout(r, 500));
            }
            return { message: `Text "${needle}" appeared within ${timeout}ms` };
          }
          await page.waitForSelector(step.selector, { timeout });
          return { message: `Element "${step.selector}" appeared within ${timeout}ms` };
        }

    case "screenshot": {
        // Note: if the page was closed BETWEEN steps (e.g. after OAuth popup closed),
        // the loop's pre-step auto-recovery already switched currentPage to the surviving
        // page before we got here.  We only need to guard against the page closing
        // DURING this screenshot call itself.
        if (page.isClosed()) {
          throw new Error(
            "Screenshot failed — the page is closed. " +
            "If a click opened a new tab, add a 'switchToNewPage' step; once that tab closes, " +
            "the executor auto-recovers to the remaining page for all subsequent steps.",
          );
        }
        let _shotBuffer: Buffer | null = null;
        try {
          const shot = await page.screenshot({ type: "png", timeout: 15000 });
          _shotBuffer = Buffer.isBuffer(shot) ? shot : Buffer.from(shot as unknown as Uint8Array);
        } catch (screenshotErr) {
          if (page.isClosed()) {
            throw new Error(
              "Screenshot failed — the page closed during capture. " +
              "The executor will auto-recover to the remaining open page on the next step.",
            );
          }
          const errMsg = screenshotErr instanceof Error ? screenshotErr.message : String(screenshotErr);
          if (errMsg.toLowerCase().includes("timeout")) {
            // 超时：强制立即截图，不等页面稳定/字体加载
            logger.warn({ taskId, stepIndex }, "Screenshot timed out — forcing immediate capture");
            try {
              const fallback = await page.screenshot({ type: "png", timeout: 5000 });
              _shotBuffer = Buffer.isBuffer(fallback) ? fallback : Buffer.from(fallback as unknown as Uint8Array);
            } catch {
              return { message: `Screenshot timed out and force-capture also failed — continuing (step ${stepIndex + 1})` };
            }
          } else {
            throw new Error(`Screenshot failed — ${errMsg}`);
          }
        }
        if (_shotBuffer && _shotBuffer.length > 0) {
          const screenshotsDir = path.join(dataDir, "screenshots");
          fs.mkdirSync(screenshotsDir, { recursive: true });
          const filename = `task-${taskId}-step${stepIndex + 1}-${Date.now()}.png`;
          fs.writeFileSync(path.join(screenshotsDir, filename), _shotBuffer);
          return { message: `Screenshot captured (step ${stepIndex + 1})`, screenshotPath: `screenshots/${filename}` };
        }
        return { message: `Screenshot timed out — page not stable, skipped (step ${stepIndex + 1})` };
      }

    case "switchToNewPage": {
      const timeout = step.timeout ?? 30000;
      const newPage = await page.waitForNewPage({ timeout });
      return { message: `Switched to new page: ${newPage.url()}`, newPage };
    }

    case "dismissPopups": {
      const result = await dismissPopups(page);
      return {
        message: result.dismissed > 0
          ? `Dismissed ${result.dismissed} popup/overlay item(s): ${result.details.join(", ")}`
          : "No popups or overlays found to dismiss",
      };
    }

    case "cfVerify": {
      // Explicitly clear a bot-gate that is blocking the current page (or a
      // freshly-navigated URL) before a later click/fill step whose target only
      // becomes interactive once the challenge has passed.
      //
      // Handles BOTH:
      //   • Cloudflare "Verifying you are human" / Turnstile interstitials, and
      //   • Embedded widget captchas (ALTCHA, reCAPTCHA/hCaptcha/Turnstile,
      //     GeeTest, etc.) — e.g. the "Protected by ALTCHA" checkbox on the
      //     ikuuu renew dialog, which is NOT a Cloudflare challenge.

      // Give a slow-loading widget time to render before we look for it. Modals
      // (e.g. host2play's "Verify that you're not a robot" dialog opened by a
      // Renew click) inject the reCAPTCHA a moment after opening — checking once,
      // too early, found nothing and the step silently did nothing.
      const appeared = await waitForCaptchaWidget(page, 25000);
      if (appeared) {
        logger.info("cfVerify — captcha widget rendered");
        // Give the freshly-rendered widget a moment to become interactive before
        // we click/solve it (avoids acting on a half-mounted iframe).
        await new Promise((r) => setTimeout(r, 1200));
      } else {
        logger.info("cfVerify — no captcha widget rendered within wait; proceeding (may be a full-page CF interstitial or already clear)");
      }

      // ── cf-proxy (SeleniumBase) fast-path ────────────────────────────────
      // Under the SeleniumBase backend the login step solves embedded Turnstile
      // widgets through cf-proxy's NATIVE uc_gui_click_captcha clicker
      // (POST /click-turnstile, exposed here as page.clickTurnstile). The
      // generic clearCloudflareInterstitial → detectAndHandleCaptcha path below
      // relies on frames()/CDP coordinate clicks that are NOT wired to that
      // native clicker, so on cf-proxy those clicks land off-target and the
      // widget verification fails even though the identical widget passes in the
      // login step. Give cfVerify the SAME verification path as login: when the
      // adapter exposes the native clicker AND a Turnstile widget is present,
      // click it natively first and short-circuit on success.
      if (
        "clickTurnstile" in page &&
        typeof (page as unknown as { clickTurnstile?: unknown }).clickTurnstile === "function"
      ) {
        try {
          if ("fetchFrames" in page && typeof (page as any).fetchFrames === "function") {
            await (page as any).fetchFrames();
          }
          const hasTurnstile = await page.evaluate(() => {
            if (document.querySelector("input[name='cf-turnstile-response']")) return true;
            if (document.querySelector(".cf-turnstile")) return true;
            if (
              document.querySelector(
                "iframe[src*='turnstile'], iframe[src*='challenges.cloudflare.com']",
              )
            )
              return true;
            const host = document.querySelector<HTMLElement>("[data-sitekey]");
            const key = host?.dataset.sitekey ?? host?.getAttribute("data-sitekey");
            return !!key && /^0x/i.test(key);
          }).catch(() => false) as boolean;

          if (hasTurnstile) {
            logger.info("cfVerify — Turnstile widget present; using cf-proxy native clickTurnstile (login-step parity)");
            const solved = await (page as unknown as { clickTurnstile: (n?: number) => Promise<boolean> })
              .clickTurnstile(2)
              .catch(() => false);
            if (solved) {
              return { message: "Cloudflare verification cleared via cf-proxy native Turnstile click." };
            }
            // The native clicker already clicked but the token never populated. Do
            // NOT fall through to clearCloudflareInterstitial + detectAndHandleCaptcha
            // (those would re-click the SAME Turnstile and mash it into "Verification
            // failed"). Crucially, FAIL the step instead of returning success: an
            // unsolved Turnstile means the gate is still up, so a later "Renew"/submit
            // step would run against a blocked page. Surface it as a captcha block
            // (task → needs_attention), the same way login treats an unsolved gate.
            logger.warn("cfVerify — native clickTurnstile did not solve the Turnstile; failing the step (gate still up). Likely an IP/fingerprint wall.");
            throw new CaptchaBlockedError(
              "Turnstile widget present but not solved by the native clicker (gate still up). " +
                "Not re-clicking to avoid a 'Verification failed' from mashing. " +
                "If it used to pass, try FINGERPRINT_OS=windows or a residential/cleaner proxy IP.",
            );
          }
        } catch (err) {
          logger.debug({ err }, "cfVerify native clickTurnstile fast-path threw — falling back");
        }
      }

      const cleared = await clearCloudflareInterstitial(page, {
        url: step.url || page.url(),
        maxReloads: step.maxReloads ?? 2,
      });

      // After any CF interstitial is out of the way, drive an embedded captcha
      // widget (ALTCHA / token / click-to-verify) to a solved state if present.
      let widgetMsg = "";
      try {
        const captchaResult = await detectAndHandleCaptcha(page, solver);
        if (captchaResult.detected) {
          widgetMsg = captchaResult.solved
            ? ` Widget captcha handled: ${(captchaResult as { message: string }).message}`
            : captchaResult.needsAttention
              ? ` Widget captcha needs attention: ${(captchaResult as { message: string }).message}`
              : ` Widget captcha detected but not solved: ${(captchaResult as { message: string }).message}`;
          if (!captchaResult.solved && captchaResult.needsAttention) {
            throw new CaptchaBlockedError((captchaResult as { message: string }).message);
          }
        }
      } catch (err) {
        if (err instanceof CaptchaBlockedError) throw err;
        logger.debug({ err }, "cfVerify widget captcha handling threw");
      }

      return {
        message:
          (cleared
            ? "Cloudflare verification cleared (or none present)."
            : "Cloudflare verification could not be confirmed cleared — continuing.") + widgetMsg,
      };
    }

    case "keypress": {
      await page.keyboard.press(step.key);
      return { message: `Pressed key "${step.key}"` };
    }

    case "login": {
      const loginUrl = step.loginUrl || targetUrl;
      logger.info({ taskId, stepIndex, loginMethod: step.loginMethod, loginUrl }, "Executing login step");

      // ── Cookie mode: skip login if a restored session is still valid ──────
      // When cookieMode is on, the runner seeds the browser context with the
      // task's previously-saved storage state (cookies + localStorage). Before
      // spending a full login attempt, navigate to the login/target URL and
      // check whether we're already authenticated. If so, skip login entirely.
      const cookieMode = (step as Record<string, unknown>).cookieMode === true;
      if (cookieMode) {
        try {
          await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
          await dismissPopups(page);
          const alreadyIn = await isSessionAuthenticated(page, step.successSelector, step.successText);
          if (alreadyIn) {
            logger.info({ taskId, stepIndex }, "Cookie mode — existing session detected, skipping login");
            return { message: "Session restored from saved cookies — login skipped" };
          }
          logger.info({ taskId, stepIndex }, "Cookie mode — no valid session, performing full login");
        } catch (probeErr) {
          logger.warn({ taskId, stepIndex, probeErr }, "Cookie-mode session probe failed — performing full login");
        }
      }

      // Resolve per-step saved credential if credentialId is present,
      // otherwise fall back to inline values or task-level credentials.
      let stepCreds = creds;
      const credentialId = (step as Record<string, unknown>).credentialId as number | undefined;
      if (credentialId) {
        try {
          const [savedCred] = await db
            .select()
            .from(savedCredentialsTable)
            .where(eq(savedCredentialsTable.id, credentialId));
          if (savedCred) {
            const dec = JSON.parse(decrypt(savedCred.encryptedData)) as {
              password: string;
              totpSecret?: string | null;
            };
            stepCreds = {
              username: savedCred.username,
              password: dec.password,
              totpSecret: dec.totpSecret ?? undefined,
            };
          }
        } catch (credErr) {
          logger.warn({ taskId, stepIndex, credentialId, credErr }, "Failed to load saved credential, falling back to task-level creds");
        }
      }
      const username = step.inlineUsername || stepCreds?.username;
      const password = step.inlinePassword || stepCreds?.password;
      const totpSecret = step.inlineTotp || stepCreds?.totpSecret;

      if (!username || !password) {
        throw new Error(
          "Login step requires credentials. Please select a saved credential or enter inline username/password.",
        );
      }

      const MAX_LOGIN_RETRIES = 2;
        let lastLoginErr: Error | null = null;
        let loginResult!: { success: boolean; captchaBlocked: boolean; message: string };

        for (let attempt = 0; attempt <= MAX_LOGIN_RETRIES; attempt++) {
          try {
            if (attempt > 0) {
              logger.info({ taskId, stepIndex, attempt }, "Retrying login step");
              await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
            if (step.loginMethod === "github") {
              loginResult = await githubLogin(page, loginUrl, { username, password, totpSecret }, solver, step.successText, step.successSelector);
            } else if (step.loginMethod === "google") {
              loginResult = await googleLogin(page, loginUrl, { username, password, totpSecret }, solver, step.successText, step.successSelector);
            } else {
              loginResult = await formLogin(page, loginUrl, { username, password, totpSecret }, solver, step.successSelector, totpSecret, step.successText);
            }
            if (loginResult.captchaBlocked) throw new CaptchaBlockedError(loginResult.message);
            if (!loginResult.success) {
              // GitHub OAuth: a CONCLUDED failure (redirected back to login /
              // rate-limited) won't fix itself on an immediate retry, and hammering
              // a rate-limited GitHub only deepens the block. Fail fast rather than
              // burning MAX_LOGIN_RETRIES. (Thrown/transient errors still retry via
              // the catch below.)
              const failFast = step.loginMethod === "github";
              if (!failFast && attempt < MAX_LOGIN_RETRIES) {
                lastLoginErr = new Error(`Login attempt ${attempt + 1} failed: ${loginResult.message}`);
                logger.warn({ taskId, stepIndex, attempt, msg: loginResult.message }, "Login attempt failed, retrying");
                continue;
              }
              throw new Error(
                failFast
                  ? `Login failed: ${loginResult.message}`
                  : `Login failed after ${MAX_LOGIN_RETRIES + 1} attempts: ${loginResult.message}`,
              );
            }
            return { message: attempt > 0 ? `${loginResult.message} (attempt ${attempt + 1})` : loginResult.message };
          } catch (retryErr) {
            if (retryErr instanceof CaptchaBlockedError) throw retryErr;
            if (attempt >= MAX_LOGIN_RETRIES) throw retryErr;
            lastLoginErr = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
            logger.warn({ taskId, stepIndex, attempt, err: lastLoginErr.message }, "Login threw, retrying");
          }
        }
        throw lastLoginErr ?? new Error("Login failed");
    }

    case "condition": {
        const { conditionType, conditionValue, conditionSelector, thenAction } = step;
        // Evaluate the condition — wrap in try/catch so page errors (stale frame,
        // navigation, etc.) are treated as "not met" rather than hard-failing the task.
        let conditionMet = false;
        let evalWarning: string | undefined;

        try {
          switch (conditionType) {
            case "text_contains": {
              const bodyText = ((await page.evaluate(() => document.body?.innerText).catch(() => null)) ?? "") as string;
              conditionMet = bodyText.includes(conditionValue);
              break;
            }
            case "text_not_contains": {
              const bodyText2 = ((await page.evaluate(() => document.body?.innerText).catch(() => null)) ?? "") as string;
              conditionMet = !bodyText2.includes(conditionValue);
              break;
            }
            case "element_visible": {
              const sel = conditionSelector || conditionValue;
              const el = await page.$(sel);
              if (el) {
                conditionMet = await el.evaluate((e: Element) => {
                  const r = e.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                }).catch(() => false) as boolean;
              }
              break;
            }
            case "element_not_visible": {
              const sel2 = conditionSelector || conditionValue;
              const el2 = await page.$(sel2);
              if (!el2) {
                conditionMet = true;
              } else {
                const visible = await el2.evaluate((e: Element) => {
                  const r = e.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                }).catch(() => false) as boolean;
                conditionMet = !visible;
              }
              break;
            }
            case "url_contains": {
              conditionMet = page.url().includes(conditionValue);
              break;
            }
          }
        } catch (evalErr) {
          // Condition evaluation threw (e.g. page detached, navigation in progress).
          // Treat as "not met" so the task can continue rather than hard-failing.
          evalWarning = evalErr instanceof Error ? evalErr.message : String(evalErr);
          conditionMet = false;
        }

        // ── if / else ──────────────────────────────────────────────────────
        // Condition NOT met is never a failure by itself — it just selects the
        // else branch (which defaults to "continue", preserving old behavior).
        const branch = conditionMet ? "then" : "else";
        const action: ConditionalAction = conditionMet
          ? thenAction
          : (step.elseAction ?? { type: "continue" });
        const condDesc = `${conditionType}: "${conditionValue}"`;
        const metWord = conditionMet ? "met" : "not met";
        const evalNote = !conditionMet && evalWarning ? ` (eval warning: ${evalWarning})` : "";

        // Control-flow branches.
        if (!action || action.type === "continue") {
          const shot = await saveStepScreenshot(page, dataDir, taskId, stepIndex, "cond");
          return { message: `Condition ${metWord} (${condDesc}) → ${branch}: continue${evalNote}`, screenshotPath: shot };
        }
        if (action.type === "exitSuccess") {
          throw new TaskExitError(true, `Condition ${metWord} (${condDesc}) → ${branch}: exit task (success)${action.message ? ` — ${action.message}` : ""}`);
        }
        if (action.type === "exitFailure") {
          throw new TaskExitError(false, `Condition ${metWord} (${condDesc}) → ${branch}: exit task (failure)${action.message ? ` — ${action.message}` : ""}`);
        }

        // Otherwise it's a sub-step action — run it. A FAILURE here aborts the task
        // like a normal step (the user asked for this): only the condition itself
        // not matching is non-fatal (handled by the else/continue branch above).
        const subStep = action as unknown as WorkflowStep;
        const subResult = await executeStep(page, subStep, dataDir, taskId, stepIndex, creds, solver, targetUrl);
        const condShot = subResult.screenshotPath ?? await saveStepScreenshot(subResult.newPage ?? page, dataDir, taskId, stepIndex, "cond");
        return { message: `Condition ${metWord} (${condDesc}) → ${branch}: ${subResult.message}`, newPage: subResult.newPage, screenshotPath: condShot };
      }
  
    default: {
      const exhaustive: never = step;
      throw new Error(`Unknown step type: ${(exhaustive as WorkflowStep).type}`);
    }
  }
}

/**
 * After a click, briefly check whether it triggered a page navigation.
 * If the URL changed or the page entered a loading state, wait for the
 * navigation to settle so subsequent steps don't operate on a stale page.
 *
 * This is intentionally lightweight (no hard timeout) — it only kicks in
 * when the click actually causes a detectable navigation.
 */
async function settleAfterClick(page: PageAdapter, urlBefore: string): Promise<void> {
  // If the page was closed by the click (e.g. window.close()), bail out
  // immediately — there's nothing to wait for.
  if (page.isClosed()) return;

  // Small delay to let any synchronous JS navigation (location.href = ...)
  // or history.pushState take effect before we sample the URL.
  await new Promise((r) => setTimeout(r, 150));
  if (page.isClosed()) return;

  try {
    const urlAfter = page.url();
    if (urlAfter !== urlBefore) {
      try {
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 });
      } catch (navErr) {
        const navMsg = navErr instanceof Error ? navErr.message : String(navErr);
        if (/closed|detached|destroyed|Target closed/i.test(navMsg)) throw navErr;
      }
    }
  } catch {
    // page.url() / waitForNavigation can throw if the page was destroyed
  }
}

async function isSessionAuthenticated(
  page: PageAdapter,
  successSelector?: string,
  successText?: string,
): Promise<boolean> {
  if (successText) {
    try {
      const bodyText = (await page.evaluate(() => document.body?.innerText).catch(() => "")) as string;
      if (bodyText.includes(successText)) return true;
    } catch {}
  }
  if (successSelector) {
    try {
      const el = await page.$(successSelector);
      if (el) {
        const visible = await el.evaluate((e: Element) => {
          const style = window.getComputedStyle(e);
          const rect = e.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
        }).catch(() => false) as boolean;
        if (visible) return true;
      }
    } catch {}
  }
  const bodyText = (await page.evaluate(() => document.body?.innerText).catch(() => "")) as string;
  return /logout|sign out|sign-out|dashboard|account|profile|welcome/i.test(bodyText);
}

/**
 * Clear a Cloudflare challenge / Turnstile widget if one is currently blocking
 * the page. Returns true when a challenge was detected AND cleared (so the
 * caller should retry its action), false when there was nothing to clear or it
 * could not be cleared. Safe to call unconditionally.
 */
async function clearCloudflareIfPresent(page: PageAdapter): Promise<boolean> {
  try {
    const result = await bypassCloudflareChallenge(page);
    if (result === "passed") {
      logger.info("Cloudflare challenge cleared before continuing step");
      return true;
    }
    return false;
  } catch (err) {
    logger.debug({ err }, "clearCloudflareIfPresent threw — ignoring");
    return false;
  }
}

/**
 * waitForSelector that transparently clears a Cloudflare challenge/Turnstile if
 * the selector does not appear in time. Some flows (e.g. a renew/check-in
 * button) only become clickable after a CF interstitial or Turnstile widget is
 * passed. If the first wait times out, we attempt to clear the challenge and
 * wait once more before surfacing the original error.
 */
async function waitForSelectorWithCf(
  page: PageAdapter,
  selector: string,
  timeout: number,
): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout });
    return;
  } catch (firstErr) {
    if (page.isClosed()) throw firstErr;
    const cleared = await clearCloudflareIfPresent(page);
    if (!cleared) throw firstErr;
    await page.waitForSelector(selector, { timeout });
  }
}

async function clickByText(page: PageAdapter, text: string): Promise<boolean> {
  // #fix-clickByText — STRICT matching: exact text, case-sensitive.
  // No lowercasing and no partial/`includes` fallback, so "Login" never matches
  // "login" and "Log" never matches "Login". The click target must equal the
  // element's trimmed text (or value / aria-label) exactly.
  const target = text.trim();
  // Find a VISIBLE **and ENABLED** match, tag it, scroll it into view, then click.
  // Retry for a few seconds: buttons often render DISABLED until their state
  // loads — e.g. minestrator's "Spin the wheel" keeps the text "Spin the wheel"
  // but stays disabled until the wheel-availability API resolves. clicking a
  // disabled button silently does nothing, yet the old code (which only checked
  // visibility, not disabled) "found" it and reported success. Waiting for it to
  // become enabled is what makes the click actually land.
  const deadline = Date.now() + 8000;
  let found = false;
  while (Date.now() < deadline) {
    found = await page.evaluate((btnText: unknown) => {
      document.querySelectorAll("[data-wa-textclick]").forEach((e) => e.removeAttribute("data-wa-textclick"));
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, a, input[type='button'], input[type='submit'], [role='button']",
        ),
      );
      const isClickable = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return false;
        if ((el as HTMLButtonElement | HTMLInputElement).disabled) return false;
        if (el.getAttribute("aria-disabled") === "true") return false;
        return true;
      };
      const getElText = (el: HTMLElement): string =>
        (el.textContent || (el instanceof HTMLInputElement ? el.value : "") || el.getAttribute("aria-label") || "").trim();
      for (const el of candidates) {
        if (getElText(el) === (btnText as string) && isClickable(el)) {
          el.setAttribute("data-wa-textclick", "1");
          try { el.scrollIntoView({ block: "center", inline: "center" }); } catch { /* ignore */ }
          return true;
        }
      }
      return false;
    }, target as never) as boolean;
    if (found) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!found) return false;
  await new Promise((r) => setTimeout(r, 200)); // let the scroll settle

  // Track which path landed. A real adapter click is a TRUSTED event
  // (isTrusted=true); the synthetic fallback is NOT — buttons that gate an action
  // on event.isTrusted (e.g. a reward-wheel spin) fire their handler either way
  // but silently skip the real action on an untrusted click. Logging this makes
  // "step succeeded but nothing happened" diagnosable.
  let clickPath = "real";
  try {
    await page.click("[data-wa-textclick='1']"); // real, trusted click via the backend
  } catch (err) {
    clickPath = "synthetic-fallback";
    logger.warn({ text: target, err: err instanceof Error ? err.message : String(err) },
      "clickByText: real click threw — falling back to a synthetic (untrusted) click");
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("[data-wa-textclick='1']");
      if (el) el.click(); // synthetic fallback
    }).catch(() => {});
  }
  logger.info({ text: target, clickPath }, "clickByText click dispatched");
  await page.evaluate(() => {
    document.querySelector("[data-wa-textclick]")?.removeAttribute("data-wa-textclick");
  }).catch(() => {});
  return true;
}
