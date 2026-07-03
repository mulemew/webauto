import type { PageAdapter, DialogAdapter } from "./page-adapter";
import { logger } from "../lib/logger";

/**
 * Attach a JS-dialog auto-dismisser (alert/confirm/prompt/beforeunload).
 * Attached once per page; safe to call multiple times.
 */
export function attachPopupHandler(page: PageAdapter): void {
  page.on("dialog", async (dialog: DialogAdapter) => {
    logger.info({ type: dialog.dialogType(), message: dialog.message() }, "Auto-dismissing dialog");
    try {
      await dialog.dismiss();
    } catch {
      try {
        await dialog.accept();
      } catch (err) {
        logger.warn({ err }, "Failed to dismiss or accept dialog");
      }
    }
  });
}

/**
 * Result of an overlay-cleanup pass.
 */
export interface PopupCleanupResult {
  dismissed: number;
  details: string[];
}

/**
 * Cookie-consent / GDPR accept-button text in many languages. Matched
 * case-insensitively against button/anchor text and aria-labels.
 */
const CONSENT_TEXTS = [
  "accept all", "accept all cookies", "accept cookies", "accept", "allow all",
  "i agree", "agree", "got it", "ok", "okay", "understood", "continue",
  "allow", "enable all", "yes, i agree", "consent",
  // zh
  "接受", "全部接受", "同意", "允许", "我同意", "知道了", "同意并继续", "全部允许",
  // other
  "aceptar", "accepter", "akzeptieren", "accetta", "aceitar", "принять", "同意する",
];

/**
 * CSS selectors that commonly identify cookie banners / consent accept buttons.
 * These are tried first (most precise), before the text-based fallback.
 */
const CONSENT_SELECTORS = [
  "button[class*='cookie' i][class*='accept' i]",
  "button[id*='cookie' i][id*='accept' i]",
  "a[class*='cookie' i][class*='accept' i]",
  "[data-testid*='cookie-accept' i]",
  "[data-testid*='accept-all' i]",
  "button[class*='consent' i][class*='accept' i]",
  "#onetrust-accept-btn-handler",
  ".ot-sdk-container #accept-recommended-btn-handler",
  "button#truste-consent-button",
  ".cc-allow", ".cc-btn.cc-allow",
  ".cky-btn-accept", "button.cky-btn-accept", "[data-cky-tag='accept-button']",
  ".cookie-banner button", ".cookie-notice button",
  "#cookie-banner button", "#cookie-notice button", ".gdpr-banner button",
  "[aria-label*='accept cookies' i]",
];

/**
 * CSS selectors that identify generic close / dismiss buttons on modals,
 * ad overlays, newsletter popups, etc.
 */
const CLOSE_SELECTORS = [
  "button[aria-label*='close' i]",
  "button[aria-label*='dismiss' i]",
  "a[aria-label*='close' i]",
  "[role='button'][aria-label*='close' i]",
  "button[class*='close' i]",
  "button[class*='dismiss' i]",
  "[class*='modal'] [class*='close' i]",
  "[class*='popup'] [class*='close' i]",
  "[class*='overlay'] [class*='close' i]",
  "[class*='newsletter'] [class*='close' i]",
  ".modal-close", ".dialog-close", ".close-button", ".btn-close",
  "[data-dismiss='modal']", "[data-bs-dismiss='modal']",
  "[aria-label='Close']", "[title='Close']",
];

/**
 * Dismiss cookie-consent banners specifically. Returns true if it clicked one.
 * Kept as a named export because form-login calls it before typing.
 */
export async function dismissCookieConsent(page: PageAdapter): Promise<boolean> {
  // Precise CSS selectors first.
  for (const sel of CONSENT_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const visible = await el
        .evaluate((e: Element) => {
          const r = e.getBoundingClientRect();
          const s = window.getComputedStyle(e);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        })
        .catch(() => false) as boolean;
      if (visible) {
        await el.click().catch(() => {});
        logger.debug({ selector: sel }, "Dismissed cookie/consent overlay (selector)");
        await sleep(300);
        return true;
      }
    } catch { /* ignore */ }
  }

  // Text-based fallback — works across arbitrary consent frameworks.
  try {
    const clicked = await page.evaluate((texts: unknown) => {
      const accepts = texts as string[];
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("button, a[role='button'], [role='button'], input[type='button'], input[type='submit'], [class*='btn']"),
      );
      for (const btn of nodes) {
        const style = window.getComputedStyle(btn);
        const rect = btn.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;
        const label = (
          btn.textContent ||
          (btn instanceof HTMLInputElement ? btn.value : "") ||
          btn.getAttribute("aria-label") ||
          ""
        ).trim().toLowerCase();
        if (!label || label.length > 40) continue;
        if (accepts.some((tx) => label === tx)) {
          btn.click();
          return true;
        }
      }
      return false;
    }, CONSENT_TEXTS as never) as boolean;
    if (clicked) {
      logger.debug("Dismissed cookie/consent overlay (text match)");
      await sleep(300);
      return true;
    }
  } catch { /* ignore */ }

  return false;
}

