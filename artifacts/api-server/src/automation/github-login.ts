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
    const before = safeUrl(page);
    // Find the GitHub trigger (CSS patterns first, then text), click it in-page,
    // and capture the anchor href if it is / is inside an <a href>. A JS el.click()
    // runs any onclick AND navigates <a> links — verified to reach github.com in a
    // real browser.
    const info = await page.evaluate((arg: unknown) => {
      const { css, texts } = arg as { css: string[]; texts: string[] };
      const isVis = (e: Element) => {
        const el = e as HTMLElement;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
      };
      let el: HTMLElement | null = null;
      for (const sel of css) {
        const c = document.querySelector<HTMLElement>(sel);
        if (c && isVis(c)) { el = c; break; }
      }
      if (!el) {
        const cands = Array.from(document.querySelectorAll<HTMLElement>("a, button, [role='button'], [role='link'], div[onclick]"));
        for (const c of cands) {
          const t = (c.textContent || c.getAttribute("aria-label") || "").toLowerCase().trim();
          if (texts.some((p) => t.includes(p)) && isVis(c)) { el = c; break; }
        }
      }
      if (!el) {
        // Icon-only providers with no text/href/onclick attribute — e.g. wispbyte
        // renders <div class="continue-via"><i class="fa-brands fa-github"></i></div>
        // and wires the click via a JS listener. Locate the GitHub icon, then click
        // its nearest clickable ancestor (its own provider container), which scopes
        // the match to GitHub and not the sibling Discord/Google icons.
        const icon = document.querySelector<HTMLElement>(
          "i.fa-github, [class*='fa-github'], i[class*='github'], svg[class*='github'], [aria-label*='github' i]",
        );
        if (icon) {
          const clickable = (icon.closest(
            "a, button, [role='button'], [onclick], .continue-via, [class*='provider'], [class*='social'], [class*='oauth'], [class*='continue']",
          ) as HTMLElement | null) || icon.parentElement || icon;
          if (clickable && isVis(clickable)) el = clickable;
        }
      }
      if (!el) return { found: false, href: null as string | null, text: "" };
      const anchor = el.closest("a") as HTMLAnchorElement | null;
      const href = anchor?.href || null;
      const text = el.textContent?.trim() ?? "GitHub button";
      el.click();
      return { found: true, href, text };
    }, { css: GITHUB_CSS_PATTERNS, texts: GITHUB_TEXT_PATTERNS } as never) as { found: boolean; href: string | null; text: string };

    if (!info.found) return false;
    logger.info({ text: info.text, href: info.href }, "Clicked GitHub OAuth trigger (JS click)");

    // Reliability fallback: on the SeleniumBase/cf-proxy backend a synthetic
    // .click() on a plain <a href> often does NOT start a navigation (verified:
    // the flow stayed on /login and never reached github.com). If we're still on
    // the same URL shortly after, navigate to the captured OAuth href directly.
    // bot-hosting's /login/github mints the OAuth state server-side, so a direct
    // nav loses nothing the click would have set up.
    if (info.href) {
      await sleep(1500);
      if (safeUrl(page) === before) {
        logger.info({ href: info.href }, "Click did not navigate — opening OAuth href directly");
        await page.goto(info.href, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      }
    }
    return true;
  }

  // ── Fill GitHub login form ────────────────────────────────────────────────────

  async function fillGitHubLoginForm(page: PageAdapter, creds: GitHubCredentials): Promise<void> {
    logger.info("Filling GitHub login form");

    // Real keyboard typing (known-good). GitHub's login rejected a bare
    // native-setter fill and bounced back to the login page ("redirected back to
    // login"); typing with real key events is what GitHub expects. A native-setter
    // pass runs only as a self-healing fallback if the typed value didn't land.
    const jsFill = async (sel: string, val: string) => {
      await page.click(sel);
      await page.evaluate((s: unknown) => {
        const el = document.querySelector<HTMLInputElement>(s as string);
        if (el) el.value = "";
      }, sel as never);
      await page.keyboard.type(val, { delay: 50 });
      await page.evaluate((arg: unknown) => {
        const { s, v } = arg as { s: string; v: string };
        const el = document.querySelector(s) as HTMLInputElement | null;
        if (!el || el.value === v) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(el, v); else el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, { s: sel, v: val } as never);
    };

    const userSel = "#login_field, input[name='login'], input[autocomplete='username']";
    await page.waitForSelector(userSel, { timeout: 15000 });
    await jsFill(userSel, creds.username);
    await sleep(300);

    const passSel = "#password, input[name='password'], input[type='password']";
    await jsFill(passSel, creds.password);
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
          // Before assuming "already logged in", make SURE this isn't a login page.
          // A URL check alone is not enough: wispbyte serves its login screen at
          // /client with the title "Log In" — no login/signin/auth keyword anywhere
          // in the URL — so the old URL-only heuristic falsely reported success and
          // the next steps ran unauthenticated. Detect login affordances directly.
          const looksLikeLogin = await page.evaluate(() => {
            const hasPw = !!document.querySelector("input[type='password']");
            const t = (document.body?.innerText ?? "").toLowerCase();
            const title = (document.title ?? "").toLowerCase();
            return (
              hasPw ||
              /log ?in|sign ?in/.test(title) ||
              t.includes("continue with") ||
              t.includes("continue via")
            );
          }).catch(() => false) as boolean;
          const onLoginUrl =
            currentUrl.includes("/login") || currentUrl.includes("/signin") || currentUrl.includes("/auth");

          if (!onLoginUrl && !looksLikeLogin) {
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
            logger.info({ url: currentUrl }, "No GitHub button found and no login affordances — already logged in?");
            return { success: true, captchaBlocked: false, message: `Already authenticated. URL: ${currentUrl}` };
          }
          logger.warn({ url: currentUrl, looksLikeLogin }, "Login page detected but GitHub button not found");
          return { success: false, captchaBlocked: false, message: `Could not find "Sign in with GitHub" button on login page: ${currentUrl}` };
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

          // GitHub login form (needs credentials). The "skip the authorize page"
          // guard MUST check the URL PATH, not the whole URL: the /login page's
          // return_to query param contains "/login/oauth/authorize", so the old
          // `!currentUrl.includes("oauth/authorize")` wrongly treated the login
          // page as the authorize page and never filled — the state machine spun
          // all 12 ticks with the form left blank.
        let ghPath = "";
        try { ghPath = new URL(currentUrl).pathname; } catch { ghPath = currentUrl; }
        if (
          (currentUrl.includes("github.com/login") || currentUrl.includes("github.com/session")) &&
          !ghPath.includes("/oauth/authorize") &&
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

        // OAuth authorize screen — match on PATH (the login page's return_to query
        // param also contains "login/oauth/authorize", which would otherwise make
        // us hunt for an Authorize button on the plain login page).
        if (ghPath.includes("/login/oauth/authorize") || ghPath.endsWith("/oauth/authorize")) {
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
  