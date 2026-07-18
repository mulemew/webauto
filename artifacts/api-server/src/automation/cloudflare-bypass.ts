import type { PageAdapter } from "./page-adapter";
import { logger } from "../lib/logger";
import { execSync, execFileSync } from "child_process";

type CfChallengeType = "js_challenge" | "turnstile_click" | "waf_blocked" | "none";

// ── xdotool availability (checked once at startup) ──────────────────────────

let _xdotoolAvailable: boolean | null = null;
function isXdotoolAvailable(): boolean {
  if (_xdotoolAvailable === null) {
    // Require BOTH the xdotool binary AND a DISPLAY. The app container ships
    // xdotool but has NO X server when running the cf-proxy backend (the browser
    // and Xvfb live in the cf-proxy container), so every xdotool call fails with
    // "Can't open display: (null) / Failed creating new xdo instance". Only the
    // local/patchright backend runs Chrome on the app container's own Xvfb
    // (DISPLAY=:99). Gate on DISPLAY so we never spam those errors or waste time.
    if (!process.env.DISPLAY) {
      _xdotoolAvailable = false;
      logger.debug("No DISPLAY in this container — OS-level xdotool clicking disabled (expected on the cf-proxy backend)");
      return _xdotoolAvailable;
    }
    try {
      execSync("which xdotool", { stdio: "ignore" });
      _xdotoolAvailable = true;
      logger.info("xdotool detected — OS-level clicking enabled for Turnstile");
    } catch {
      _xdotoolAvailable = false;
      logger.debug("xdotool not found — falling back to CDP mouse events");
    }
  }
  return _xdotoolAvailable;
}

// ── Process-level GUI lock ───────────────────────────────────────────────────
// The "local"/patchright browser provider runs every concurrent task's Chromium
// on ONE shared Xvfb virtual display (:99), which means they all share a single
// mouse cursor and keyboard focus. xdotool moves that shared pointer and raises
// a window, so if two tasks physically click a Turnstile at the same time they
// fight over the cursor/focus and both clicks land in the wrong window. This is
// the TS-side counterpart to cf-proxy's `_gui_lock`: serialize every OS-level
// xdotool interaction so each task gets an uninterrupted turn at the display.
let _guiLockChain: Promise<void> = Promise.resolve();
function withGuiLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = _guiLockChain.then(() => fn());
  // Keep the chain alive regardless of whether `fn` resolves or rejects.
  _guiLockChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── Turnstile iframe expansion script ───────────────────────────────────────
// Ported from the JustRunMy.App reference project.
// Forcefully expands hidden/overflow:hidden containers around the Turnstile
// widget so that the checkbox is visible and clickable.

const EXPAND_TURNSTILE_JS = `
(function() {
  var ts = document.querySelector('input[name="cf-turnstile-response"]');
  if (!ts) {
    // Also try shadow DOM host containers
    var containers = document.querySelectorAll('.cf-turnstile, [data-sitekey]');
    if (containers.length === 0) return 'no-turnstile';
  }
  // Expand overflow:hidden ancestors
  var el = ts ? ts : containers[0];
  for (var i = 0; i < 20; i++) {
    el = el.parentElement;
    if (!el) break;
    var s = window.getComputedStyle(el);
    if (s.overflow === 'hidden' || s.overflowX === 'hidden' || s.overflowY === 'hidden')
      el.style.overflow = 'visible';
    // NOTE: do NOT set minWidth:'max-content' on ancestors. It forces
    // long-text containers (e.g. the "Renew your Free plan" modal) to stop
    // wrapping and stretch to the full viewport width, distorting the dialog.
    // Relaxing overflow is enough to un-clip the widget; iframe sizing is
    // handled explicitly below.
  }
  // Make Turnstile iframes visible and properly sized
  document.querySelectorAll('iframe').forEach(function(f){
    if (f.src && (f.src.includes('challenges.cloudflare.com') || f.src.includes('turnstile'))) {
      f.style.width = '300px'; f.style.height = '65px';
      f.style.minWidth = '300px';
      f.style.visibility = 'visible'; f.style.opacity = '1';
      f.style.position = 'relative'; f.style.zIndex = '999999';
    }
  });
  return 'done';
})()
`;

// ── xdotool-based physical click ────────────────────────────────────────────
// Uses OS-level X11 events that are indistinguishable from real human input.
// CF's Turnstile cannot detect these as automation because they come from the
// window system, not from CDP's Input.dispatchMouseEvent.

function xdotoolActivateChrome(): string | null {
  const classNames = ["chrome", "chromium", "Chromium", "Chrome", "google-chrome"];
  for (const cls of classNames) {
    try {
      const result = execFileSync("xdotool", ["search", "--onlyvisible", "--class", cls], {
        timeout: 3000, encoding: "utf-8",
      }).trim();
      const wids = result.split("\n").filter(Boolean);
      if (wids.length > 0) {
        execFileSync("xdotool", ["windowactivate", "--sync", wids[0]], {
          timeout: 3000, stdio: "ignore",
        });
        return wids[0];
      }
    } catch { /* try next class name */ }
  }
  try {
    execFileSync("xdotool", ["getactivewindow", "windowactivate"], {
      timeout: 3000, stdio: "ignore",
    });
  } catch { /* ignore */ }
  return null;
}

