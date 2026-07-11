import type { PageAdapter } from "./page-adapter";
  import { logger } from "../lib/logger";
  import { attachPopupHandler, dismissPopups } from "./popup-handler";
  import { detectAndHandleCaptcha } from "./captcha";
  import { clearCloudflareInterstitial } from "./cloudflare-bypass";
  import type { CaptchaSolver } from "./captcha-solver";
  import crypto from "crypto";


  // ── TOTP helper (auto-fill 2FA screens after form submit) ──────────────────
  function decodeBase32(s: string): Buffer {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
    let bits = "";
    for (const c of clean) {
      const v = alphabet.indexOf(c);
      if (v < 0) continue;
      bits += v.toString(2).padStart(5, "0");
    }
    const byteCount = Math.floor(bits.length / 8);
    const bytes = Buffer.alloc(byteCount);
    for (let i = 0; i < byteCount; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    return bytes;
  }

  function generateTOTP(secret: string, digits = 6, period = 30): string {
    const key = decodeBase32(secret);
    const counter = Math.floor(Date.now() / 1000 / period);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hash = crypto.createHmac("sha1", key).update(buf).digest();
    const offset = hash[hash.length - 1] & 0x0f;
    const code =
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      hash[offset + 3];
    return (code % 10 ** digits).toString().padStart(digits, "0");
  }

  export interface FormCredentials {
    username: string;
    password: string;
    /** Base32 TOTP secret — auto-fills 2FA screens after form submit */
    totpSecret?: string;
  }

  export interface LoginResult {
    success: boolean;
    captchaBlocked: boolean;
    message: string;
  }

  const USERNAME_SELECTORS = [
    "input[type='email']",
    "input[name='email']",
    "input[name='username']",
    "input[name='user']",
    "input[name='login']",
    "input[name='identifier']",
    "input[autocomplete='email']",
    "input[autocomplete='username']",
    "input[id*='email' i]",
    "input[id*='user' i]",
    "input[id*='login' i]",
    "input[placeholder*='email' i]",
    "input[placeholder*='username' i]",
    "input[type='text']",
  ];

  const PASSWORD_SELECTORS = [
    "input[type='password']",
    "input[name='password']",
    "input[name='pass']",
    "input[autocomplete='current-password']",
    "input[id*='pass' i]",
    "input[placeholder*='password' i]",
  ];

  /** Find a visible element matching one of the selectors, retrying for lazy-loaded SPAs. */
  async function findSelector(page: PageAdapter, selectors: string[], timeoutMs = 8000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.evaluate((e: Element) => {
            const style = window.getComputedStyle(e);
            const rect = e.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
          });
          if (visible) return sel;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  /**
   * Wait for the page to settle after submitting a login form.
   * Polls until the URL stops changing for 1.5 s, or the deadline passes.
   */
  async function waitForSettle(page: PageAdapter, maxMs = 8000): Promise<void> {
    // Give the browser a moment to kick off any redirect before we start
    // measuring URL stability — without this a slow server-side redirect can
    // fool the loop into thinking the URL is already settled.
    await sleep(1000);
    const deadline = Date.now() + maxMs;
    let lastUrl = page.url();
    let stableFor = 0;
    const POLL = 400;
    const STABLE_THRESHOLD = 1500;

    while (Date.now() < deadline) {
      await sleep(POLL);
      const cur = page.url();
      if (cur === lastUrl) {
        stableFor += POLL;
        if (stableFor >= STABLE_THRESHOLD) return; // URL stable for 1.5 s → settled
      } else {
        lastUrl = cur;
        stableFor = 0; // URL still changing — reset
      }
    }
  }

  /**
   * Determine whether login succeeded by inspecting the page state —
   * NOT by comparing URLs, which is unreliable for SPAs and OAuth redirects.
   *
   * Heuristics (in order):
   * 1. Visible error message on page → failure
   * 2. Login form fields still visible → failure (page didn't advance)
   * 3. URL changed away from targetUrl → success
   * 4. Login form fields gone, no error → success (SPA replaced the form)
   */
  async function detectLoginOutcome(
    page: PageAdapter,
    targetUrl: string,
    successSelector?: string,
    submitSel?: string,
    successText?: string,
  ): Promise<{ success: boolean; reason: string }> {
    const normalize = (u: string) => u.replace(/\/+$/, "").split("?")[0].split("#")[0];

    // 0a. User-defined success text
      if (successText) {
        try {
          const bodyText = await page.evaluate(() => document.body.innerText) as string;
          if (bodyText.includes(successText)) return { success: true, reason: `Found text: "${successText}"` };
        } catch { /* ignore */ }
      }

      // 0. User-defined success selector — definitive positive signal
    if (successSelector) {
      try {
        const el = await page.$(successSelector);
        if (el) {
          const visible = await el.evaluate((e: Element) => {
            const style = window.getComputedStyle(e);
            const rect = e.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
          }) as boolean;
          if (visible) return { success: true, reason: `Success selector "${successSelector}" is visible` };
        }
      } catch {
        // Invalid selector or element not found — fall through
      }
    }

    // 1. URL changed → success (most reliable signal)
    const finalUrl = page.url();
    if (normalize(finalUrl) !== normalize(targetUrl)) {
      return { success: true, reason: `Navigated to: ${finalUrl}` };
    }

    // 2. URL is the same — look for visible error messages
    const errorText = await page.evaluate(() => {
      const ERROR_SELS = [
        ".error-message", ".alert-danger", ".alert-error", ".error",
        "[class*='error' i]:not(input):not(label)",
        "[class*='invalid' i]:not(input):not(label)",
        "[role='alert']", "[aria-live='assertive']",
        "p.text-red-500", "span.text-red-500", "div.text-red-600",
      ];
      for (const sel of ERROR_SELS) {
        const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
        for (const el of els) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const text = el.textContent?.trim() ?? "";
          if (
            style.display !== "none" && style.visibility !== "hidden" &&
            rect.width > 0 && text.length > 3 && text.length < 300
          ) {
            return text;
          }
        }
      }
      return "";
    }) as string;

    if (errorText) {
      return { success: false, reason: `Login error message: "${errorText}"` };
    }

    // 3. Check for common post-login indicators before checking button visibility.
    //    Many SPAs keep the submit button in DOM briefly while updating the page.
    const hasPostLoginIndicator = await page.evaluate(() => {
      // Look for elements that typically appear only after login
      const POST_LOGIN_SELS = [
        "[class*='avatar' i]", "[class*='user-menu' i]", "[class*='profile' i]",
        "[class*='dashboard' i]", "[class*='welcome' i]", "[class*='logout' i]",
        "a[href*='logout']", "a[href*='sign-out']", "a[href*='signout']",
        "button[class*='logout' i]", "[data-user]", "[data-username]",
        "img[class*='avatar' i]", ".user-info", ".user-name", "#user-menu",
      ];
      for (const sel of POST_LOGIN_SELS) {
        const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
        for (const el of els) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (style.display !== "none" && style.visibility !== "hidden" && rect.width > 0) return true;
        }
      }
      return false;
    }) as boolean;

    if (hasPostLoginIndicator) {
      return { success: true, reason: `Post-login element detected on page. URL: ${finalUrl}` };
    }

    // 4. Check if the login/submit button is still visible.
    //    Per user spec: URL same + button GONE → page advanced (SPA / 2FA) → success
    //                   URL same + button STILL VISIBLE → login didn't move the page → failure
    //    Only use the caller-supplied submit selector.  The old generic fallback
    //    (button[type='submit'], button.btn-primary, …) matched post-login page
    //    elements that had nothing to do with the login form, causing false negatives.
    if (!submitSel) {
      // No submit selector supplied — we can't reliably tell whether the login
      // form is still present, so assume success (other heuristics above would
      // have caught real failures).
      return { success: true, reason: `No error detected and no explicit submit selector — assuming success. URL: ${finalUrl}` };
    }

    const checkLoginBtnVisible = async (): Promise<boolean> => {
      return page.evaluate((s: string) => {
        const els = Array.from(document.querySelectorAll<HTMLElement>(s));
        return els.some((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
        });
      }, submitSel as never) as Promise<boolean>;
    };

    const btnVisible = await checkLoginBtnVisible();
    if (!btnVisible) {
      // Login button gone — page advanced (SPA login, 2FA screen loading, etc.)
      return { success: true, reason: `Login button disappeared, page advanced. URL: ${finalUrl}` };
    }

    // Button still visible — give the page a bit more time then re-check
    await sleep(2500);
    const urlAfterWait = page.url();
    if (normalize(urlAfterWait) !== normalize(targetUrl)) {
      return { success: true, reason: `Navigated to: ${urlAfterWait} (after extra wait)` };
    }
    const stillVisible = await checkLoginBtnVisible();
    if (stillVisible) {
      return { success: false, reason: "Login button still visible after submission — credentials may be incorrect or login failed" };
    }
    return { success: true, reason: `Login button disappeared after extra wait. URL: ${urlAfterWait}` };
  }

  /**
   * Dismiss common cookie consent banners, GDPR overlays, and notification popups
   * that can block form fields and captcha widgets.
   */
  async function dismissCookieConsent(page: PageAdapter): Promise<void> {
    // Try CSS-based selectors first
    const CONSENT_SELECTORS = [
      "button[class*='cookie' i][class*='accept' i]",
      "button[id*='cookie' i][id*='accept' i]",
      "a[class*='cookie' i][class*='accept' i]",
      "[data-testid*='cookie-accept' i]",
      "button[class*='consent' i][class*='accept' i]",
      ".cookie-banner button", ".cookie-notice button",
      "#cookie-banner button", "#cookie-notice button",
      ".gdpr-banner button",
      // CookieYes (cky-) consent banners — used by justrunmy.app and others
      ".cky-btn-accept",
      "button.cky-btn-accept",
      "[data-cky-tag='accept-button']",
      ".cky-consent-bar button[class*='accept' i]",
    ];
    for (const sel of CONSENT_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const visible = await el.evaluate((e: Element) => {
          const r = e.getBoundingClientRect();
          const s = window.getComputedStyle(e);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        }).catch(() => false) as boolean;
        if (visible) {
          await el.click();
          logger.debug({ selector: sel }, "Dismissed cookie/consent overlay");
          await sleep(300);
          return;
        }
      } catch { /* ignore */ }
    }

    // Fallback: find buttons by text content (works with both Playwright and
    // Puppeteer adapters). Match by SUBSTRING, not exact equality — the
    // known-good reference (eooce/katabump-renew) just does `"Accept" in btn.text`,
    // so a button labelled "Accept cookies" / "I Accept" / "Accept all cookies"
    // is dismissed too (our old exact-equality check silently missed all of them).
    try {
      await page.evaluate(() => {
        // Distinctive substrings that are safe to match anywhere in the label.
        const contains = ["accept", "agree", "allow all", "got it", "接受", "同意", "同意并继续"];
        // Short/ambiguous labels only matched exactly (so "OK" doesn't fire on
        // "Bookmark"/"Cookie" etc.).
        const exact = ["ok", "close", "关闭"];
        const buttons = Array.from(
          document.querySelectorAll<HTMLElement>("button, a[role='button'], [role='button'], [class*='btn'], a[class*='accept' i]"),
        );
        for (const btn of buttons) {
          const raw = (btn.textContent ?? "").trim();
          const text = raw.toLowerCase();
          const style = window.getComputedStyle(btn);
          const rect = btn.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden" || rect.width === 0) continue;
          if (raw.length > 40) continue; // skip paragraph-length "buttons"
          const hit =
            contains.some((t) => text.includes(t) || raw.includes(t)) ||
            exact.some((t) => text === t || raw === t);
          if (hit) {
            btn.click();
            return;
          }
        }
      });
    } catch { /* ignore */ }
  }

  export async function formLogin(
    page: PageAdapter,
    targetUrl: string,
    credentials: FormCredentials,
    solver: CaptchaSolver | null,
    successSelector?: string,
    totpSecret?: string,
    successText?: string,
  ): Promise<LoginResult> {
    // Track dialog messages BEFORE attaching the auto-dismiss popup handler,
    // so we can capture the message content for captcha error detection.
    let lastDialogMessage = "";
    page.on("dialog", ((dialog: { message(): string }) => {
      lastDialogMessage = dialog.message();
    }) as never);

    attachPopupHandler(page);

    try {
      logger.info({ targetUrl }, "Starting form login flow");
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

      // ── 0a. Clear a full-page Cloudflare interstitial FIRST ───────────────
      // Sites like wispbyte.com, betadash.lunes.host and dash.domain.digitalplat.org
      // serve the login page behind a full-page CF challenge ("Just a moment…").
      // The username/password fields do not exist until the challenge clears, so
      // we must pass it *before* trying to locate the form — otherwise findSelector
      // times out and login fails without the CF bypass ever running.
      // (The SeleniumBase/cf-proxy backend clears this natively via
      // uc_open_with_reconnect on every goto; this brings the CDP/local backends
      // to parity.)
      try {
        const cleared = await clearCloudflareInterstitial(page, { url: targetUrl });
        if (!cleared) {
          logger.warn({ targetUrl }, "Cloudflare interstitial not confirmed cleared before login — continuing anyway");
        }
      } catch (cfErr) {
        logger.warn({ targetUrl, cfErr }, "Cloudflare interstitial pre-clear threw — continuing");
      }

      // ── 0. Dismiss cookie consent banners & common popups ─────────────────
      // These overlays can block captcha widgets and form fields. Dismiss them
      // early so subsequent interactions land on the correct elements.
      await dismissCookieConsent(page);
      await sleep(500);

      // ── 1. Fill form fields FIRST (before captcha) ────────────────────────
      // Many sites (especially those using GeeTest/click-to-verify captchas)
      // expect form fields to be populated before the captcha is interacted with.
      // Filling first also avoids wasting time if fields can't be found.
      const usernameSel = await findSelector(page, USERNAME_SELECTORS);
      if (!usernameSel) {
        return { success: false, captchaBlocked: false, message: "Could not find username/email input field on the page" };
      }
      await page.click(usernameSel);
      await page.evaluate((sel: unknown) => {
        const el = document.querySelector<HTMLInputElement>(sel as string);
        if (el) el.value = "";
      }, usernameSel as never);
      await page.keyboard.type(credentials.username, { delay: 50 });

      const passwordSel = await findSelector(page, PASSWORD_SELECTORS);
      if (!passwordSel) {
        return { success: false, captchaBlocked: false, message: "Could not find password input field on the page" };
      }
      await page.click(passwordSel);
      await page.evaluate((sel: unknown) => {
        const el = document.querySelector<HTMLInputElement>(sel as string);
        if (el) el.value = "";
      }, passwordSel as never);
      await page.keyboard.type(credentials.password, { delay: 50 });

      // ── 2. Handle captcha AFTER filling fields, BEFORE submit ─────────────
      const captchaResult = await detectAndHandleCaptcha(page, solver);
      if (captchaResult.detected && !captchaResult.solved) {
        if (captchaResult.needsAttention) {
          return { success: false, captchaBlocked: true, message: captchaResult.message };
        }
        logger.warn("Captcha detected but not solved — attempting login anyway");
      }

      // ── 3. Submit — try button click first, fall back to Enter key ────────
      const submitSel =
        "button[type='submit'], input[type='submit'], button.btn-primary, button.login-btn, " +
        "button[class*='submit' i], button[class*='sign-in' i], button[class*='login' i]";
      const submitBtn = await page.$(submitSel);

      if (submitBtn) {
        await submitBtn.click();
      } else {
        await page.keyboard.press("Enter");
      }

      // Wait for page to fully settle (URL stops changing) — up to 15 s
      await waitForSettle(page, 8000);
      await dismissPopups(page);

      // Check if a dialog popped up indicating captcha was required but not solved.
      // Chinese sites commonly show alerts like "请先完成验证码验证".
      if (lastDialogMessage) {
        const captchaDialogPatterns = [
          /验证码/i, /captcha/i, /verify/i, /验证/i, /人机/i,
          /robot/i, /human/i, /challenge/i,
        ];
        const isCaptchaDialog = captchaDialogPatterns.some((p) => p.test(lastDialogMessage));
        if (isCaptchaDialog) {
          logger.warn({ dialogMessage: lastDialogMessage }, "Form submission blocked by captcha dialog — retrying captcha");
          // Wait a moment for any overlay to clear, then retry captcha
          await sleep(1500);
          const retryResult = await detectAndHandleCaptcha(page, solver);
          if (retryResult.detected && !retryResult.solved && retryResult.needsAttention) {
            return { success: false, captchaBlocked: true, message: `Captcha dialog: "${lastDialogMessage}". ${retryResult.message}` };
          }
          // Re-submit after captcha retry
          const retryBtn = await page.$(submitSel);
          if (retryBtn) {
            await retryBtn.click();
          } else {
            await page.keyboard.press("Enter");
          }
          await waitForSettle(page, 8000);
          await dismissPopups(page);
        }
      }


      // ── TOTP / 2FA auto-fill ──────────────────────────────────────────────
      // If a 2FA OTP input appeared after form submit, generate and fill the code.
      const effectiveTotpSecret = totpSecret ?? credentials.totpSecret;
      if (effectiveTotpSecret) {
        const otpSelectors = [
          "input[autocomplete='one-time-code']",
          "input[name='otp']", "input[name='totp']",
          "input[name='code']", "input[name='token']",
          "input[inputmode='numeric'][maxlength='6']",
          "input[inputmode='numeric'][maxlength='8']",
          "input[placeholder*='code' i]", "input[placeholder*='2fa' i]",
        ].join(", ");
        try {
          const otpEl = await page.$(otpSelectors);
          if (otpEl) {
            const otpVisible = await otpEl.evaluate((e: Element) => {
              const style = window.getComputedStyle(e);
              const rect = e.getBoundingClientRect();
              return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
            }) as boolean;
            if (otpVisible) {
              logger.info({ targetUrl }, "2FA / OTP field detected — auto-filling TOTP code");
              const code = generateTOTP(effectiveTotpSecret);
              await page.click(otpSelectors);
              await page.evaluate((sel: unknown) => {
                const el = document.querySelector<HTMLInputElement>(sel as string);
                if (el) el.value = "";
              }, otpSelectors as never);
              await page.keyboard.type(code, { delay: 80 });
              await sleep(500);
              const otpSubmit = await page.$("button[type='submit'], input[type='submit']");
              if (otpSubmit) await otpSubmit.click();
              else await page.keyboard.press("Enter");
              await waitForSettle(page, 12000);
              await dismissPopups(page);
            }
          }
        } catch { /* OTP detection failed — proceed to outcome detection */ }
      }

      const outcome = await detectLoginOutcome(page, targetUrl, successSelector, submitSel, successText);
      logger.info({ url: page.url(), success: outcome.success, reason: outcome.reason }, "Form login outcome");

      return {
        success: outcome.success,
        captchaBlocked: false,
        message: outcome.success
          ? `Successfully logged in. ${outcome.reason}`
          : `Login failed: ${outcome.reason}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Form login error");
      return { success: false, captchaBlocked: false, message: `Form login error: ${message}` };
    }
  }
 