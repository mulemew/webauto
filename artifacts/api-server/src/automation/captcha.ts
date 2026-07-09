import type { PageAdapter } from "./page-adapter";
import { logger } from "../lib/logger";
import { bypassCloudflareChallenge, simulateHumanMouseMovement, clickTurnstileCheckbox } from "./cloudflare-bypass";
import { solveRecaptchaAudio } from "./recaptcha-audio";
import type { CaptchaSolver, CaptchaTokenType } from "./captcha-solver";

export type { CaptchaSolver } from "./captcha-solver";

export type CaptchaResult =
  | { detected: false }
  | { detected: true; solved: true; message: string }
  | { detected: true; solved: false; needsAttention: boolean; message: string };

// ── ALTCHA detection ─────────────────────────────────────────────────────────

interface AltchaDetection {
  widgetSelector: string;
  inputSelector?: string;
  stateSelector: string;
}

const ALTCHA_WIDGET_SELECTORS = [
  "altcha-widget",
  "[name='altcha']",
  "[data-altcha]",
  "[class*='altcha' i]",
];

function getVisibleRect(page: PageAdapter, selector: string): Promise<boolean> {
  return page.evaluate((sel: string) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }, selector as never) as Promise<boolean>;
}

async function detectAltchaCaptcha(page: PageAdapter): Promise<AltchaDetection | null> {
  for (const selector of ALTCHA_WIDGET_SELECTORS) {
    const el = await page.$(selector);
    if (!el) continue;
    const visible = await getVisibleRect(page, selector);
    if (!visible) continue;

    const inputSelector = await page.evaluate((sel: string) => {
      const widget = document.querySelector<any>(sel);
      if (!widget) return "";
      const lightDomInput =
        (widget.querySelector("input[name='altcha']") as HTMLInputElement | null) ||
        document.querySelector<HTMLInputElement>("input[name='altcha']");
      return lightDomInput ? "input[name='altcha']" : "";
    }, selector as never) as string;

    return {
      widgetSelector: selector,
      inputSelector: inputSelector || undefined,
      stateSelector: selector,
    };
  }

  return null;
}