/**
 * Get the actual window position via xdotool getwindowgeometry.
 * This is reliable in Xvfb unlike window.screenX/screenY which return 0.
 */
function xdotoolGetWindowGeometry(wid: string): { x: number; y: number } | null {
  try {
    const out = execFileSync("xdotool", ["getwindowgeometry", "--shell", wid], {
      timeout: 3000, encoding: "utf-8",
    });
    let x = 0, y = 0;
    for (const line of out.trim().split("\n")) {
      if (line.startsWith("X=")) x = parseInt(line.split("=")[1], 10);
      else if (line.startsWith("Y=")) y = parseInt(line.split("=")[1], 10);
    }
    return { x, y };
  } catch {
    return null;
  }
}

function xdotoolClick(x: number, y: number): void {
  xdotoolActivateChrome();
  try {
    execFileSync("xdotool", ["mousemove", "--sync", String(Math.round(x)), String(Math.round(y))], {
      timeout: 3000, stdio: "ignore",
    });
    execFileSync("xdotool", ["click", "1"], { timeout: 2000, stdio: "ignore" });
    logger.info({ x: Math.round(x), y: Math.round(y) }, "xdotool physical click dispatched");
  } catch (err) {
    logger.debug({ err }, "xdotool click failed, falling back");
  }
}

/**
 * Attempt a physical OS-level click on the Turnstile checkbox.
 * Falls back to CDP click if xdotool is unavailable.
 */
async function physicalClickTurnstile(page: PageAdapter): Promise<boolean> {
  // Get Turnstile iframe coordinates via JS injection
  const coords = await page.evaluate(() => {
    // The Cloudflare Turnstile checkbox is a FIXED-size control (~24px) sitting
    // after ~13px of left padding, so its centre is ~30px from the widget's left
    // edge REGARDLESS of the widget's total width. A proportional offset
    // (width * 0.06 → 14-18px) lands in the padding to the LEFT of the checkbox
    // and misses it, which reads as "verification failed" / an unchecked box.
    // Use a fixed ~30px offset (clamped for unusually narrow widgets).
    const checkboxOffsetX = (r: DOMRect) => Math.round(Math.min(r.width - 8, 30));
    // First try iframes
    const iframes = document.querySelectorAll("iframe");
    for (let i = 0; i < iframes.length; i++) {
      const src = iframes[i].src || "";
      if (src.includes("cloudflare") || src.includes("turnstile") || src.includes("challenges")) {
        const r = iframes[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0)
          return { cx: Math.round(r.x + checkboxOffsetX(r)), cy: Math.round(r.y + r.height / 2) };
      }
    }
    // Fallback: container element
    const containers = Array.from(document.querySelectorAll<HTMLElement>(".cf-turnstile, [data-sitekey]"));
    for (const container of containers) {
      const r = container.getBoundingClientRect();
      if (r.width > 0 && r.height > 0)
        return { cx: Math.round(r.x + checkboxOffsetX(r)), cy: Math.round(r.y + r.height / 2) };
    }
    return null;
  }) as { cx: number; cy: number } | null;

  if (!coords) {
    logger.debug("Could not locate Turnstile coordinates for physical click");
    return false;
  }

  if (isXdotoolAvailable()) {
    // Serialize the whole activate→geometry→click sequence on the shared
    // Xvfb :99 pointer/focus so concurrent tasks don't fight over the cursor.
    return withGuiLock(async () => {
      // Get browser window position to compute absolute screen coordinates
      // Prefer xdotool getwindowgeometry (accurate in Xvfb) over window.screenX/Y
      const wid = xdotoolActivateChrome();
      let winX = 0, winY = 0;
      if (wid) {
        const geo = xdotoolGetWindowGeometry(wid);
        if (geo) {
          winX = geo.x;
          winY = geo.y;
        }
      }

      const winInfo = await page.evaluate(() => ({
        sx: (window as any).screenX || 0,
        sy: (window as any).screenY || 0,
        oh: window.outerHeight,
        ih: window.innerHeight,
      })) as { sx: number; sy: number; oh: number; ih: number };

      // Use xdotool geometry if available, fall back to JS values
      if (winX === 0 && winY === 0) {
        winX = winInfo.sx;
        winY = winInfo.sy;
      }
      const titleBarHeight = Math.max(0, winInfo.oh - winInfo.ih);
      const absX = coords.cx + winX;
      const absY = coords.cy + winY + titleBarHeight;

      logger.info({ absX, absY, coords, winX, winY, titleBarHeight }, "Attempting xdotool physical click on Turnstile");
      xdotoolClick(absX, absY);
      await sleep(600);
      return await isTurnstileSolved(page);
    });
  }

  // Fallback: CDP click (less effective but better than nothing)
  logger.debug({ coords }, "Falling back to CDP mouse click on Turnstile");
  await page.mouse.move(coords.cx, coords.cy);
  await sleep(150 + Math.random() * 200);
  await page.mouse.click(coords.cx, coords.cy);
  await sleep(600);
  return await isTurnstileSolved(page);
}

