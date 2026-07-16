import type { PageAdapter, DialogAdapter, ElementAdapter } from "./page-adapter";
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
  // Google / YouTube consent ("Accept all"): the button id is stable across
  // locales; it lives in the main doc on some pages and inside a
  // consent.google.com iframe on others (handled by the frame pass below).
  "#L2AGLb", "button#L2AGLb", "form[action^='https://consent.'] button[jsname]",
  "[aria-label='Accept all']", "button[aria-label*='Accept all' i]",
];

/** Strong, unambiguous consent phrases safe to match by prefix (label starts-with). */
const CONSENT_TEXTS_PREFIX = [
  "accept all", "allow all", "accept cookies", "accept & continue", "accept and continue",
  "全部接受", "接受全部", "全部允许", "同意并继续",
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
  // Try the precise CSS selectors in a given scope (main frame or an iframe).
  const clickFirstVisible = async (
    scope: { $: (s: string) => Promise<ElementAdapter | null> },
  ): Promise<string | null> => {
    for (const sel of CONSENT_SELECTORS) {
      try {
        const el = await scope.$(sel);
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
          return sel;
        }
      } catch { /* ignore */ }
    }
    return null;
  };

  // 1. Precise CSS selectors in the main frame.
  const mainHit = await clickFirstVisible(page);
  if (mainHit) {
    logger.debug({ selector: mainHit }, "Dismissed cookie/consent overlay (selector)");
    await sleep(300);
    return true;
  }

  // 2. Same selectors inside each iframe — Google/YouTube serve the consent
  //    dialog from a consent.google.com iframe, which the main-frame query and
  //    the text fallback (which only sees the top document) both miss.
  for (const frame of page.frames()) {
    try {
      const url = frame.url();
      if (!/consent|cookie|gdpr|privacy|google\.com/i.test(url)) continue;
      const frameHit = await clickFirstVisible(frame);
      if (frameHit) {
        logger.debug({ selector: frameHit, frame: url }, "Dismissed cookie/consent overlay (iframe)");
        await sleep(300);
        return true;
      }
    } catch { /* ignore */ }
  }

  // 3. Text-based fallback (main frame) — works across arbitrary consent
  //    frameworks. Exact match on the broad list, plus a prefix match on a few
  //    unambiguous accept phrases so "Accept all cookies", "Accept & continue",
  //    etc. are caught too.
  try {
    const clicked = await page.evaluate((arg: unknown) => {
      const { exact, prefix } = arg as { exact: string[]; prefix: string[] };
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
        if (exact.some((tx) => label === tx) || prefix.some((tx) => label.startsWith(tx))) {
          btn.click();
          return true;
        }
      }
      return false;
    }, { exact: CONSENT_TEXTS, prefix: CONSENT_TEXTS_PREFIX } as never) as boolean;
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
/**
 * Clear popups repeatedly until the page stops producing them.
 *
 * A single pass isn't enough on sites that stack overlays (closing one reveals the
 * next) or that re-open a popup a moment later. We keep running passes until one
 * dismisses nothing, capped by both a pass count and a wall-clock budget so a page
 * that respawns popups forever can't hang the step.
 *
 * Captcha widgets (Turnstile / reCAPTCHA / hCaptcha) are never touched — the
 * per-pass skip list protects them, so a CF verification modal survives cleanup.
 */
export async function dismissPopups(page: PageAdapter): Promise<PopupCleanupResult> {
  const maxPasses = Number(process.env.POPUP_MAX_PASSES ?? 5);
  const deadline = Date.now() + Number(process.env.POPUP_BUDGET_MS ?? 15_000);
  const all: string[] = [];
  let total = 0;

  for (let pass = 1; pass <= maxPasses; pass++) {
    const res = await dismissPopupsOnce(page, pass === 1);
    total += res.dismissed;
    all.push(...res.details);
    // Nothing left to close — the page is clean.
    if (res.dismissed === 0) break;
    if (Date.now() > deadline) {
      logger.warn({ pass, total }, "popup cleanup hit its time budget — stopping");
      break;
    }
    // Give a stacked/re-opening popup a beat to render before the next pass.
    await sleep(400);
  }

  if (total > 0) logger.info({ dismissed: total, details: all }, "Popup/overlay cleanup complete");
  return { dismissed: total, details: all };
}

/** True when any captcha widget is rendered — cleanup must not close its host modal. */
async function pageHasCaptcha(page: PageAdapter): Promise<boolean> {
  try {
    return (await page.evaluate(() =>
      !!document.querySelector(
        ".cf-turnstile, [data-sitekey], input[name='cf-turnstile-response'], " +
          "iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile'], " +
          "iframe[src*='recaptcha'], .g-recaptcha, iframe[src*='hcaptcha'], .h-captcha, " +
          ".altcha, [data-altcha]",
      ),
    )) as boolean;
  } catch {
    return false;
  }
}