/**
 * Comprehensive overlay cleanup: dismisses cookie banners, modal/ad overlays,
 * and — as a last resort — removes fixed full-screen backdrops that block
 * interaction. Safe to run repeatedly; each call reports how much it cleared.
 *
 * This is the function used both by the automatic pre-step hook and the
 * explicit "dismissPopups" workflow step.
 */
export async function dismissPopups(page: PageAdapter): Promise<PopupCleanupResult> {
  const details: string[] = [];
  let dismissed = 0;

  // 1. Cookie / consent banners.
  try {
    if (await dismissCookieConsent(page)) {
      dismissed++;
      details.push("cookie/consent banner");
    }
  } catch (err) {
    logger.debug({ err }, "cookie consent dismissal failed");
  }

  // 2. Generic close buttons on modals / ad overlays / newsletter popups.
  for (const selector of CLOSE_SELECTORS) {
    try {
      const btn = await page.$(selector);
      if (!btn) continue;
      const visible = await btn
        .evaluate((e: Element) => {
          const r = e.getBoundingClientRect();
          const s = window.getComputedStyle(e);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        })
        .catch(() => false) as boolean;
      if (!visible) continue;
      await btn.click().catch(() => {});
      dismissed++;
      details.push(`close button (${selector})`);
      await sleep(250);
    } catch { /* ignore */ }
  }

  // 3. Press Escape — many lightbox/modal libraries close on Escape.
  try {
    await page.keyboard.press("Escape");
  } catch { /* ignore */ }

  // 4. Last resort — neutralise blocking backdrops and restore scroll.
  //    Only targets fixed/absolute full-viewport overlays with a high z-index
  //    so we don't nuke legitimate page chrome.
  try {
    const removed = await page.evaluate(() => {
      let count = 0;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Never remove captcha widgets/containers — deleting them (or their
      // wrappers) breaks login on sites that require the captcha to be present
      // and solved before submit (e.g. GeeTest v4 on ikuuu, Turnstile/hCaptcha
      // on renew dialogs). A captcha layer frequently overlaps the viewport as a
      // fixed/high-z element and would otherwise match the backdrop heuristic.
      const CAPTCHA_SEL =
        ".cf-turnstile, [data-sitekey], input[name='cf-turnstile-response'], " +
        "iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile'], " +
        "iframe[src*='recaptcha'], .g-recaptcha, iframe[src*='hcaptcha'], .h-captcha, " +
        "[class*='geetest'], [class*='captcha'], [id*='captcha'], .embed-captcha, " +
        "iframe[src*='geetest'], iframe[src*='captcha']";
      const isCaptchaRelated = (el: HTMLElement): boolean => {
        try {
          if (el.matches(CAPTCHA_SEL)) return true;
          if (el.querySelector(CAPTCHA_SEL)) return true;
          if (el.closest(CAPTCHA_SEL)) return true;
        } catch { /* ignore */ }
        return false;
      };
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("body *"));
      for (const el of candidates) {
        const s = window.getComputedStyle(el);
        if (s.position !== "fixed" && s.position !== "absolute") continue;
        const z = parseInt(s.zIndex || "0", 10);
        const r = el.getBoundingClientRect();
        const coversViewport = r.width >= vw * 0.9 && r.height >= vh * 0.9;
        const cls = (el.className && typeof el.className === "string" ? el.className : "") + " " + (el.id || "");
        const isBackdrop =
          /(backdrop|overlay|modal|mask|dimmer|scrim|gdpr|consent|cookie|popup|paywall|subscribe)/i.test(
            cls,
          );
        if (coversViewport && (z >= 1000 || isBackdrop) && s.pointerEvents !== "none") {
          if (isCaptchaRelated(el)) continue;
          el.remove();
          count++;
        }
      }
      // Restore scrolling that consent walls often disable.
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      document.documentElement.style.position = "";
      document.body.style.position = "";
      return count;
    }) as number;
    if (removed > 0) {
      dismissed += removed;
      details.push(`${removed} blocking overlay${removed !== 1 ? "s" : ""} removed`);
    }
  } catch (err) {
    logger.debug({ err }, "overlay removal pass failed");
  }

  if (dismissed > 0) logger.info({ dismissed, details }, "Popup/overlay cleanup pass complete");
  return { dismissed, details };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
