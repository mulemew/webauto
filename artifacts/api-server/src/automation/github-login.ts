import type { PageAdapter } from "./page-adapter";
  import crypto from "crypto";
  import { logger } from "../lib/logger";
  import { attachPopupHandler, dismissPopups } from "./popup-handler";
  import { detectAndHandleCaptcha } from "./captcha";
  import type { CaptchaSolver } from "./captcha-solver";
  import type { LoginResult } from "./form-login";

  // ── TOTP ─────────────────────────────────────────────────────────────────────

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

  // ── Helpers ───────────────────────────────────────────────────────────────────

  export interface GitHubCredentials {
    username: string;
    password: string;
    totpSecret?: string;
  }

  function safeUrl(page: PageAdapter): string {
    try { return page.url(); } catch { return ""; }
  }

  function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  async function nav(page: PageAdapter, timeout = 20000): Promise<void> {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).catch(() => {});
  }

  // ── Click GitHub OAuth button ─────────────────────────────────────────────────

  const GITHUB_CSS_PATTERNS = [
    "a[href*='github.com/login/oauth']",
    "a[href*='github.com/login']",
    "button[data-provider='github']",
    "a[href*='github'][class*='oauth']",
    "a[href*='github'][class*='social']",
  ];

  const GITHUB_TEXT_PATTERNS = [
    "sign in with github", "login with github", "continue with github",
    "connect with github", "github login", "github sign in",
    "log in with github", "signin with github",
  ];

  async function clickGitHubOAuthButton(page: PageAdapter): Promise<boolean> {
    // CSS selectors first
    for (const sel of GITHUB_CSS_PATTERNS) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.evaluate((e: Element) => {
            const s = window.getComputedStyle(e);
            const r = e.getBoundingClientRect();
            return s.display !== "none" && s.visibility !== "hidden" && r.width > 0;
          });
          if (visible) {
            logger.info({ selector: sel }, "Clicking GitHub OAuth button (CSS)");
            await el.click();
            return true;
          }
        }
      } catch { /* try next */ }
    }

    // Text-based search
    const pos = await page.evaluate((patterns: unknown) => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>("a, button, [role='button'], [role='link'], div[onclick]"),
      );
      for (const el of candidates) {
        const text = (el.textContent || el.getAttribute("aria-label") || "").toLowerCase().trim();
        if ((patterns as string[]).some((p) => text.includes(p))) {
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent?.trim() ?? "" };
          }
        }
      }
      return null;
    }, GITHUB_TEXT_PATTERNS as never) as { x: number; y: number; text: string } | null;

    if (pos) {
      logger.info({ text: pos.text, x: pos.x, y: pos.y }, "Clicking GitHub OAuth button (text match)");
      await page.mouse.click(pos.x, pos.y);
      return true;
    }

    return false;
  }

  // ── Fill GitHub login form ────────────────────────────────────────────────────

  async function fillGitHubLoginForm(page: PageAdapter, creds: GitHubCredentials): Promise<void> {
    logger.info("Filling GitHub login form");

    const userSel = "#login_field, input[name='login'], input[autocomplete='username']";
    await page.waitForSelector(userSel, { timeout: 15000 });
    await page.click(userSel);
    await page.evaluate((sel: unknown) => {
      const el = document.querySelector<HTMLInputElement>(sel as string);
      if (el) el.value = "";
    }, userSel as never);
    await page.keyboard.type(creds.username, { delay: 50 });
    await sleep(300);

    const passSel = "#password, input[name='password'], input[type='password']";
    await page.click(passSel);
    await page.evaluate((sel: unknown) => {
      const el = document.querySelector<HTMLInputElement>(sel as string);
      if (el) el.value = "";
    }, passSel as never);
    await page.keyboard.type(creds.password, { delay: 50 });
    await sleep(300);

    const submitSel = "input[type='submit'], button[type='submit'], .js-sign-in-button";
    const submitBtn = await page.$(submitSel);
    if (submitBtn) {
      await Promise.all([nav(page, 30000), submitBtn.click()]);
    } else {
      await page.keyboard.press("Enter");
      await nav(page, 30000);
    }
  }

  // ── Handle 2FA ────────────────────────────────────────────────────────────────

  async function fillTOTP(page: PageAdapter, totpSecret: string): Promise<void> {
    logger.info("Handling GitHub 2FA");
    const code = generateTOTP(totpSecret);
    const otpSel = "#app_totp, input[name='otp'], input[autocomplete='one-time-code'], input[inputmode='numeric']";
    await page.waitForSelector(otpSel, { timeout: 10000 });
    await page.click(otpSel);
    await page.keyboard.type(code, { delay: 80 });
    await sleep(500);

    const verifyBtn = await page.$("button:has-text('Verify'), button[type='submit']");
    if (verifyBtn) {
      await Promise.all([nav(page, 30000), verifyBtn.click()]);
    } else {
      await page.keyboard.press("Enter");
      await nav(page, 30000);
    }
  }

  // ── Handle OAuth authorize screen ─────────────────────────────────────────────

  async function clickAuthorize(page: PageAdapter): Promise<void> {
    logger.info("Handling GitHub OAuth authorize screen");
    // Try text-based selector first, then fallback
    const authSel = "button[name='authorize'], button:has-text('Authorize'), input[value='Authorize']";
    const btn = await page.$(authSel).catch(() => null);
    if (btn) {
      await Promise.all([nav(page, 30000), btn.click()]);
    } else {
      // Try evaluate-click as fallback
      const clicked = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>("button, input[type='submit']"));
        for (const el of candidates) {
          const text = (el.textContent || (el as HTMLInputElement).value || "").toLowerCase();
          if (text.includes("authorize") || text.includes("grant")) {
            el.click();
            return true;
          }
        }
        return false;
      }) as boolean;
      if (clicked) await nav(page, 30000);
    }
  }

  // ── Main state machine ────────────────────────────────────────────────────────

  export async function githubLogin(
    page: PageAdapter,
    targetUrl: string,
    credentials: GitHubCredentials,
    solver: CaptchaSolver | null,
    successText?: string,
    successSelector?: string,
  ): Promise<LoginResult> {
    attachPopupHandler(page);

    try {
      logger.info({ targetUrl }, "GitHub OAuth login — navigating to target");
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(2500);

      let currentUrl = safeUrl(page);
      logger.info({ url: currentUrl }, "Landed on initial URL");

      // ── Phase 1: If not on GitHub, click the OAuth button ───────────────────
      if (!currentUrl.includes("github.com")) {
        // 跳过此处的人机验证检测 —— GitHub OAuth 按钮点击不会被验证码阻断，
        // 直接点击按钮进入 GitHub 授权页面（GitHub 自身页面的验证由 Phase 2 处理）

        // Retry clicking GitHub button for up to 15s (page may be lazy-loading)
        let clicked = false;
        const deadline = Date.now() + 15000;
        while (!clicked && Date.now() < deadline) {
          clicked = await clickGitHubOAuthButton(page);
          if (!clicked) { await sleep(1000); }
        }

        if (!clicked) {
          // If we're not on a login page, maybe we're already logged in
          if (!currentUrl.includes("/login") && !currentUrl.includes("/signin") && !currentUrl.includes("/auth")) {
            // 检查是否是 Cloudflare WAF 拦截页——拦截页无 GitHub 按钮且 URL 不含 login，容易误判为已登录
            const isWafBlocked = await page.evaluate(() => {
              const bodyText = document.body?.innerText ?? "";
              return (
                bodyText.includes("you have been blocked") ||
                bodyText.includes("You are unable to access") ||
                (bodyText.includes("Cloudflare") && bodyText.includes("blocked"))
              );
            }).catch(() => false) as boolean;
            if (isWafBlocked) {
              logger.warn({ url: currentUrl }, "Cloudflare WAF block detected — not authenticated");
              return { success: false, captchaBlocked: false, message: `Target site is Cloudflare WAF blocked. URL: ${currentUrl}` };
            }
            logger.info({ url: currentUrl }, "No GitHub button found but not on login page — already logged in?");
            return { success: true, captchaBlocked: false, message: `Already authenticated. URL: ${currentUrl}` };
          }
          return { success: false, captchaBlocked: false, message: `Could not find "Sign in with GitHub" button on: ${currentUrl}` };
        }

        logger.info("Clicked GitHub OAuth button — waiting for navigation");
        // Wait for navigation immediately after click (don't sleep first!)
        await nav(page, 20000);
        await sleep(1000);
      }

      // ── Phase 2: State machine — handle GitHub pages until we leave github.com ─
      let attempts = 0;
      const MAX_ATTEMPTS = 12;
      let credentialsFilled = false;

      while (attempts < MAX_ATTEMPTS) {
        attempts++;
        currentUrl = safeUrl(page);
        logger.info({ url: currentUrl, attempt: attempts }, "OAuth state machine tick");

        // Success: left github.com — but may still be mid-redirect.
          // The OAuth callback often routes through the site's own login page
          // (e.g. back4app.com/login?return-url=...) while the server processes
          // the auth code, before finally landing on the real app page.
          if (!currentUrl.includes("github.com")) {
            // OAuth callback paths are always fine even if they contain "/auth"
            const isOAuthCallback = /\/callback|\/oauth\/|\/auth\/callback/i.test(currentUrl);

            // A return-url / redirect_to / next param strongly indicates this is
            // an intermediate OAuth redirect — the app is still processing.
            const hasReturnParam = /[?&](return[_-]?url|redirect(?:_to)?|next|continue)=/i.test(currentUrl);

            const isLoginPage =
              !isOAuthCallback &&
              (
                currentUrl.includes("/login") ||
                currentUrl.includes("/signin") ||
                /login|signin|auth\/sign/i.test(currentUrl)
              );

            if (!isLoginPage) {
              // 如果配置了 successText，验证页面含该文本才算登录成功
              if (successText) {
                await sleep(1500);
                const hasText = await page.evaluate(
                  (t: unknown) => (document.body?.innerText ?? "").includes(t as string),
                  successText as never,
                ).catch(() => false) as boolean;
                if (!hasText) {
                  logger.warn({ url: currentUrl, successText }, "OAuth completed but success text not found on page");
                  return { success: false, captchaBlocked: false, message: `OAuth completed but success text "${successText}" not found. URL: ${currentUrl}` };
                }
              }
              logger.info({ finalUrl: currentUrl }, "GitHub OAuth completed successfully");
              return { success: true, captchaBlocked: false, message: `Logged in via GitHub OAuth. Final URL: ${currentUrl}` };
            }

            // We're on a login-looking page. If it has a return-url param this is
            // almost certainly an intermediate redirect — wait for it to resolve.
            if (hasReturnParam) {
              logger.info({ url: currentUrl }, "OAuth mid-redirect (login page with return-url) — waiting for final destination");
              // Give the server up to 15s to finish processing and redirect us
              const waitDeadline = Date.now() + 15000;
              let settled = false;
              while (Date.now() < waitDeadline) {
                await sleep(800);
                const u = safeUrl(page);
                if (u !== currentUrl) {
                  // URL changed — could be the final page or another redirect
                  currentUrl = u;
                  settled = true;
                  break;
                }
              }
              if (!settled) {
                logger.warn({ url: currentUrl }, "OAuth redirect timed out waiting for return-url to resolve");
              }
              // Let the state machine re-evaluate the new URL
              continue;
            }

            // Plain login page without return param — could still be a transient JS redirect.
            // Wait 4 s before concluding failure: some apps do client-side routing
            // that lands briefly on the login URL before redirecting to the dashboard.
            logger.warn({ url: currentUrl }, "OAuth landed on login-looking page — waiting 4 s for JS redirect");
            await sleep(4000);
            const afterWaitUrl = safeUrl(page);
            if (afterWaitUrl !== currentUrl) {
              currentUrl = afterWaitUrl;
              continue; // let the state machine re-evaluate the new URL
            }
            // URL unchanged — genuine OAuth failure
            logger.warn({ url: currentUrl }, "OAuth returned to login page — login failed");
            return { success: false, captchaBlocked: false, message: `GitHub OAuth failed — redirected back to login: ${currentUrl}` };
          }

          // GitHub login form (needs credentials)
        if (
          (currentUrl.includes("github.com/login") || currentUrl.includes("github.com/session")) &&
          !currentUrl.includes("oauth/authorize") &&
          !credentialsFilled
        ) {
          const captcha = await detectAndHandleCaptcha(page, solver);
          if (captcha.detected && !captcha.solved && captcha.needsAttention) {
            return { success: false, captchaBlocked: true, message: captcha.message };
          }
          await fillGitHubLoginForm(page, credentials);
          credentialsFilled = true;
          await sleep(1500);
          continue;
        }

        // 2FA page
        if (currentUrl.includes("/two-factor") || currentUrl.includes("sessions/two-factor")) {
          if (!credentials.totpSecret) {
            return { success: false, captchaBlocked: false, message: "GitHub requires 2FA but no TOTP secret provided" };
          }
          await fillTOTP(page, credentials.totpSecret);
          await sleep(1500);
          continue;
        }

        // Device verification
        if (currentUrl.includes("/device") || currentUrl.includes("verified-device")) {
          logger.warn("GitHub device verification required");
          // Wait up to 60s for manual verification
          for (let i = 0; i < 60; i++) {
            await sleep(1000);
            const u = safeUrl(page);
            if (!u.includes("/device") && !u.includes("verified-device")) {
              logger.info("Device verification completed");
              break;
            }
          }
          continue;
        }

        // OAuth authorize screen
        if (currentUrl.includes("login/oauth/authorize")) {
          await clickAuthorize(page);
          await sleep(2000);
          continue;
        }

        // Still on github.com but no known state — wait and retry
        await sleep(2000);
      }

      currentUrl = safeUrl(page);
      return {
        success: false,
        captchaBlocked: false,
        message: `GitHub OAuth state machine exhausted ${MAX_ATTEMPTS} attempts. Final URL: ${currentUrl}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "GitHub login error");
      return { success: false, captchaBlocked: false, message: `GitHub login error: ${message}` };
    }
  }
  