/** True when some modal/dialog is on screen — used to decide whether a late captcha is worth waiting for. */
async function pageHasDialog(page: PageAdapter): Promise<boolean> {
  try {
    return (await page.evaluate(() => {
      const nodes = document.querySelectorAll(
        "[role='dialog'], [class*='modal'], [class*='popup'], [class*='dialog']",
      );
      for (const n of Array.from(nodes)) {
        const r = (n as HTMLElement).getBoundingClientRect();
        const s = window.getComputedStyle(n as HTMLElement);
        if (r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden") return true;
      }
      return false;
    })) as boolean;
  } catch {
    return false;
  }
}

async function dismissPopupsOnce(page: PageAdapter, firstPass = true): Promise<PopupCleanupResult> {
  const details: string[] = [];
  let dismissed = 0;

  // 1. Cookie / consent banners. On the FIRST pass, retry for a few seconds: some
  //    consent dialogs (e.g. Google's "Accept all") render a beat AFTER the page
  //    loads, so a single early check finds nothing and the banner pops up right
  //    after. Later passes check once — the caller's loop already re-runs us, and
  //    re-waiting 4s per pass would just burn the budget.
  try {
    const deadline = Date.now() + (firstPass ? 4000 : 0);
    let hit = false;
    do {
      if (await dismissCookieConsent(page)) { hit = true; break; }
      if (Date.now() >= deadline) break;
      await sleep(500); // let a still-loading banner appear, then re-check
    } while (Date.now() < deadline);
    if (hit) {
      dismissed++;
      details.push("cookie/consent banner");
    }
  } catch (err) {
    logger.debug({ err }, "cookie consent dismissal failed");
  }

  // Is there a captcha anywhere on the page right now? If so we must NOT close
  // modals or press Escape: the widget we're supposed to solve usually LIVES in a
  // modal (bot-hosting renew, host2play/wispbyte "Start"), and closing it is what
  // produced "the popup closed but the action never fired".
  //
  // A single point-in-time check can race a slow captcha. The usual markup
  // (.cf-turnstile / [data-sitekey]) is in the page's own HTML and is there before
  // CF's iframe loads, so that case is covered — but a modal whose body arrives by
  // AJAX may still be empty when we look. So: if we see a dialog but no captcha yet,
  // give it a moment and look once more before touching anything.
  let captchaPresent = await pageHasCaptcha(page);
  if (!captchaPresent && (await pageHasDialog(page))) {
    await sleep(1200);
    captchaPresent = await pageHasCaptcha(page);
    if (captchaPresent) logger.info("popup cleanup: captcha appeared late — protecting its dialog");
  }

  // 2. Generic close buttons on modals / ad overlays / newsletter popups.
  for (const selector of CLOSE_SELECTORS) {
    try {
      const btn = await page.$(selector);
      if (!btn) continue;
      // Visible AND not the close button of a modal that contains a captcha.
      // NOTE: the element adapter's evaluate() takes no args, so the guard
      // selector is inlined in the function body (it gets stringified).
      const ok = await btn
        .evaluate((e: Element) => {
          const r = e.getBoundingClientRect();
          const s = window.getComputedStyle(e);
          const visible =
            r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
          if (!visible) return false;
          const CAPTCHA =
            ".cf-turnstile, [data-sitekey], input[name='cf-turnstile-response'], " +
            "iframe[src*='challenges.cloudflare.com'], iframe[src*='turnstile'], " +
            "iframe[src*='recaptcha'], .g-recaptcha, iframe[src*='hcaptcha'], .h-captcha, " +
            ".altcha, [data-altcha]";
          const host =
            e.closest("[class*='modal'], [class*='popup'], [class*='dialog'], [role='dialog']") ??
            null;
          // Closing a modal that holds a captcha would destroy the challenge.
          if (host && host.querySelector(CAPTCHA)) return false;
          return true;
        })
        .catch(() => false) as boolean;
      if (!ok) continue;
      await btn.click().catch(() => {});
      dismissed++;
      details.push(`close button (${selector})`);
      await sleep(250);
    } catch { /* ignore */ }
  }

  // 3. Press Escape — many lightbox/modal libraries close on Escape. Skipped while a
  //    captcha is on screen: Escape would close the very dialog hosting it.
  if (!captchaPresent) {
    try {
      await page.keyboard.press("Escape");
    } catch { /* ignore */ }
  }

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

  if (dismissed > 0) logger.debug({ dismissed, details }, "Popup/overlay cleanup pass complete");
  return { dismissed, details };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