/** DOM selectors that indicate an active CF challenge overlay */
const CF_CHALLENGE_SELECTORS = [
  "#challenge-running",
  "#cf-challenge-running",
  ".cf-browser-verification",
  "#challenge-overlay",
  "#cf-wrapper #challenge-body",
];

/** Partial URL strings that identify CF Turnstile iframes */
const CF_FRAME_PATTERNS = ["challenges.cloudflare.com", "cf-turnstile"];

// ── Detection ─────────────────────────────────────────────────────────────────

async function detectCfChallenge(page: PageAdapter): Promise<CfChallengeType> {
  let isCfPage = false;

  // Pre-fetch frames for SeleniumBase adapter (frames() is sync but needs async HTTP)
  if ("fetchFrames" in page && typeof (page as any).fetchFrames === "function") {
    await (page as any).fetchFrames();
  }

  // ── WAF block detection — "Sorry, you have been blocked" ──────────────
  // CF WAF blocks show a different page from challenges. These cannot be
  // bypassed by any browser technique — the IP/fingerprint is blocked at
  // the WAF level. Detect early to avoid wasting time on bypass attempts.
  try {
    const isBlocked = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? "";
      const title = document.title ?? "";
      return (
        bodyText.includes("you have been blocked") ||
        bodyText.includes("You are unable to access") ||
        title.includes("Attention Required") ||
        (bodyText.includes("Cloudflare") && bodyText.includes("blocked"))
      );
    }) as boolean;
    if (isBlocked) {
      logger.warn("Cloudflare WAF block detected — IP/fingerprint is blocked");
      return "waf_blocked";
    }
  } catch {
    // ignore
  }

  // ── Structural detection (language-independent) ──────────────────────────
  // MUST come before the title/selector checks: the title test only knows the
  // ENGLISH strings, but Cloudflare localises the interstitial ("请稍候…" for a
  // zh client), and the modern challenge page carries none of the legacy
  // #challenge-running / .cf-browser-verification markup — its ids are random
  // (cf-chl-widget-kjlr4_response). So on a localised modern challenge we detected
  // nothing, returned "none", never clicked the checkbox, and the caller then failed
  // looking for login elements that were still behind the interstitial.
  //
  // These markers are stable across languages and widget ids:
  //   input[id^="cf-chl-widget-"][id$="_response"]  — the modern challenge's field
  //   [name="cf-turnstile-response"]                — Turnstile's response field
  //   script[src*="challenges.cloudflare.com"]      — the challenge script
  //
  // It must also be FALSE for a real page that merely EMBEDS a Turnstile. A login form
  // with a Turnstile loads challenges.cloudflare.com and has a cf-chl-widget-*_response
  // input too, so those markers alone cannot tell "the gate is up" from "we're through
  // and the form has its own widget" — and treating the login page as an interstitial
  // makes the bypass loop retry/reload it until the budget runs out, then report that
  // Cloudflare was never cleared. The site's own content is the discriminator: an
  // interstitial renders only the challenge, never the app's form/nav.
  try {
    isCfPage = (await page.evaluate(() => {
      // 1) A RENDERED, VISIBLE Turnstile widget must ALWAYS be handled — clicked —
      //    even on a normal page that has a login form. That's exactly where embedded
      //    widgets live (wispbyte's login, bot-hosting/host2play's renew modal). The
      //    response input's PARENT is the visible widget box. Suppressing this whenever
      //    a form was present is what stopped those checkboxes from being clicked.
      const resp = document.querySelector(
        'input[id^="cf-chl-widget-"][id$="_response"], input[name="cf-turnstile-response"]',
      );
      const box = (resp && resp.parentElement) || document.querySelector(".cf-turnstile");
      if (box) {
        const r = box.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true; // a real, clickable widget is on screen
      }
      // 2) Otherwise it can only be a FULL-PAGE interstitial — and that renders ONLY the
      //    challenge, never the app's own form. So a page with a login form and no
      //    visible widget is not a challenge (this is what stops a login page being
      //    mistaken for an interstitial and looped/reloaded to death).
      const siteContent = document.querySelector(
        "input[type='password'], input[name='email'], input[name='username']",
      );
      if (siteContent) return false;
      return !!document.querySelector(
        'input[id^="cf-chl-widget-"][id$="_response"], [name="cf-turnstile-response"], ' +
          'script[src*="challenges.cloudflare.com"], [id^="cf-chl-widget"]',
      );
    })) as boolean;
  } catch {
    // page may have been closed
  }

  // Title-based detection (English interstitials)
  if (!isCfPage) {
    try {
      const title = await page.title();
      isCfPage =
        title === "Just a moment..." ||
        title === "Attention Required! | Cloudflare" ||
        title.includes("DDoS protection by Cloudflare");
    } catch {
      // page may have been closed
    }
  }

  // DOM selector-based detection
  if (!isCfPage) {
    for (const sel of CF_CHALLENGE_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el
            .evaluate((e: Element) => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            })
            .catch(() => false);
          if (visible) {
            isCfPage = true;
            break;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  if (!isCfPage) return "none";

  // A RENDERED, VISIBLE Turnstile widget ALWAYS has a checkbox to CLICK, so it must
  // route to the click handler directly — never through the iframe-gated resolution
  // below. The modern Turnstile widget carries NO challenges.cloudflare.com <iframe>
  // (its response input sits in the light DOM), so the frame check misses it and falls
  // through to "js_challenge", whose branch only WAITS and never clicks. That is the
  // exact regression that stopped embedded (wispbyte login), popup (bot-hosting renew)
  // AND modern full-page checkboxes from ever being clicked: detection said "challenge"
  // but the type said "just wait". Two days ago these widgets returned "none" and were
  // clicked by detectAndHandleCaptcha's token path; once they became detected here they
  // needed to be classified as clickable, not as a self-verifying JS challenge.
  try {
    const hasVisibleWidget = (await page.evaluate(() => {
      const resp = document.querySelector(
        'input[id^="cf-chl-widget-"][id$="_response"], input[name="cf-turnstile-response"]',
      );
      const box = (resp && resp.parentElement) || document.querySelector(".cf-turnstile");
      if (!box) return false;
      const r = box.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })) as boolean;
    if (hasVisibleWidget) return "turnstile_click";
  } catch {
    // fall through to the frame-based resolution below
  }

  // Distinguish JS-only challenge vs interactive Turnstile checkbox.
  //
  // NOTE: Turnstile renders its iframe inside a **closed shadow DOM**, which
  // means `document.querySelectorAll("iframe")` cannot find it. We check both
  // the DOM and Playwright's frames() API (which sees through shadow DOM).
  try {
    // Method 1: Playwright frames API (works with closed shadow DOM)
    let hasTurnstileFrame = false;
    try {
      hasTurnstileFrame = page.frames().some(
        (f: { url(): string }) => CF_FRAME_PATTERNS.some((p) => f.url().includes(p)),
      );
    } catch {
      // frames() may not be available in all adapters
    }

    // Method 2: DOM query fallback
    if (!hasTurnstileFrame) {
      hasTurnstileFrame = await page.evaluate((patterns: unknown) => {
        return Array.from(document.querySelectorAll("iframe")).some((f) =>
          (patterns as string[]).some((p) => (f.src ?? "").includes(p)),
        );
      }, CF_FRAME_PATTERNS as never) as boolean;
    }

    return hasTurnstileFrame ? "turnstile_click" : "js_challenge";
  } catch {
    return "js_challenge";
  }
}

// ── Turnstile solved state check ────────────────────────────────────────────
// Ported from reference project's _SOLVED_JS.
// Checks if the Turnstile hidden input already has a valid token.

async function isTurnstileSolved(page: PageAdapter): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      // Embedded widgets use name="cf-turnstile-response"; the modern full-page
      // interstitial instead fills input#cf-chl-widget-<random>_response. Checking
      // only the former meant a passed full-page challenge never looked solved.
      const els = document.querySelectorAll<HTMLInputElement>(
        'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], ' +
          'input[id^="cf-chl-widget-"][id$="_response"]',
      );
      for (const el of Array.from(els)) {
        if (el.value && el.value.length > 20) return true;
      }
      return false;
    }) as boolean;
  } catch {
    return false;
  }
}