async function waitForAltchaVerification(page: PageAdapter, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const solved = await page.evaluate(() => {
        const widget = document.querySelector<any>("altcha-widget, [name='altcha'], [data-altcha]");
        const lightDomInput = document.querySelector<HTMLInputElement>("input[name='altcha']");
        if (lightDomInput && lightDomInput.value.trim().length > 0) return true;
        if (widget) {
          const state = typeof widget.getState === "function" ? widget.getState() : "";
          if (state === "verified") return true;
          const shadowCheckbox = widget.shadowRoot?.querySelector("input[type='checkbox']") as HTMLInputElement | null;
          if (shadowCheckbox?.checked) return true;
        }
        return false;
      }) as boolean;
      if (solved) return true;
    } catch {
      // ignore and keep polling
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function clickAltchaWidget(page: PageAdapter): Promise<boolean> {
  try {
    const directClick = await page.evaluate(() => {
      const widget = document.querySelector<any>("altcha-widget, [name='altcha'], [data-altcha]");
      if (!widget) return false;
      const checkbox = widget.shadowRoot?.querySelector("input[type='checkbox']") as HTMLInputElement | null;
      if (checkbox) {
        checkbox.click();
        return true;
      }
      if (typeof widget.verify === "function") {
        widget.verify();
        return true;
      }
      return false;
    }) as boolean;
    if (directClick) return true;

    const widget = await page.$("altcha-widget, [name='altcha'], [data-altcha]");
    if (!widget) return false;
    const box = await widget.boundingBox();
    if (!box || box.width === 0 || box.height === 0) return false;
    await page.mouse.move(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
    await new Promise((r) => setTimeout(r, 150));
    await page.mouse.click(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
    return true;
  } catch {
    return false;
  }
}

// ── Token captcha detection ───────────────────────────────────────────────────

const TOKEN_CAPTCHA_SELECTORS: Array<{ selector: string; type: CaptchaTokenType }> = [
  { selector: "iframe[src*='recaptcha']", type: "reCAPTCHA" },
  { selector: ".g-recaptcha", type: "reCAPTCHA" },
  { selector: "iframe[src*='hcaptcha']", type: "hCaptcha" },
  { selector: ".h-captcha", type: "hCaptcha" },
  { selector: "iframe[src*='turnstile']", type: "Turnstile" },
  { selector: ".cf-turnstile", type: "Turnstile" },
];

interface TokenDetection {
  type: CaptchaTokenType;
  sitekey: string | null;
}

async function detectTokenCaptcha(page: PageAdapter): Promise<TokenDetection | null> {
  // ── 0. Cloudflare Turnstile in reCAPTCHA-compatibility mode ───────────────
  // Some sites (e.g. betadash.lunes.host) embed Cloudflare Turnstile but render
  // it inside a `.g-recaptcha` container with a `g-recaptcha-response` field for
  // drop-in reCAPTCHA compatibility. Detecting `.g-recaptcha` first would
  // misclassify it as reCAPTCHA and skip the (working) Turnstile solve path,
  // leaving the login stuck on the form. Turnstile has unambiguous fingerprints
  // that we must check BEFORE the generic selectors below:
  //   - a hidden `input[name='cf-turnstile-response']`
  //   - the Cloudflare challenges script / iframe
  //   - a sitekey in Turnstile format (starts with "0x"; reCAPTCHA keys start
  //     with "6L", hCaptcha are UUIDs)
  const turnstile = await page.evaluate(() => {
    const cfInput = document.querySelector("input[name='cf-turnstile-response']");
    const cfScript = document.querySelector("script[src*='challenges.cloudflare.com']");
    const cfIframe = document.querySelector(
      "iframe[src*='turnstile'], iframe[src*='challenges.cloudflare.com']",
    );
    // An explicit Turnstile host container is a strong signal even before the
    // iframe/input have mounted.
    const cfContainer = document.querySelector(".cf-turnstile");
    // Sitekey may live on .cf-turnstile, .g-recaptcha, or any [data-sitekey] host.
    let sitekey: string | null = null;
    const hosts = document.querySelectorAll<HTMLElement>(
      ".cf-turnstile, .g-recaptcha, [data-sitekey]",
    );
    for (const h of Array.from(hosts)) {
      const k = h.dataset.sitekey ?? h.getAttribute("data-sitekey");
      if (k) { sitekey = k; break; }
    }
    const isTurnstileKey = !!sitekey && /^0x/i.test(sitekey);
    // IMPORTANT: the Cloudflare challenges script (`cfScript`) is loaded
    // AMBIENTLY by many sites for CF's own bot-management / Turnstile-anywhere
    // even when there is NO interactive Turnstile widget in the page's forms
    // (e.g. KataBump, which actually protects its dialogs with ALTCHA). Treating
    // that script alone as "Turnstile detected" misclassifies ALTCHA/other
    // captchas as Turnstile and then hard-fails with a bogus
    // "Turnstile detected — bypass failed" message. Only classify as Turnstile
    // when there is a REAL widget fingerprint: the hidden response input, an
    // actual Turnstile iframe, a `.cf-turnstile` container, or a Turnstile-format
    // sitekey. The bare script is used only as a corroborating signal alongside
    // a container/sitekey — never on its own.
    const hasWidget = !!(cfInput || cfIframe || cfContainer || isTurnstileKey);
    const detected = hasWidget || (!!cfScript && !!sitekey);
    return { detected, sitekey };
  }) as { detected: boolean; sitekey: string | null };

  if (turnstile.detected) {
    logger.warn(
      { type: "Turnstile", sitekey: turnstile.sitekey },
      "Turnstile detected (incl. reCAPTCHA-compatibility mode)",
    );
    return { type: "Turnstile", sitekey: turnstile.sitekey };
  }

  for (const { selector, type } of TOKEN_CAPTCHA_SELECTORS) {
    const el = await page.$(selector);
    if (el) {
      const sitekey = await page.evaluate((sel: unknown) => {
        const found = document.querySelector<HTMLElement>(sel as string);
        return found?.dataset.sitekey ?? null;
      }, selector as never) as string | null;
      logger.warn({ type, sitekey }, "Token captcha detected");
      return { type, sitekey };
    }
  }
  // Generic sitekey attribute fallback
  const genericEl = await page.$("[data-sitekey]");
  if (genericEl) {
    const sitekey = await page.evaluate(() => {
      return document.querySelector<HTMLElement>("[data-sitekey]")?.dataset.sitekey ?? null;
    }) as string | null;
    logger.warn({ sitekey }, "Generic sitekey captcha detected");
    return { type: "reCAPTCHA", sitekey };
  }
  return null;
}

// ── Image captcha detection ───────────────────────────────────────────────────

const IMAGE_CAPTCHA_IMG_SELECTORS = [
  "img[src*='captcha' i]",
  "img[id*='captcha' i]",
  "img[class*='captcha' i]",
  "img[alt*='captcha' i]",
  "img[name*='captcha' i]",
];

const IMAGE_CAPTCHA_INPUT_SELECTORS = [
  "input[name*='captcha' i]",
  "input[id*='captcha' i]",
  "input[placeholder*='captcha' i]",
  "input[class*='captcha' i]",
  "input[autocomplete='off'][name]", // fallback near-captcha inputs
];

interface ImageCaptchaDetection {
  imgSelector: string;
  inputSelector: string;
}

async function detectImageCaptcha(page: PageAdapter): Promise<ImageCaptchaDetection | null> {
  for (const imgSel of IMAGE_CAPTCHA_IMG_SELECTORS) {
    const el = await page.$(imgSel);
    if (!el) continue;

    const visible = await page.evaluate((sel: unknown) => {
      const e = document.querySelector<HTMLElement>(sel as string);
      if (!e) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }, imgSel as never) as boolean;
    if (!visible) continue;

    for (const inputSel of IMAGE_CAPTCHA_INPUT_SELECTORS) {
      const input = await page.$(inputSel);
      if (input) {
        logger.warn({ imgSel, inputSel }, "Image captcha detected");
        return { imgSelector: imgSel, inputSelector: inputSel };
      }
    }
  }
  return null;
}

// ── Token injection ───────────────────────────────────────────────────────────

async function injectCaptchaToken(
  page: PageAdapter,
  type: CaptchaTokenType,
  token: string,
): Promise<void> {
  if (type === "reCAPTCHA") {
    await page.evaluate((t: unknown) => {
      const ta = document.querySelector<HTMLTextAreaElement>(
        "textarea#g-recaptcha-response, textarea[name='g-recaptcha-response']",
      );
      if (ta) {
        ta.style.display = "block";
        ta.value = t as string;
      }
      // Trigger the reCAPTCHA callback so the form knows the captcha is solved
      try {
        // @ts-ignore — grecaptcha is injected by the reCAPTCHA script
        if (typeof grecaptcha !== "undefined" && grecaptcha?.getResponse) {
          // Find and invoke the callback registered by the site
          const widgets = document.querySelectorAll(".g-recaptcha");
          widgets.forEach((w) => {
            const cbName = w.getAttribute("data-callback");
            // @ts-ignore
            if (cbName && typeof window[cbName] === "function") window[cbName](t);
          });
        }
      } catch {}
    }, token as never);
  } else if (type === "hCaptcha") {
    await page.evaluate((t: unknown) => {
      const ta = document.querySelector<HTMLTextAreaElement>(
        "textarea[name='h-captcha-response'], textarea[id='h-captcha-response']",
      );
      if (ta) {
        ta.style.display = "block";
        ta.value = t as string;
      }
      // Trigger hCaptcha callback
      try {
        const widgets = document.querySelectorAll(".h-captcha");
        widgets.forEach((w) => {
          const cbName = w.getAttribute("data-callback");
          // @ts-ignore
          if (cbName && typeof window[cbName] === "function") window[cbName](t);
        });
      } catch {}
    }, token as never);
  } else {
    // Turnstile — inject token AND trigger the response callback
    await page.evaluate((t: unknown) => {
      const input = document.querySelector<HTMLInputElement>(
        "input[name='cf-turnstile-response']",
      );
      if (input) {
        input.value = t as string;
        // Dispatch input/change events so form validation picks it up
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // Invoke the Turnstile callback registered by the site
      try {
        // Method 1: data-callback attribute on the widget container
        const widgets = document.querySelectorAll(".cf-turnstile, [data-sitekey]");
        widgets.forEach((w) => {
          const cbName = w.getAttribute("data-callback");
          // @ts-ignore
          if (cbName && typeof window[cbName] === "function") window[cbName](t);
        });
        // Method 2: turnstile.getResponse() — call any registered callbacks
        // @ts-ignore
        if (typeof turnstile !== "undefined" && turnstile?.render) {
          // turnstile object exists — the widget may have stored callbacks internally.
          // We can't directly access them, but setting the hidden input + dispatching
          // events is usually enough for form submission.
        }
      } catch {}
    }, token as never);
  }
}

// ── Click-to-verify captcha detection (GeeTest, Tencent, Yidun, etc.) ───────

interface ClickCaptchaDetection {
  name: string;
  /** CSS selector for the clickable button/element that initiates verification */
  buttonSelector: string;
  /** Optional: CSS selector to check for success state after clicking */
  successSelector?: string;
  /** Optional: text strings that indicate success (checked in the widget text content) */
  successTexts?: string[];
  /** Optional: CSS selector for the widget container (used for visibility check) */
  containerSelector: string;
}

const CLICK_CAPTCHA_PROVIDERS: ClickCaptchaDetection[] = [
  // GeeTest v3 — "点击按钮进行验证" button
  {
    name: "GeeTest v3",
    containerSelector: ".geetest_radar_tip, .geetest_btn, .geetest_widget",
    buttonSelector: ".geetest_radar_tip, .geetest_btn",
    successSelector: ".geetest_success_radar_tip, .geetest_success_btn",
    successTexts: ["Verification Success", "验证成功", "success"],
  },
  // GeeTest v4 — nativeButton click mode (loads async; wait for button before clicking)
  {
    name: "GeeTest v4",
    containerSelector: ".embed-captcha, .geetest-onloading-placeholder, [class*='geetest_holder'], [class*='geetest_captcha'], .geetest_btn_click, .geetest_box_wrap",
    buttonSelector: "[class*='geetest_btn_click']",
    successSelector: "[class*='geetest_btn_click'][class*='geetest_success']",
    successTexts: ["Verification Success", "验证成功", "success"],
  },
  // Tencent Captcha (腾讯验证码) — usually a button that opens a popup
  {
    name: "Tencent Captcha",
    containerSelector: "#TencentCaptcha, .tc-action-btn",
    buttonSelector: "#TencentCaptcha, .tc-action-btn",
  },
  // NetEase Yidun (网易易盾) — click-to-verify button
  {
    name: "NetEase Yidun",
    containerSelector: ".yidun_btn, .yidun--jigsaw",
    buttonSelector: ".yidun_btn, .yidun_slider__icon",
    successSelector: ".yidun_btn--success",
  },
  // Vaptcha — click-to-verify
  {
    name: "Vaptcha",
    containerSelector: ".vaptcha-container",
    buttonSelector: ".vaptcha-click-btn, .vaptcha-container button",
    successSelector: ".vaptcha-success",
  },
  // Dingxiang (顶象) — click verification
  {
    name: "Dingxiang",
    containerSelector: ".dx-captcha, #dx-captcha",
    buttonSelector: ".dx-captcha-btn, .dx-btn",
    successSelector: ".dx-captcha-btn-success",
  },
  // Generic click-to-verify — covers custom captcha buttons on sites that use
  // a simple "click to verify" button within the login form that doesn't match
  // any known provider selectors above.
  // NOTE: ikuuu.fyi is NOT handled here — it uses GeeTest v4 (initGeetest4 with
  // nativeButton mode), which is matched by the "GeeTest v4" provider above.
  {
    name: "Generic click-to-verify",
    containerSelector: ".verify-btn, .captcha-btn, [class*='verify-btn'], [class*='captcha-btn'], [id*='captcha-btn']",
    buttonSelector: ".verify-btn, .captcha-btn, [class*='verify-btn'], [class*='captcha-btn'], [id*='captcha-btn']",
    successTexts: ["success", "成功", "通过", "verified"],
  },
];

/**
 * Detect and attempt to click-bypass common click-to-verify captchas.
 * These are captchas that present a button/checkbox to click (similar to reCAPTCHA's
 * "I'm not a robot") before escalating to slider/image challenges.
 *
 * Returns null if no click captcha was detected.
 */
async function detectAndBypassClickCaptcha(page: PageAdapter): Promise<CaptchaResult | null> {
  for (const provider of CLICK_CAPTCHA_PROVIDERS) {
    try {
      const container = await page.$(provider.containerSelector);
      if (!container) continue;

      // Verify the container is visible
      const visible = await container.evaluate((e: Element) => {
        const r = e.getBoundingClientRect();
        const style = window.getComputedStyle(e);
        return r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }).catch(() => false) as boolean;
      if (!visible) continue;

      logger.info({ provider: provider.name }, "Click-to-verify captcha detected — attempting click bypass");

      // Find the button — if not found immediately, wait up to 10 s for async captcha load
        // (GeeTest v4 renders its button asynchronously after initGeetest4 completes)
        let btn = await page.$(provider.buttonSelector);
        if (!btn) {
          const btnDeadline = Date.now() + 10_000;
          while (!btn && Date.now() < btnDeadline) {
            await new Promise((r) => setTimeout(r, 500));
            btn = await page.$(provider.buttonSelector);
          }
        }
        if (!btn) {
          logger.debug({ provider: provider.name }, "Container visible but button not found after 10 s wait, skipping");
          continue;
        }

              const box = await btn.boundingBox();
      if (!box) {
        logger.debug({ provider: provider.name }, "Button has no bounding box, skipping");
        continue;
      }

      // Helper: poll for a GeeTest/click-captcha success token for up to `ms`.
      // GeeTest v4 in nativeButton mode fires onSuccess asynchronously and does
      // NOT add a success CSS class / change tip text / hide the container, so
      // the ONLY reliable success signal is the populated result token. We poll
      // generously because on datacenter IPs the server-side validation round
      // trip is slower.
      const pollClickCaptchaSuccess = async (ms: number): Promise<"solved" | "escalated" | "pending"> => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 600));
          let solved = false;
          try {
            solved = await page.evaluate(() => {
              const cap = (window as unknown as Record<string, { isReady?: () => boolean }>)["Captcha"];
              if (cap && typeof cap.isReady === "function" && cap.isReady()) return true;
              const gtFields = document.querySelectorAll<HTMLInputElement>(
                "input[name='lot_number'], input[name='captcha_output'], input[name='pass_token'], input[name='gen_time']"
              );
              if (gtFields.length > 0) {
                const allFilled = Array.from(gtFields).every((f) => f.value.length > 0);
                if (allFilled) return true;
              }
              const successBtn = document.querySelector("[class*='geetest_btn_click'][class*='geetest_success']");
              if (successBtn) return true;
              const holder = document.querySelector("[class*='geetest_holder']");
              if (holder) {
                const text = holder.textContent?.toLowerCase() ?? "";
                if (text.includes("success") || text.includes("验证成功")) return true;
              }
              return false;
            }) as boolean;
          } catch { return "pending"; }
          if (solved) return "solved";

          // A visible slider/image challenge popup means the click was rejected
          // and the captcha escalated to an interactive challenge we cannot
          // solve with a blind click.
          try {
            const challengeVisible = await page.evaluate(() => {
              const sels = [
                "[class*='geetest_box_wrap']", "[class*='geetest_panel']",
                "[class*='geetest_window']", "[class*='geetest_canvas']",
                "[class*='geetest_mask'][class*='geetest_show']",
              ];
              return sels.some((s) => {
                const el = document.querySelector<HTMLElement>(s);
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const st = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
              });
            }) as boolean;
            if (challengeVisible) return "escalated";
          } catch { /* ignore */ }
        }
        return "pending";
      };

      // Multi-attempt click bypass. GeeTest v4 scores mouse behaviour, so we
      // warm up a human-interaction signal before every click and retry a few
      // times (each retry re-warms) before giving up.
      let escalatedToChallenge = false;
      const MAX_CLICK_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_CLICK_ATTEMPTS; attempt++) {
        try {
          // On a retry, re-check success BEFORE clicking again. GeeTest v4
          // nativeButton frequently confirms its token a beat after our poll
          // window closes; re-clicking (or resetting) an already-passed widget
          // is exactly what pushes a simple click flow into the picture-
          // selection challenge. If it's already solved, take the win.
          if (attempt > 1) {
            const recheck = await pollClickCaptchaSuccess(1500);
            if (recheck === "solved") {
              logger.info({ provider: provider.name, attempt }, "Captcha already solved on retry re-check — token populated");
              return { detected: true, solved: true, message: `${provider.name} click captcha solved (token populated)` };
            }
            if (recheck === "escalated") { escalatedToChallenge = true; break; }
          }

          // Re-resolve the button box each attempt (it can move/re-render).
          const freshBtn = (await page.$(provider.buttonSelector)) ?? btn;
          const clickBox = (await freshBtn.boundingBox()) ?? box;
          if (!clickBox) break;

          // ── Fuller human-interaction warm-up ──────────────────────────────
          // Clicking cold (no prior movement) inflates GeeTest's risk score and
          // pushes it to the picture-selection challenge. Wander the pointer a
          // few times and dwell near the button before committing the click.
          for (let w = 0; w < (attempt === 1 ? 3 : 2); w++) {
            try { await simulateHumanMouseMovement(page); } catch { /* non-critical */ }
            await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
          }
          // Approach the button in two hops, then dwell — a real cursor rarely
          // teleports straight onto the target.
          const targetX = clickBox.x + clickBox.width / 2 + (Math.random() * 6 - 3);
          const targetY = clickBox.y + clickBox.height / 2 + (Math.random() * 4 - 2);
          await page.mouse.move(clickBox.x + clickBox.width * 0.25, clickBox.y + clickBox.height * 0.4);
          await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
          await page.mouse.move(targetX, targetY);
          await new Promise((r) => setTimeout(r, 180 + Math.random() * 260));
          // Real-coordinate click. On the SeleniumBase/cf-proxy backend this is
          // an OS-level xdotool click; on CDP backends it is a genuine synthetic
          // pointer event at the widget coordinates (never an element.click()).
          await page.mouse.click(targetX, targetY);
          logger.info({ provider: provider.name, attempt }, "Clicked captcha button (real coordinates)");

          // Extended, relaxed token polling — longer on the first attempts.
          const pollMs = attempt === 1 ? 20_000 : 14_000;
          const outcome = await pollClickCaptchaSuccess(pollMs);
          if (outcome === "solved") {
            logger.info({ provider: provider.name, attempt }, "Captcha verification succeeded — result token is populated");
            return { detected: true, solved: true, message: `${provider.name} click captcha solved (token populated)` };
          }
          if (outcome === "escalated") {
            escalatedToChallenge = true;
            logger.info({ provider: provider.name, attempt }, "GeeTest escalated to slider/image challenge");
            break;
          }
          logger.debug({ provider: provider.name, attempt }, "Click captcha token not populated yet — retrying");

          // NOTE: deliberately do NOT call Captcha.reset() between attempts.
          // reset() discards a nativeButton verification that may have just
          // succeeded server-side (the token often lands a moment after our
          // poll window) and forces a fresh, higher-risk challenge — which is
          // what regressed the simple ikuuu.fyi click flow into the picture-
          // selection challenge. The top-of-loop re-check above catches a late
          // token instead.
          await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
        } catch (err) {
          logger.debug({ err, provider: provider.name, attempt }, "Click captcha bypass attempt error");
        }
      }

      try {
        // Post-loop success checks — CSS selector / text / container gone.
        if (provider.successSelector) {
          const success = await page.$(provider.successSelector);
          if (success) {
            logger.info({ provider: provider.name }, "Click captcha bypassed — success element found");
            return { detected: true, solved: true, message: `${provider.name} click captcha bypassed` };
          }
        }
        if (provider.successTexts?.length) {
          const widgetText = await page.evaluate((sel: unknown) => {
            const el = document.querySelector<HTMLElement>(sel as string);
            return el?.textContent?.trim() ?? "";
          }, provider.containerSelector as never) as string;
          if (provider.successTexts.some((t) => widgetText.toLowerCase().includes(t.toLowerCase()))) {
            logger.info({ provider: provider.name, widgetText }, "Click captcha bypassed — success text found");
            return { detected: true, solved: true, message: `${provider.name} click captcha bypassed (text: "${widgetText}")` };
          }
        }

        // Check if container disappeared
        const stillVisible = await page.evaluate((sel: unknown) => {
          const el = document.querySelector<HTMLElement>(sel as string);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        }, provider.containerSelector as never) as boolean;

        if (!stillVisible) {
          logger.info({ provider: provider.name }, "Click captcha bypassed — widget disappeared");
          return { detected: true, solved: true, message: `${provider.name} click captcha bypassed` };
        }

        // Re-confirm escalation state right now (popup may have appeared/closed).
        if (!escalatedToChallenge) {
          escalatedToChallenge = await page.evaluate(() => {
            const sels = [".geetest_window", ".geetest_panel_next", ".geetest_canvas_img",
              ".yidun_slider", ".yidun_panel", ".tc-imgarea", "#tcaptcha_iframe",
              ".vaptcha-panel", ".dx-captcha-slider"];
            const attrSels = ["[class*='geetest_box_wrap']", "[class*='geetest_panel']",
              "[class*='geetest_mask'][class*='geetest_show']",
              "[class*='geetest_window']", "[class*='geetest_canvas']"];
            const allSels = [...sels, ...attrSels];
            return allSels.some((s) => {
              const el = document.querySelector<HTMLElement>(s);
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
            });
          }) as boolean;
        }
      } catch (err) {
        logger.debug({ err, provider: provider.name }, "Click captcha post-attempt check error");
      }

      // Decide the outcome. ONLY treat this as needs-attention when the captcha
      // actually escalated to an interactive slider/image challenge that a blind
      // click cannot solve. Otherwise return solved:false WITHOUT needsAttention
      // so the caller proceeds with the login attempt — the click may have
      // registered server-side even though we could not confirm the token in
      // time, and hard-failing here is the ikuuu.fyi false-positive we are
      // fixing. Detected-but-unconfirmed simple click flows should never block.
      if (escalatedToChallenge) {
        logger.warn({ provider: provider.name }, "Click captcha escalated to complex challenge — manual/solver required");
        return { detected: true, solved: false, needsAttention: true,
          message: `${provider.name} escalated to slider/image challenge — manual intervention or captcha solver required.` };
      }
      logger.warn({ provider: provider.name }, "Click captcha not confirmed solved — proceeding without blocking");
      return { detected: true, solved: false, needsAttention: false,
        message: `${provider.name} detected; click attempted but success token not confirmed — proceeding with login.` };
    } catch (err) {
      logger.debug({ err, provider: provider.name }, "Click captcha detection error");
    }
  }

  return null;
}

