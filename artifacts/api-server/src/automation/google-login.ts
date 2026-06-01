import type { PageAdapter } from "./page-adapter";
import { logger } from "../lib/logger";
import { attachPopupHandler, dismissPopups } from "./popup-handler";
import { detectAndHandleCaptcha } from "./captcha";
import type { CaptchaSolver } from "./captcha-solver";
import type { LoginResult } from "./form-login";

export interface GoogleCredentials {
  username: string;
  password: string;
  totpSecret?: string;
}

const GOOGLE_BUTTON_SELECTORS = [
  "a[href*='accounts.google.com']",
  "button[data-provider='google']",
  "[class*='google' i] button",
  "[class*='google' i] a",
  "a[class*='google' i]",
  "button[class*='google' i]",
  "div[class*='google' i][role='button']",
  "[data-authuser]",
];

const GOOGLE_BUTTON_TEXT_PATTERNS = [
  "sign in with google",
  "login with google",
  "continue with google",
  "connect with google",
  "google login",
  "google sign in",
  "sign up with google",
];

async function clickGoogleButton(page: PageAdapter): Promise<boolean> {
  for (const sel of GOOGLE_BUTTON_SELECTORS) {
    const el = await page.$(sel);
    if (el) {
      const visible = await el.evaluate((e: Element) => {
        const style = window.getComputedStyle(e);
        const rect = e.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
      });
      if (visible) {
        logger.info({ selector: sel }, "Found Google OAuth button by selector");
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
          el.click(),
        ]);
        return true;
      }
    }
  }

  const found = await page.evaluate((patterns: unknown) => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("a, button, [role='button'], div[tabindex]"));
    for (const el of els) {
      const text = (el.textContent || el.getAttribute("aria-label") || "").toLowerCase().trim();
      if ((patterns as string[]).some((p) => text.includes(p))) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.display !== "none" && style.visibility !== "hidden" && rect.width > 0) {
          el.click();
          return el.textContent?.trim() ?? "Google button";
        }
      }
    }
    return null;
  }, GOOGLE_BUTTON_TEXT_PATTERNS as never) as string | null;

  if (found) {
    logger.info({ text: found }, "Found Google OAuth button by text");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    return true;
  }

  return false;
}

async function completeGoogleAuth(
  page: PageAdapter,
  credentials: GoogleCredentials,
  solver: CaptchaSolver | null,
): Promise<LoginResult> {
  const captchaResult = await detectAndHandleCaptcha(page, solver);
  if (captchaResult.detected && !captchaResult.solved) {
    if (captchaResult.needsAttention) {
      return { success: false, captchaBlocked: true, message: captchaResult.message };
    }
    logger.warn("Captcha on Google login page — proceeding anyway");
  }

  // Step 1: Enter email
  const emailSel = "input[type='email'], input[name='identifier'], input[autocomplete='username email']";
  try {
    await page.waitForSelector(emailSel, { timeout: 15000 });
  } catch {
    return { success: false, captchaBlocked: false, message: "Could not find email input on Google sign-in page" };
  }

  await page.click(emailSel);
  await page.evaluate((sel: unknown) => {
    const el = document.querySelector<HTMLInputElement>(sel as string);
    if (el) el.value = "";
  }, emailSel as never);
  await page.keyboard.type(credentials.username, { delay: 60 });

  // Click "Next" after email
  const emailNextSel = "#identifierNext, button[jsname='LgbsSe'], button[type='button']:not([disabled])";
  const emailNextBtn = await page.$(emailNextSel);
  if (emailNextBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {}),
      emailNextBtn.click(),
    ]);
  } else {
    await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
  }

  await new Promise((r) => setTimeout(r, 1500));

  // Check for email error
  const emailError = await page.$(".o6cuMc, .dEOOab, [data-error-code]");
  if (emailError) {
    const errText = await emailError.evaluate((el: Element) => el.textContent ?? "");
    return { success: false, captchaBlocked: false, message: `Google login failed at email step: ${errText.trim()}` };
  }

  // Step 2: Enter password
  const passwordSel = "input[type='password'], input[name='password'], input[autocomplete='current-password']";
  try {
    await page.waitForSelector(passwordSel, { timeout: 15000 });
  } catch {
    return { success: false, captchaBlocked: false, message: "Could not find password input on Google sign-in page. Google may require additional verification." };
  }

  await page.click(passwordSel);
  await page.evaluate((sel: unknown) => {
    const el = document.querySelector<HTMLInputElement>(sel as string);
    if (el) el.value = "";
  }, passwordSel as never);
  await page.keyboard.type(credentials.password, { delay: 60 });

  // Click "Next" after password
  const passwordNextSel = "#passwordNext, button[jsname='LgbsSe'], button[type='button']:not([disabled])";
  const passwordNextBtn = await page.$(passwordNextSel);
  if (passwordNextBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
      passwordNextBtn.click(),
    ]);
  } else {
    await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  }

  await new Promise((r) => setTimeout(r, 1500));

  // Check for password error
  const passwordError = await page.$(".o6cuMc, .dEOOab, [jsname='B34EJ']");
  if (passwordError) {
    const errText = await passwordError.evaluate((el: Element) => el.textContent ?? "");
    if (errText.trim()) {
      return { success: false, captchaBlocked: false, message: `Google login failed at password step: ${errText.trim()}` };
    }
  }

  const currentUrl = page.url();

  // Step 3: TOTP / 2FA if present
  const totpSel = "input[type='tel'], input[name='totpPin'], input[autocomplete='one-time-code'], input[inputmode='numeric']";
  const totpInput = await page.$(totpSel);
  if (totpInput) {
    logger.info("Google 2FA page detected");
    if (!credentials.totpSecret) {
      return { success: false, captchaBlocked: false, message: "Google requires 2FA but no TOTP secret was provided" };
    }
    const { generateSync } = await import("otplib");
    const totp = generateSync({ secret: credentials.totpSecret });
    await page.click(totpSel);
    await page.keyboard.type(totp, { delay: 80 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
      page.keyboard.press("Enter"),
    ]);
    await new Promise((r) => setTimeout(r, 1000));
  }

  await dismissPopups(page);

  // Check we're no longer on Google auth pages
  const finalUrl = page.url();
  if (finalUrl.includes("accounts.google.com")) {
    // Check for blocking messages
    const blockedEl = await page.$("h1, .MuzmKe, .o6cuMc");
    const blockedText = blockedEl ? await blockedEl.evaluate((el: Element) => el.textContent ?? "") : "";
    logger.warn({ finalUrl, blockedText }, "Still on Google auth page after login attempt");

    if (finalUrl.includes("/challenge") || finalUrl.includes("/v3/signin")) {
      return { success: false, captchaBlocked: false, message: `Google requires additional verification (e.g., phone/email code). Current page: ${finalUrl}` };
    }

    return { success: false, captchaBlocked: false, message: `Google login did not complete. Still on: ${finalUrl}. ${blockedText.trim()}` };
  }

  return { success: true, captchaBlocked: false, message: `Google auth completed. URL: ${finalUrl}` };
}