// ── Human behaviour simulation ───────────────────────────────────────────────

/**
 * Interpolate points along a quadratic Bézier curve.
 * Adds a random control point to make the path look organic.
 */
function bezierPath(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  steps: number,
): Array<{ x: number; y: number }> {
  const cx = x0 + (x1 - x0) * 0.3 + (Math.random() - 0.5) * 120;
  const cy = y0 + (y1 - y0) * 0.7 + (Math.random() - 0.5) * 120;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const mt = 1 - t;
    return {
      x: Math.round(mt * mt * x0 + 2 * mt * t * cx + t * t * x1),
      y: Math.round(mt * mt * y0 + 2 * mt * t * cy + t * t * y1),
    };
  });
}

const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min) + min);

/**
 * Simulate human-like mouse movement across the viewport.
 * Generates 4–8 bezier-curve paths with randomised speed.
 * This triggers mouse-event listeners that CF's JS challenge observes.
 */
export async function simulateHumanMouseMovement(page: PageAdapter): Promise<void> {
  const vp = page.viewport() ?? { width: 1280, height: 800 };

  // ── cf-proxy fast path ────────────────────────────────────────────────────
  // On the SeleniumBase/cf-proxy backend EVERY mouse.move is a separate HTTP
  // round-trip to the sidecar, so a full bezier sweep (4-9 curves × 12-25 steps
  // = 100-200 moves) takes MINUTES and floods the logs — that is the main reason
  // a failing Turnstile login "takes forever". cf-proxy's native
  // uc_gui_click_captcha already produces human-like OS input, so here we just do
  // a couple of cheap moves for a liveness signal instead of a full sweep.
  if ("clickTurnstile" in page && typeof (page as unknown as { clickTurnstile?: unknown }).clickTurnstile === "function") {
    try {
      await page.mouse.move(rand(vp.width * 0.3, vp.width * 0.6), rand(vp.height * 0.3, vp.height * 0.6));
      await sleep(rand(80, 160));
      await page.mouse.move(rand(vp.width * 0.4, vp.width * 0.7), rand(vp.height * 0.4, vp.height * 0.7));
    } catch { /* non-critical */ }
    return;
  }

  let x = rand(vp.width * 0.1, vp.width * 0.9);
  let y = rand(vp.height * 0.1, vp.height * 0.9);
  await page.mouse.move(x, y).catch(() => {});
  await sleep(rand(150, 300));

  const moves = rand(4, 9);
  for (let i = 0; i < moves; i++) {
    const tx = rand(vp.width * 0.1, vp.width * 0.9);
    const ty = rand(vp.height * 0.1, vp.height * 0.9);
    const steps = rand(12, 25);
    const pts = bezierPath(x, y, tx, ty, steps);
    for (const pt of pts) {
      await page.mouse.move(pt.x, pt.y).catch(() => {});
      await sleep(rand(8, 25));
    }
    x = tx;
    y = ty;
    await sleep(rand(80, 350));
  }
}

