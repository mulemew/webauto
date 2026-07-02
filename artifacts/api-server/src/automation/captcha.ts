import type { PageAdapter } from "./page-adapter";
import { logger } from "../lib/logger";
import { bypassCloudflareChallenge, simulateHumanMouseMovement, clickTurnstileCheckbox } from "./cloudflare-bypass";
import type { CaptchaSolver, CaptchaTokenType } from "./captcha-solver";

export type { CaptchaSolver } from "./captcha-solver";

export type CaptchaResult =
  | { detected: false }
  | { detected: true; solved: true; message: string }
  | { detected: true; solved: false; needsAttention: boolean; message: string };

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
    const detected = !!(cfInput || cfScript || cfIframe || isTurnstileKey);
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
  // Generic click-to-verify — covers custom captcha buttons on Chinese sites
  // (e.g. ikuuu.fyi and others that use a simple "click to verify" button
  // within the login form that doesn't match known provider selectors).
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

      // Single quick attempt: move to button, click, check result
      try {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 200));
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        logger.info({ provider: provider.name }, "Clicked captcha button");

        // Wait for captcha result — for GeeTest v4 the onSuccess callback fires async
          // after the server validates the click. Check multiple signals:
          //   1. window.Captcha?.isReady() — custom API some sites implement
          //   2. GeeTest v4 hidden form fields (lot_number, captcha_output, etc.)
          //   3. Success CSS classes on the button
          //   4. Challenge popup appearing (means click-to-verify failed)
          {
            const readyDeadline = Date.now() + 15_000;
            let ready = false;
            while (!ready && Date.now() < readyDeadline) {
              await new Promise((r) => setTimeout(r, 600));
              try {
                ready = await page.evaluate(() => {
                  // Check custom Captcha API
                  const cap = (window as unknown as Record<string, { isReady?: () => boolean }>)["Captcha"];
                  if (cap && typeof cap.isReady === "function" && cap.isReady()) return true;
                  // Check GeeTest v4 result fields — these are populated when GeeTest
                  // validation succeeds (lot_number, captcha_output, pass_token, gen_time)
                  const gtFields = document.querySelectorAll<HTMLInputElement>(
                    "input[name='lot_number'], input[name='captcha_output'], input[name='pass_token'], input[name='gen_time']"
                  );
                  if (gtFields.length > 0) {
                    const allFilled = Array.from(gtFields).every((f) => f.value.length > 0);
                    if (allFilled) return true;
                  }
                  // Check GeeTest v4 success class on the button
                  const successBtn = document.querySelector("[class*='geetest_btn_click'][class*='geetest_success']");
                  if (successBtn) return true;
                  // Check GeeTest v4 success text
                  const holder = document.querySelector("[class*='geetest_holder']");
                  if (holder) {
                    const text = holder.textContent?.toLowerCase() ?? "";
                    if (text.includes("success") || text.includes("验证成功")) return true;
                  }
                  return false;
                }) as boolean;
              } catch { break; }

              // Also check if a challenge popup appeared (means click failed, need manual solve)
              try {
                const challengeVisible = await page.evaluate(() => {
                  const sels = ["[class*='geetest_box_wrap']", "[class*='geetest_panel']", "[class*='geetest_window']"];
                  return sels.some((s) => {
                    const el = document.querySelector<HTMLElement>(s);
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    const st = window.getComputedStyle(el);
                    return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
                  });
                }) as boolean;
                if (challengeVisible) {
                  logger.info({ provider: provider.name }, "GeeTest challenge popup appeared — click verification failed");
                  break; // Exit polling, escalation will be detected below
                }
              } catch { /* ignore */ }
            }
            if (!ready) {
              // No success signal detected — fall back to a brief wait
              await new Promise((r) => setTimeout(r, 1500 + Math.random() * 500));
            } else {
              logger.info({ provider: provider.name }, "Captcha verification succeeded — result is populated");
            }
          }

                  // Check success — CSS selector first, then text content
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

        // Check if escalated to complex challenge
        const escalated = await page.evaluate(() => {
          // GeeTest v3 selectors
          const sels = [".geetest_window", ".geetest_panel_next", ".geetest_canvas_img",
            ".yidun_slider", ".yidun_panel", ".tc-imgarea", "#tcaptcha_iframe",
            ".vaptcha-panel", ".dx-captcha-slider"];
          // GeeTest v4 selectors — use attribute selectors because v4 appends a hash
          // suffix to class names (e.g. geetest_box_wrap_620847ba)
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

        if (escalated) {
          logger.warn({ provider: provider.name }, "Click captcha escalated to complex challenge — cannot bypass");
          return { detected: true, solved: false, needsAttention: true,
            message: `${provider.name} escalated to slider/image challenge — manual intervention or captcha solver required.` };
        }
      } catch (err) {
        logger.debug({ err, provider: provider.name }, "Click captcha bypass attempt error");
      }

      // Click didn't solve it — pause for attention instead of wasting login retries
      logger.warn({ provider: provider.name }, "Click captcha not bypassed — pausing for attention");
      return { detected: true, solved: false, needsAttention: true,
        message: `${provider.name} detected but click bypass failed — manual intervention or captcha solver required.` };
    } catch (err) {
      logger.debug({ err, provider: provider.name }, "Click captcha detection error");
    }
  }

  return null;
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
      const checkTurnstileToken = () =>
        page.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>("input[name='cf-turnstile-response']");
          return input ? input.value.length > 0 : false;
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