export async function googleLogin(
  page: PageAdapter,
  targetUrl: string,
  credentials: GoogleCredentials,
  solver: CaptchaSolver | null,
  successText?: string,
  successSelector?: string,
): Promise<LoginResult> {
  attachPopupHandler(page);

  try {
    logger.info({ targetUrl }, "Starting Google login flow");
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    const isAlreadyGoogle = page.url().includes("accounts.google.com");

    if (!isAlreadyGoogle) {
      logger.info("Target is not Google — looking for OAuth button on target page");

      // Wait for page to fully render (SPA hydration, lazy-loaded buttons)
      await new Promise((r) => setTimeout(r, 2000));

      const captchaResult = await detectAndHandleCaptcha(page, solver);
      if (captchaResult.detected && !captchaResult.solved && captchaResult.needsAttention) {
        return { success: false, captchaBlocked: true, message: captchaResult.message };
      }

      // Retry finding the Google OAuth button with timeout
      let clicked = false;
      const deadline = Date.now() + 15000;
      while (!clicked && Date.now() < deadline) {
        clicked = await clickGoogleButton(page);
        if (!clicked) await new Promise((r) => setTimeout(r, 1000));
      }

      if (!clicked) {
        return {
          success: false,
          captchaBlocked: false,
          message: "Could not find a 'Sign in with Google' button on the target page after 15s. Ensure the target URL contains a Google OAuth login button.",
        };
      }
      logger.info({ url: page.url() }, "Navigated via Google OAuth button");
    }

    if (!page.url().includes("accounts.google.com")) {
      // Maybe already logged into Google and got redirected directly back to app
      logger.info({ url: page.url() }, "Already authenticated with Google, redirected to app");
      // 如果配置了 successText，验证页面含该文本才算已登录
      if (successText) {
        await new Promise((r) => setTimeout(r, 1500));
        const hasText = await page.evaluate(
          (t: unknown) => (document.body?.innerText ?? "").includes(t as string),
          successText as never,
        ).catch(() => false) as boolean;
        if (!hasText) {
          return { success: false, captchaBlocked: false, message: `Login completed but success text "${successText}" not found on page. URL: ${page.url()}` };
        }
      }
      if (successSelector) {
        try {
          const el = await page.$(successSelector);
          const visible = el ? await el.evaluate((e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).catch(() => false) : false;
          if (!visible) {
            return { success: false, captchaBlocked: false, message: `Login completed but success selector "${successSelector}" not visible. URL: ${page.url()}` };
          }
        } catch { /* 选择器无效，跳过 */ }
      }
      return { success: true, captchaBlocked: false, message: `Already authenticated via Google. Final URL: ${page.url()}` };
    }

    const result = await completeGoogleAuth(page, credentials, solver);
    if (!result.success) return result;

    const finalUrl = page.url();
    logger.info({ finalUrl }, "Google login succeeded");
    // 如果配置了 successText，验证页面含该文本才算登录成功
    if (successText) {
      await new Promise((r) => setTimeout(r, 1500));
      const hasSuccessText = await page.evaluate(
        (t: unknown) => (document.body?.innerText ?? "").includes(t as string),
        successText as never,
      ).catch(() => false) as boolean;
      if (!hasSuccessText) {
        return { success: false, captchaBlocked: false, message: `Login completed but success text "${successText}" not found on page. URL: ${finalUrl}` };
      }
    }
    if (successSelector) {
      try {
        const el = await page.$(successSelector);
        const visible = el ? await el.evaluate((e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).catch(() => false) : false;
        if (!visible) {
          return { success: false, captchaBlocked: false, message: `Login completed but success selector "${successSelector}" not visible. URL: ${finalUrl}` };
        }
      } catch { /* 选择器无效，跳过 */ }
    }
    return { success: true, captchaBlocked: false, message: `Successfully logged in via Google OAuth. Final URL: ${finalUrl}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Google login error");
    return { success: false, captchaBlocked: false, message: `Google login error: ${message}` };
  }
}