/**
 * Simulate random page scrolling — CF and similar systems track scroll events
 * as a strong "human" signal.
 */
async function simulateHumanScroll(page: PageAdapter): Promise<void> {
  const scrollCount = rand(2, 5);
  for (let i = 0; i < scrollCount; i++) {
    const deltaY = rand(50, 300) * (Math.random() > 0.3 ? 1 : -1);
    await page.evaluate((dy: unknown) => {
      window.scrollBy({ top: dy as number, behavior: "smooth" });
    }, deltaY as never).catch(() => {});
    await sleep(rand(200, 600));
  }
}

/**
 * Simulate random keyboard events — pressing Tab, Arrow keys, etc.
 * These are cheap but CF's challenge JS observes keyboard activity.
 */
async function simulateHumanKeyboard(page: PageAdapter): Promise<void> {
  const keys = ["Tab", "ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"];
  const count = rand(1, 4);
  for (let i = 0; i < count; i++) {
    const key = keys[rand(0, keys.length)];
    await page.keyboard.press(key).catch(() => {});
    await sleep(rand(100, 400));
  }
}

/**
 * Combined human presence simulation — mouse + scroll + keyboard.
 * Presents a much more realistic interaction pattern than mouse-only.
 */
async function simulateHumanPresence(page: PageAdapter): Promise<void> {
  await simulateHumanMouseMovement(page);
  // 70% chance to also scroll
  if (Math.random() < 0.7) await simulateHumanScroll(page);
  // 50% chance to also use keyboard
  if (Math.random() < 0.5) await simulateHumanKeyboard(page);
}

// ── Turnstile checkbox click ──────────────────────────────────────────────────

/**
 * Locate the Cloudflare Turnstile iframe and click the "I am human" checkbox inside it.
 * Returns true if a click was successfully delivered.
 *
 * Strategy order:
 *   1. Expand hidden Turnstile iframes (port from JustRunMy.App reference)
 *   2. Physical OS-level click via xdotool (if available) — undetectable by CF
 *   3. CDP widget bounding box click (fallback)
 *   4. Cross-origin iframe element click (last resort)
 */