async function detectAndBypassAltcha(page: PageAdapter): Promise<CaptchaResult | null> {
  const detection = await detectAltchaCaptcha(page);
  if (!detection) return null;

  logger.info({ widget: detection.widgetSelector }, "ALTCHA widget detected — driving proof-of-work verification");

  // ALTCHA needs a human-interaction signal (HIS) on newer widgets and, in
  // "onload"/auto mode, verifies in the background. Nudge the page with a bit
  // of mouse movement so the widget will start solving, then wait.
  try { await simulateHumanMouseMovement(page); } catch { /* non-critical */ }

  // 1. It may already be verified (auto mode) or verify in the background.
  if (await waitForAltchaVerification(page, 8_000)) {
    logger.info("ALTCHA verified automatically (token populated)");
    return { detected: true, solved: true, message: "ALTCHA verified (auto proof-of-work)" };
  }

  // 2. Not auto-verified — click the checkbox/switch to kick off the PoW, then
  //    poll for the token (PoW can take several seconds on slow CPUs).
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { await simulateHumanMouseMovement(page); } catch { /* non-critical */ }
    const clicked = await clickAltchaWidget(page);
    if (!clicked) {
      logger.debug({ attempt }, "Could not locate ALTCHA widget to click");
    }
    if (await waitForAltchaVerification(page, 30_000)) {
      logger.info({ attempt }, "ALTCHA verified after click (token populated)");
      return { detected: true, solved: true, message: `ALTCHA verified via checkbox click (attempt ${attempt})` };
    }
    // Try programmatically triggering verification via the widget API before retrying.
    try {
      await page.evaluate(() => {
        const w = document.querySelector<any>("altcha-widget, [name='altcha'], [data-altcha]");
        if (w && typeof w.verify === "function") w.verify();
      });
    } catch { /* non-critical */ }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Final check — the PoW may have completed during the last retry wait.
  if (await waitForAltchaVerification(page, 5_000)) {
    logger.info("ALTCHA verified on final check (token populated)");
    return { detected: true, solved: true, message: "ALTCHA verified (proof-of-work completed)" };
  }

  return {
    detected: true,
    solved: false,
    needsAttention: true,
    message:
      "ALTCHA captcha detected but proof-of-work verification did not complete (token never populated). " +
      "ALTCHA runs entirely in-browser (there is no external solver for it) — the widget either failed to " +
      "load its script, the page requires a secure (HTTPS) context, or the PoW is still running. Retry the task.",
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect and attempt to solve any captcha or Cloudflare challenge on the page.
 *
 * Order of operations:
 *   1. Cloudflare JS/Turnstile challenge — bypass via mouse simulation / iframe click
 *   2. Click-to-verify captchas (GeeTest, Tencent, Yidun, etc.) — bypass via click
 *   3. Standard token captchas (reCAPTCHA / hCaptcha / Turnstile widget) — solve via API
 *   4. Image captchas — screenshot element and solve via API
 */
export async function detectAndHandleCaptcha(
  page: PageAdapter,
  solver: CaptchaSolver | null,
): Promise<CaptchaResult> {
  const altchaResult = await detectAndBypassAltcha(page);
  if (altchaResult) return altchaResult;

  // ── 1. Cloudflare challenge ──────────────────────────────────────────────
  const cfResult = await bypassCloudflareChallenge(page);
  if (cfResult === "passed") {
    return { detected: true, solved: true, message: "Cloudflare challenge bypassed via mouse simulation" };
  }
  if (cfResult === "blocked") {
    // WAF block — IP/fingerprint is blocked. No browser-level bypass possible.
    return {
      detected: true,
      solved: false,
      needsAttention: true,
      message:
        "Cloudflare WAF has blocked this IP address. This is not a captcha challenge — " +
        "the site's firewall is rejecting the connection entirely. " +
        "To resolve: use a residential/mobile proxy, or whitelist the server IP with the site operator.",
    };
  }
  if (cfResult === "failed") {
    if (!solver) {
      // No solver configured — don't immediately hard-fail. The bypass already
      // attempted mouse simulation + checkbox clicks multiple times. Log a warning
      // but let the login flow continue — sometimes the challenge clears on its
      // own after form submission, or the page works despite the overlay.
      logger.warn("CF challenge not bypassed and no captcha solver configured — proceeding with login attempt");
      return {
        detected: true,
        solved: false,
        needsAttention: false,
        message:
          "Cloudflare challenge detected; bypass attempted (mouse simulation + click) but not confirmed cleared. " +
          "Proceeding with login — if it fails, consider configuring a captcha solver.",
      };
    }
    // Fall through and let the Turnstile token solver handle it
    logger.info("CF bypass failed — will attempt Turnstile token solve via API");
  }

  // ── 2. Click-to-verify captchas (GeeTest, Tencent, Yidun, etc.) ─────────
  const clickResult = await detectAndBypassClickCaptcha(page);
  if (clickResult) {
    if (clickResult.detected && (clickResult as { solved?: boolean }).solved) return clickResult;
    // Not solved — if needsAttention, return immediately (don't lose the result)
    if (clickResult.detected && !(clickResult as { solved?: boolean }).solved && (clickResult as { needsAttention?: boolean }).needsAttention) {
      logger.warn({ message: (clickResult as { message?: string }).message }, "Click captcha detected but not solved — returning captcha blocked");
      return clickResult;
    }
    // Not solved but not needsAttention — log and continue to token/image detection
    logger.info({ message: (clickResult as { message?: string }).message }, "Click captcha detected but not solved, continuing to token/image detection");
  }

  // ── 3. Token captcha (reCAPTCHA / hCaptcha / Turnstile) ─────────────────
  const tokenDetection = await detectTokenCaptcha(page);
  if (tokenDetection) {
    const { type, sitekey } = tokenDetection;

    // For Turnstile widgets embedded in login forms (not full-page CF challenge),
    // first poll for auto-solve, then try iframe clicks with retries.
    //
    // Many sites use Turnstile in "managed" or "non-interactive" mode where the
    // widget auto-solves in the background.  The token may appear in the hidden
    // input a few seconds after page load.  Some sites (e.g. justrunmy.app) show
    // "Verify you are human" even though the token is already populated — a single
    // click on the iframe body flips the UI to "Success!" and the form is ready.
    if (type === "Turnstile" && !solver) {
      // Turnstile writes its solved token into `cf-turnstile-response` in native
      // mode, but into `g-recaptcha-response` when embedded in reCAPTCHA-
      // compatibility mode (a `.g-recaptcha` container — e.g. betadash.lunes.host
      // / the "Renew your Free plan" bot-check dialog). Check BOTH so an
      // auto-solve in compat mode isn't missed, which would otherwise leave the
      // widget stuck on "Verifying..." until we wrongly report needsAttention.
      const checkTurnstileToken = () =>
        page.evaluate(() => {
          const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            "input[name='cf-turnstile-response'], textarea[name='cf-turnstile-response'], " +
              "textarea[name='g-recaptcha-response'], textarea#g-recaptcha-response, " +
              "input[name='g-recaptcha-response']",
          );
          for (const f of Array.from(fields)) {
            if (f.value && f.value.trim().length > 0) return true;
          }
          return false;
        }) as Promise<boolean>;

      /** Detect the current visual state of the Turnstile widget.
       *
       * IMPORTANT: Turnstile renders its iframe inside a **closed shadow DOM**,
       * which means `document.querySelectorAll("iframe")` cannot find it.
       * We use two detection methods:
       *   1. Playwright's `page.frames()` API — works across shadow DOM boundaries
       *   2. The `.cf-turnstile` container's bounding box — visible even with closed shadow
       */
      const getTurnstileState = async (): Promise<string> => {
        // Pre-fetch frames for SeleniumBase adapter
        if ("fetchFrames" in page && typeof (page as any).fetchFrames === "function") {
          await (page as any).fetchFrames();
        }
        // Method 1: Check Playwright frames (works with closed shadow DOM)
        try {
          const hasTurnstileFrame = page.frames().some(
            (f: { url(): string }) => {
              const u = f.url();
              return u.includes("challenges.cloudflare.com") || u.includes("turnstile");
            },
          );
          if (hasTurnstileFrame) return "widget_visible";
        } catch {
          // frames() may not be available in all adapters
        }

        // Method 2: Check the container element (fallback)
        const state = await page.evaluate(() => {
          // DOM iframe check (may fail with closed shadow DOM, but worth trying)
          const frames = Array.from(document.querySelectorAll("iframe"));
          for (const f of frames) {
            if ((f.src ?? "").includes("challenges.cloudflare.com") || (f.src ?? "").includes("turnstile")) {
              const rect = f.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) return "widget_visible";
            }
          }
          // Container check — visible even when iframe is in closed shadow DOM
          const container = document.querySelector<HTMLElement>(".cf-turnstile, [data-sitekey]");
          if (container) {
            const rect = container.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return "widget_visible";
          }
          return "not_found";
        }) as string;
        return state;
      };

      logger.info("Turnstile widget detected without solver — waiting for verification");

      // ── Phase 1: Wait for Turnstile to finish its background verification ──
      // Turnstile goes through: loading → "Verifying..." → either auto-solve
      // (token populated) or interactive ("Verify you are human" checkbox).
      //
      // CRITICAL: Turnstile's PoW checks for human interaction signals (mouse
      // movement, scroll, keyboard) during the verification phase. A page with
      // zero interaction looks like a headless bot. We simulate human presence
      // throughout the wait to help the PoW pass.
      const VERIFY_TIMEOUT_MS = 40_000;
      const POLL_INTERVAL_MS = 2_000;
      const verifyDeadline = Date.now() + VERIFY_TIMEOUT_MS;

      // Initial human presence burst before waiting
      await simulateHumanMouseMovement(page);

      while (Date.now() < verifyDeadline) {
        // Check if token already populated (auto-solve / managed mode)
        if (await checkTurnstileToken()) {
          logger.info("Turnstile auto-solved (token present after waiting)");
          return { detected: true, solved: true, message: "Turnstile widget auto-solved (managed mode)" };
        }

        // Check if Turnstile is still processing (iframe present, no token yet)
        // If the widget disappeared, no point waiting further
        const state = await getTurnstileState();
        if (state === "not_found") {
          logger.debug("Turnstile widget no longer visible — breaking wait loop");
          break;
        }

        // Simulate human activity while waiting — Turnstile monitors mouse/keyboard
        // events during its PoW verification phase as a liveness signal.
        await simulateHumanMouseMovement(page);

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      // Final token check after full wait
      if (await checkTurnstileToken()) {
        logger.info("Turnstile auto-solved (token present after full wait)");
        return { detected: true, solved: true, message: "Turnstile widget auto-solved (managed mode)" };
      }

      // ── Phase 2: Token not auto-populated — try clicking the checkbox ──
        // Calls clickTurnstileCheckbox which tries (in order):
        //   1. xdotool OS-level physical click (invisible to CF fingerprinting)
        //   2. Main-page widget bounding box click (CDP)
        //   3. Cross-origin iframe element click (CDP)
        // This is ported from JustRunMy.App's handle_turnstile() approach.
        logger.info("Turnstile not auto-solved after wait — attempting checkbox click (xdotool + CDP)");

        for (let attempt = 1; attempt <= 6; attempt++) {
          try {
            // Simulate human presence before each click attempt
            await simulateHumanMouseMovement(page);
            await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));

            // clickTurnstileCheckbox: expand iframe → xdotool → CDP fallback
            const clicked = await clickTurnstileCheckbox(page);
            if (!clicked) {
              logger.debug({ attempt }, "Could not locate Turnstile widget to click");
              if (attempt < 6) await new Promise((r) => setTimeout(r, 2000));
              continue;
            }

            // Wait for click to take effect — longer on first attempts (PoW takes time)
            const waitMs = attempt <= 2 ? 6000 + Math.random() * 3000 : 3500 + Math.random() * 2000;
            await new Promise((r) => setTimeout(r, waitMs));

            if (await checkTurnstileToken()) {
              logger.info({ attempt }, "Turnstile solved via click (token populated)");
              return { detected: true, solved: true, message: `Turnstile widget solved via click (attempt ${attempt})` };
            }

            // Some sites don't populate the hidden input but the widget disappears after solve
            const stateAfter = await getTurnstileState();
            if (stateAfter === "not_found") {
              logger.info({ attempt }, "Turnstile widget disappeared after click — likely solved");
              return { detected: true, solved: true, message: "Turnstile widget solved (widget disappeared after click)" };
            }

            // Reset Turnstile on failure so next attempt gets a fresh challenge
            try {
              await page.evaluate(() => {
                // @ts-ignore
                if (typeof turnstile !== "undefined" && turnstile?.reset) turnstile.reset();
              });
              await new Promise((r) => setTimeout(r, 2000));
            } catch { /* non-critical */ }

            logger.debug({ attempt }, "Token still empty after click, retrying...");
          } catch (err) {
            logger.debug({ err, attempt }, "Turnstile click attempt threw");
          }
        }

        // Neither auto-solve nor click worked
        return {
          detected: true,
          solved: false,
          needsAttention: true,
          message:
            `${type} detected — auto-verification and click bypass both failed (including xdotool physical clicks). ` +
            `No captcha solver configured. Set CAPTCHA_PROVIDER and the corresponding ` +
            `API key to enable automatic solving.`,
        };
    }

    // ── reCAPTCHA v2 — free audio-challenge self-solve ────────────────────────
    // Try the audio challenge (download mp3 → speech-to-text → type answer)
    // BEFORE any paid token solver. Works on both cf-proxy (native/local
    // whisper) and Playwright backends. This is what makes cfVerify / login pass
    // reCAPTCHA on sites like host2play.gratis without a paid solver.
    if (type === "reCAPTCHA") {
      const audio = await solveRecaptchaAudio(page);
      if (audio.solved) {
        return { detected: true, solved: true, message: audio.message };
      }
      if (audio.blocked) {
        // IP-level block — no STT can fix this; surface for attention/rotation.
        return { detected: true, solved: false, needsAttention: true, message: audio.message };
      }
      if (!solver) {
        return {
          detected: true,
          solved: false,
          needsAttention: true,
          message:
            `${audio.message} No paid captcha solver configured as fallback ` +
            `(set CAPTCHA_PROVIDER + key, or configure RECAPTCHA_STT_ORDER / WIT_AI_TOKEN).`,
        };
      }
      logger.info("reCAPTCHA audio solve did not succeed — falling back to configured token solver");
      // fall through to the paid solver path below.
    }

    if (!solver) {
      return {
        detected: true,
        solved: false,
        needsAttention: true,
        message:
          `${type} detected — no captcha solver configured. ` +
          `Set CAPTCHA_PROVIDER and the corresponding API key (TWO_CAPTCHA_API_KEY / ` +
          `CAPSOLVER_API_KEY / ANTICAPTCHA_API_KEY) to enable automatic solving.`,
      };
    }

    if (!sitekey) {
      return {
        detected: true,
        solved: false,
        needsAttention: true,
        message: `${type} detected but could not extract sitekey. Manual resolution required.`,
      };
    }

    logger.info({ type, solver: solver.name }, "Attempting token captcha solve");
    const token = await solver.solveToken({ type, sitekey, pageUrl: page.url() });
    if (token) {
      await injectCaptchaToken(page, type, token);
      logger.info({ type, solver: solver.name }, "Token captcha solved and injected");
      return { detected: true, solved: true, message: `${type} solved via ${solver.name}` };
    }

    return {
      detected: true,
      solved: false,
      needsAttention: false,
      message: `${type} detected but ${solver.name} could not solve it — proceeding anyway`,
    };
  }

  // ── 4. Image captcha ─────────────────────────────────────────────────────
  const imageDetection = await detectImageCaptcha(page);
  if (imageDetection) {
    if (!solver) {
      return {
        detected: true,
        solved: false,
        needsAttention: true,
        message:
          "Image captcha detected — no solver configured. " +
          "Set CAPTCHA_PROVIDER + API key for automatic image solving.",
      };
    }

    logger.info({ solver: solver.name }, "Attempting image captcha solve");
    try {
      const imgEl = await page.$(imageDetection.imgSelector);
      if (!imgEl) {
        return {
          detected: true,
          solved: false,
          needsAttention: true,
          message: "Image captcha detected but element disappeared",
        };
      }

      const screenshotBuf = await imgEl.screenshot({ encoding: "base64" });
      const base64 =
        typeof screenshotBuf === "string"
          ? screenshotBuf
          : Buffer.from(screenshotBuf as Buffer).toString("base64");

      const answer = await solver.solveImage(base64);
      if (!answer) {
        return {
          detected: true,
          solved: false,
          needsAttention: true,
          message: `Image captcha detected but ${solver.name} could not solve it`,
        };
      }

      await page.click(imageDetection.inputSelector);
      await page.keyboard.type(answer, { delay: 60 });
      logger.info({ solver: solver.name }, "Image captcha answer typed");
      return { detected: true, solved: true, message: `Image captcha solved via ${solver.name}` };
    } catch (err) {
      logger.error({ err }, "Image captcha solve error");
      return { detected: true, solved: false, needsAttention: true, message: "Image captcha solve error" };
    }
  }

  return { detected: false };
}