export async function clickTurnstileCheckbox(page: PageAdapter): Promise<boolean> {
  try {
    // ── SeleniumBase shortcut: use cf-proxy's native Turnstile clicker ──
    // cf-proxy has access to uc_gui_click_captcha (PyAutoGUI) and xdotool,
    // which produce OS-level events undetectable by CF.
    if ("clickTurnstile" in page && typeof (page as any).clickTurnstile === "function") {
      logger.info("Using cf-proxy native Turnstile click (uc_gui_click_captcha + xdotool)");
      const solved = await (page as any).clickTurnstile(2);
      logger.info({ solved }, "cf-proxy native Turnstile click finished");
      // Do NOT fall through to the Node xdotool/CDP strategies below on the
      // cf-proxy backend: the browser + X display live in the cf-proxy container,
      // so THIS app container's xdotool has no DISPLAY ("Can't open display") and
      // CDP coordinate clicks miss (the generic /mouse/click adds no window/
      // title-bar offset). Native is the only correct path here — returning its
      // result avoids ~minutes of doomed retries spamming xdo errors.
      return solved;
    }
    // ── Step 0: Expand hidden Turnstile containers ──────────────────────
    // Many sites hide the Turnstile iframe inside overflow:hidden containers.
    // Without expansion, the iframe may have zero dimensions and be unclickable.
    try {
      await page.evaluate(EXPAND_TURNSTILE_JS as unknown as string);
      await sleep(300);
    } catch { /* non-critical */ }

    // ── Strategy 1: Physical OS-level click via xdotool ─────────────────
    // This produces genuine X11 input events that are indistinguishable from
    // real human mouse clicks. CF's Turnstile cannot detect these as automation.
    if (isXdotoolAvailable()) {
      const clicked = await physicalClickTurnstile(page);
      if (clicked) return true;
    }

    // ── Strategy 2: Click via the main-page widget/iframe bounding box ──
    // This works reliably even for cross-origin iframes where we cannot
    // access the frame's DOM. The Turnstile checkbox is typically at a
    // fixed offset from the widget's left edge (~26px).
    const widgetSelectors = [
      ".cf-turnstile",
      "[data-sitekey]",
      "iframe[src*='turnstile']",
      "iframe[src*='challenges.cloudflare.com']",
    ];
    for (const wSel of widgetSelectors) {
      const widget = await page.$(wSel);
      if (!widget) continue;
      const wBox = await widget.boundingBox();
      if (!wBox || wBox.width === 0 || wBox.height === 0) continue;

      // Fixed ~30px offset lands on the checkbox itself (see checkboxOffsetX note
      // in physicalClickTurnstile) — a proportional offset misses it to the left.
      const clickX = wBox.x + Math.min(wBox.width - 8, 30) + (Math.random() * 4 - 2);
      const clickY = wBox.y + wBox.height / 2 + (Math.random() * 4 - 2);
      await page.mouse.move(clickX, clickY);
      await sleep(150 + Math.random() * 200);
      await page.mouse.click(clickX, clickY);
      await sleep(500);
      if (await isTurnstileSolved(page)) {
        logger.info({ selector: wSel, x: clickX, y: clickY }, "Clicked Turnstile via widget coords");
        return true;
      }
    }

    // ── Strategy 3: Cross-origin iframe element click (when available) ──
    // NOTE: Turnstile uses closed shadow DOM, so DOM-based iframe queries fail.
    // The Playwright frames() API sees through shadow DOM boundaries.
    const cfFrame = page
      .frames()
      .find((f: { url(): string }) => CF_FRAME_PATTERNS.some((p) => f.url().includes(p)));

    if (!cfFrame) {
      logger.debug("Turnstile iframe not found in frame list");
      return false;
    }

    // Try explicit checkbox selector first
    const checkbox = await cfFrame.$(
      "input[type='checkbox'], .cf-checkbox-label, #challenge-stage input, .mark",
    );
    if (checkbox) {
      const box = await checkbox.boundingBox();
      if (box) {
        const clickX = box.x + Math.max(6, Math.min(16, box.width * 0.3));
        const clickY = box.y + box.height / 2;
        await page.mouse.move(clickX, clickY);
        await sleep(200 + Math.random() * 200);
        await page.mouse.click(clickX, clickY);
        await sleep(500);
        if (await isTurnstileSolved(page)) {
          logger.info("Clicked Turnstile checkbox via iframe element");
          return true;
        }
      }
    }

    // Fallback: click the centre of the iframe body
    const body = await cfFrame.$("body");
    if (body) {
      const box = await body.boundingBox();
      if (box) {
        // Checkbox sits ~30px from the iframe's left edge (fixed control), not
        // proportional to the iframe width.
        const cx = box.x + Math.min(box.width - 8, 30);
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await sleep(150);
        await page.mouse.click(cx, cy);
        await sleep(500);
        if (await isTurnstileSolved(page)) {
          logger.info("Clicked CF iframe body (fallback)");
          return true;
        }
      }
    }

    return false;
  } catch (err) {
    logger.debug({ err }, "Turnstile click failed");
    return false;
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Attempt to bypass an active Cloudflare challenge page.
 *
 * Returns:
 *   "passed"        — challenge cleared, page is now usable
 *   "failed"        — challenge not cleared after all attempts
 *   "not_detected"  — no CF challenge was found on the page
 */
export async function bypassCloudflareChallenge(
  page: PageAdapter,
  opts?: { deadline?: number },
): Promise<"passed" | "failed" | "blocked" | "not_detected"> {
  const challengeType = await detectCfChallenge(page);
  if (challengeType === "none") return "not_detected";
  if (challengeType === "waf_blocked") return "blocked";

  logger.info({ challengeType }, "Cloudflare challenge detected — attempting bypass");

  // Inject CF-specific environment patches before interacting.
  // These make the browser look more like a real user session to CF's JS probes.
  await injectCfEnvironmentPatches(page);

  // Expand any hidden Turnstile iframes upfront
  try { await page.evaluate(EXPAND_TURNSTILE_JS as unknown as string); } catch { /* ignore */ }

  // Quick check: Turnstile may have already been solved silently
  const alreadySolved = await isTurnstileSolved(page);
  if (alreadySolved) {
    logger.info("Turnstile already solved silently (token present)");
    return "passed";
  }

  if (challengeType === "js_challenge") {
    // A non-interactive / "managed" challenge VERIFIES ITSELF — the spinner
    // ("Vérification…" / "en cours") runs and issues the token when it's satisfied.
    // The right thing is to WAIT for it, uninterrupted, not to reload: a reload
    // restarts the spinner, so it never finishes (that's what made these fail while
    // the screenshot still showed it verifying). So poll to the deadline instead of a
    // fixed attempt count. detectCfChallenge returns "none" the instant the real page
    // renders, so a page that clears exits immediately; we only wait the full budget
    // when it genuinely never resolves.
    const jsDeadline = opts?.deadline ?? Date.now() + 120_000;
    let attempt = 0;
    while (Date.now() < jsDeadline) {
      attempt++;
      try { await page.evaluate(EXPAND_TURNSTILE_JS as unknown as string); } catch { /* ignore */ }
      await simulateHumanPresence(page);
      await sleep(attempt === 1 ? 4_000 + Math.random() * 2_000 : 3_000 + Math.random() * 1_500);

      const still = await detectCfChallenge(page);
      if (still === "none") {
        logger.info({ attempt }, "Cloudflare JS challenge verified/cleared");
        return "passed";
      }
      if (await isTurnstileSolved(page)) {
        logger.info({ attempt }, "Turnstile token populated while waiting");
        return "passed";
      }
      // If it upgraded to an interactive checkbox, click it.
      if (still === "turnstile_click") {
        logger.info({ attempt }, "JS challenge upgraded to Turnstile click — attempting click");
        await simulateHumanPresence(page);
        await sleep(500 + Math.random() * 500);
        await clickTurnstileCheckbox(page);
        await sleep(3_000 + Math.random() * 2_000);
        if (await isTurnstileSolved(page) || (await detectCfChallenge(page)) === "none") {
          logger.info({ attempt }, "Cloudflare challenge bypassed after click");
          return "passed";
        }
      }
      logger.debug({ attempt }, "CF JS challenge still verifying, waiting");
    }
    logger.warn({ attempt }, "Cloudflare JS challenge did not clear before the deadline");
    return "failed";
  }

  if (challengeType === "turnstile_click") {
    // Do NOT re-run the whole solve many times. The cf-proxy native clicker already
    // retries thoroughly WITHIN a single call (several spaced uc_gui image clicks, then
    // CDP, then coordinate fallbacks — ~2 min of work). Repeating that from out here does
    // not help: a Turnstile that didn't pass on a clean click needs a FRESH page, not more
    // clicks on the same widget. Hammering it (this loop used to run 8×) just mashes the
    // checkbox into CF's "Verification failed" — which both EXPOSES the automation and
    // dragged a failing login out to ~20 min (8 × a ~2 min native solve). So: one pass on
    // cf-proxy; a few on the local backend, whose per-call click is a single cheap
    // xdotool/CDP click rather than a full internal retry sweep.
    const isCfProxyClicker =
      "clickTurnstile" in page &&
      typeof (page as unknown as { clickTurnstile?: unknown }).clickTurnstile === "function";
    const maxAttempts = isCfProxyClicker ? 1 : 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Expand hidden Turnstile containers before each attempt
      try { await page.evaluate(EXPAND_TURNSTILE_JS as unknown as string); } catch { /* ignore */ }
      // Full human presence simulation before clicking
      await simulateHumanPresence(page);
      await sleep(800 + Math.random() * 1200);

      const clicked = await clickTurnstileCheckbox(page);
      if (!clicked) {
        logger.warn({ attempt }, "Could not locate Turnstile checkbox, waiting for it to appear");
        await sleep(2_000 + Math.random() * 1_000);
        continue;
      }

      // A TOKEN is the real success signal for an EMBEDDED widget: unlike a full-page
      // interstitial it does not redirect or disappear when passed (it just ticks), so
      // waiting for the challenge to "go away" never succeeds and the loop failed after
      // 8 clicks despite the checkbox being passed.
      if (await isTurnstileSolved(page)) {
        logger.info({ attempt }, "Turnstile solved (token present)");
        return "passed";
      }

      // Wait for page navigation or challenge to clear — use domcontentloaded
      // instead of networkidle2 to avoid premature timeouts on CF pages
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => {});
      await sleep(2_000 + Math.random() * 1_500);

      if (await isTurnstileSolved(page)) {
        logger.info({ attempt }, "Turnstile solved (token present after settle)");
        return "passed";
      }
      const still = await detectCfChallenge(page);
      if (still === "none") {
        logger.info({ attempt }, "Cloudflare Turnstile click challenge bypassed");
        return "passed";
      }

      // Challenge still active — simulate more complex human activity before retrying
      logger.debug({ attempt }, "Turnstile still active after click, simulating more activity");
      await simulateHumanPresence(page);
      await sleep(2_000 + Math.random() * 2_000);

      // Re-check — sometimes it clears with a delay
      const recheck = await detectCfChallenge(page);
      if (recheck === "none") {
        logger.info({ attempt }, "Cloudflare Turnstile cleared after additional wait");
        return "passed";
      }
    }
    logger.warn({ maxAttempts }, "Cloudflare Turnstile click challenge not bypassed");
    return "failed";
  }

  return "failed";
}

/**
 * Ensure a full-page Cloudflare interstitial ("Just a moment…" / managed /
 * non-interactive challenge) is cleared *before* the caller tries to interact
 * with the real page (find a login form, click a button, etc.).
 *
 * This mirrors the cf-proxy (SeleniumBase UC) login flow, where every
 * navigation goes through `uc_open_with_reconnect()` so Cloudflare sees a
 * clean browser during the challenge window. For the Playwright / Puppeteer /
 * local backends we cannot disconnect CDP, so instead we:
 *
 *   1. Run the standard bypass (human presence + Turnstile checkbox click).
 *   2. If it does not clear, **reload the page** and retry — a fresh navigation
 *      is the closest analogue to uc_open_with_reconnect and frequently lets a
 *      stalled non-interactive / managed challenge finish.
 *
 * Returns:
 *   true  — no CF interstitial present, or it was cleared.
 *   false — a challenge is still blocking the page (WAF block or unsolved).
 *
 * IMPORTANT: this is safe to call on any page. If there is no CF challenge it
 * returns immediately, so callers can invoke it unconditionally after a goto.
 */
export async function clearCloudflareInterstitial(
  page: PageAdapter,
  opts?: { url?: string; maxReloads?: number; budgetMs?: number },
): Promise<boolean> {
  const maxReloads = opts?.maxReloads ?? 2;
  // Wall-clock budget for the WHOLE clear. 180s: a non-interactive challenge can take
  // a while to self-verify (slow site / proxy / WARP), and cutting it off at 90s while
  // the spinner was still going is exactly what made these fail. The old 10-minute
  // hangs came from a login page being MISread as a challenge and looping forever —
  // that root cause is fixed (a page with a real form is no longer "a challenge"), so
  // a generous budget no longer risks a long hang. Tunable via CF_CLEAR_BUDGET_MS.
  const budgetMs = opts?.budgetMs ?? Number(process.env.CF_CLEAR_BUDGET_MS ?? 180_000);
  const deadline = Date.now() + budgetMs;

  // This function clears FULL-PAGE interstitials — the ones that block the page and
  // redirect when passed. An embedded Turnstile that sits inside a login form is NOT
  // one of those: it never redirects (it just ticks + issues a token), so trying to
  // "clear" it here loops to the budget and reports failure, and the form never gets
  // filled. If the page already shows its login form, there is no interstitial to
  // pre-clear — leave the embedded widget to the before-submit captcha handling.
  const hasLoginForm = (await page
    .evaluate(() =>
      !!document.querySelector("input[type='password'], input[name='email'], input[name='username']"),
    )
    .catch(() => false)) as boolean;
  if (hasLoginForm) {
    logger.info("Login form already present — no full-page interstitial to clear (embedded widget handled before submit)");
    return true;
  }

  for (let round = 0; round <= maxReloads; round++) {
    if (Date.now() > deadline) {
      logger.warn({ round, budgetMs }, "Cloudflare interstitial clear exceeded its time budget — aborting");
      return false;
    }
    const result = await bypassCloudflareChallenge(page, { deadline });
    if (result === "not_detected" || result === "passed") {
      if (round > 0) logger.info({ round }, "Cloudflare interstitial cleared after reload");
      return true;
    }
    if (result === "blocked") {
      logger.warn("Cloudflare WAF block — cannot clear interstitial by browser bypass");
      return false;
    }

    // result === "failed" — reload and retry (analogue of uc_open_with_reconnect).
    // But NOT if a non-interactive challenge is still verifying: reloading restarts
    // its spinner from scratch and it never gets to finish. bypassCloudflareChallenge
    // already waited to the deadline for that case, so if we're still on a js_challenge
    // the reload wouldn't help — only an interactive/stuck one benefits from a fresh
    // navigation.
    const stillType = await detectCfChallenge(page).catch(() => "js_challenge" as const);
    if (stillType === "js_challenge") {
      logger.warn("CF non-interactive challenge still verifying at deadline — a reload would only restart it");
      return false;
    }
    if (round < maxReloads) {
      const reloadUrl = opts?.url || page.url();
      logger.info({ round, reloadUrl }, "CF interstitial not cleared — reloading page and retrying");
      try {
        await page.goto(reloadUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch {
        // Navigation may be interrupted by the challenge redirect — ignore.
      }
      // Give CF's JS a moment to spin up before the next bypass round.
      await sleep(2_500 + Math.random() * 1_500);
    }
  }

  // Final status check — the challenge may have cleared during the last wait.
  const finalType = await bypassCloudflareChallenge(page, { deadline });
  return finalType === "not_detected" || finalType === "passed";
}

// ── CF environment patches ───────────────────────────────────────────────────

/**
 * Inject runtime patches that specifically target CF's JS challenge probes.
 * These are separate from the general stealth script because they should
 * only run when a CF challenge is actually detected.
 */
async function injectCfEnvironmentPatches(page: PageAdapter): Promise<void> {
  try {
    await page.evaluate((() => {
      // CF checks window.navigator.connection — simulate a typical broadband connection
      // @ts-ignore
      if (!navigator.connection) {
        Object.defineProperty(navigator, "connection", {
          get: () => ({
            effectiveType: "4g",
            rtt: 50,
            downlink: 10,
            saveData: false,
          }),
        });
      }
      // CF may probe Notification.permission
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          Object.defineProperty(Notification, "permission", { get: () => "default", configurable: true });
        }
      } catch {}
      // Inject realistic performance timing entries
      try {
        if (performance.getEntriesByType("navigation").length === 0) {
          // Can't add entries, but ensure performance.now() has realistic offset
          const origNow = performance.now.bind(performance);
          const offset = Math.random() * 100;
          performance.now = () => origNow() + offset;
        }
      } catch {}
    }) as unknown as string).catch(() => {});
  } catch {
    // Non-critical — continue with bypass
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
