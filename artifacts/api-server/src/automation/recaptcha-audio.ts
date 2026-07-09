/**
 * recaptcha-audio.ts — solve a Google reCAPTCHA v2 checkbox challenge by driving
 * its AUDIO challenge (download mp3 → speech-to-text → type answer), the same
 * technique the oyz8/Host2Play reference project uses for host2play.gratis.
 *
 * Two execution paths, chosen automatically by backend:
 *   • cf-proxy (SeleniumBase): the adapter exposes a native solveRecaptchaAudio()
 *     that runs the whole flow in Python (Selenium frame switching + local
 *     faster-whisper). We simply delegate to it — Selenium's cross-origin frame
 *     handling and the local Whisper model both live in that container.
 *   • Playwright / local: we drive reCAPTCHA's cross-origin iframes through the
 *     PageAdapter's frames() API (Playwright can see through cross-origin
 *     boundaries), download the audio in Node, and transcribe via stt.ts.
 *
 * Returns true only when the reCAPTCHA token (g-recaptcha-response) is populated.
 *
 * NOTE on rate limiting: Google aggressively blocks the audio challenge from
 * datacenter IPs ("Your computer or network may be sending automated queries").
 * When that happens this returns { blocked: true } so the caller can surface a
 * clear message / rotate proxy — no STT engine can work around an IP block.
 */
import type { PageAdapter, FrameAdapter } from "./page-adapter";
import { logger } from "../lib/logger";
import { transcribeAudio } from "./stt";

export interface RecaptchaAudioResult {
  solved: boolean;
  blocked: boolean;
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Does the adapter expose the cf-proxy native solver? */
function hasNativeSolver(page: PageAdapter): page is PageAdapter & { solveRecaptchaAudio(): Promise<RecaptchaAudioResult> } {
  return (
    "solveRecaptchaAudio" in page &&
    typeof (page as unknown as { solveRecaptchaAudio?: unknown }).solveRecaptchaAudio === "function"
  );
}

/** Refresh the frame list (cf-proxy adapter needs an async prefetch). */
async function frames(page: PageAdapter): Promise<FrameAdapter[]> {
  if ("fetchFrames" in page && typeof (page as any).fetchFrames === "function") {
    await (page as any).fetchFrames();
  }
  return page.frames();
}

async function findFrame(page: PageAdapter, ...needles: string[]): Promise<FrameAdapter | null> {
  const fs = await frames(page);
  return fs.find((f) => needles.some((n) => f.url().includes(n))) ?? null;
}

/** True once the main page's reCAPTCHA response token is populated. */
async function tokenPresent(page: PageAdapter): Promise<boolean> {
  try {
    return (await page.evaluate(() => {
      const t = document.querySelector<HTMLTextAreaElement>(
        "textarea#g-recaptcha-response, textarea[name='g-recaptcha-response']",
      );
      return !!(t && t.value && t.value.length > 0);
    })) as boolean;
  } catch {
    return false;
  }
}

/** Detect the "automated queries" / "try again later" hard block inside bframe. */
async function isAudioBlocked(bframe: FrameAdapter): Promise<boolean> {
  const el = await bframe.$(".rc-doscaptcha-header-text, .rc-audiochallenge-error-message");
  if (!el) return false;
  try {
    const text = (await el.evaluate((e: Element) => e.textContent ?? "")) as string;
    return /try again later|automated queries|multiple correct/i.test(text);
  } catch {
    return false;
  }
}

// ── Playwright / local path ──────────────────────────────────────────────────

async function solveViaFrames(page: PageAdapter): Promise<RecaptchaAudioResult> {
  // 1. Click the anchor checkbox.
  const anchor = await findFrame(page, "api2/anchor", "recaptcha/api2/anchor", "enterprise/anchor");
  if (!anchor) return { solved: false, blocked: false, message: "reCAPTCHA anchor iframe not found" };

  const checkbox = await anchor.$("#recaptcha-anchor, .recaptcha-checkbox");
  if (checkbox) {
    await checkbox.click().catch(() => {});
    await sleep(1500);
  }
  // Sometimes the checkbox alone passes (no challenge popup).
  if (await tokenPresent(page)) {
    return { solved: true, blocked: false, message: "reCAPTCHA passed on checkbox (no challenge)" };
  }

  // 2. Switch the challenge (bframe) to audio mode.
  const bframe = await findFrame(page, "api2/bframe", "recaptcha/api2/bframe", "enterprise/bframe");
  if (!bframe) return { solved: false, blocked: false, message: "reCAPTCHA challenge iframe (bframe) not found" };

  const audioBtn = await bframe.$("#recaptcha-audio-button, button.rc-button-audio");
  if (audioBtn) {
    await audioBtn.click().catch(() => {});
    await sleep(1500);
  }

  // 3. Up to 4 audio rounds (each verify may present a fresh clip).
  for (let round = 1; round <= 4; round++) {
    const bf = (await findFrame(page, "api2/bframe", "recaptcha/api2/bframe", "enterprise/bframe")) ?? bframe;

    if (await isAudioBlocked(bf)) {
      return {
        solved: false,
        blocked: true,
        message:
          "reCAPTCHA blocked the audio challenge for this IP (automated-queries block). " +
          "Use a residential/mobile proxy or rotate the exit IP and retry.",
      };
    }

    // Resolve the audio clip URL.
    let audioUrl: string | null = null;
    const dl = await bf.$(".rc-audiochallenge-tdownload-link");
    if (dl) audioUrl = ((await dl.evaluate((e: Element) => (e as HTMLAnchorElement).href).catch(() => "")) as string) || null;
    if (!audioUrl) {
      const src = await bf.$("#audio-source, audio#audio-source, .rc-audiochallenge-tdownload audio source");
      if (src) audioUrl = ((await src.evaluate((e: Element) => (e as HTMLAudioElement | HTMLSourceElement).src).catch(() => "")) as string) || null;
    }
    if (!audioUrl) {
      logger.debug({ round }, "Could not read reCAPTCHA audio URL — waiting and retrying");
      await sleep(1500);
      continue;
    }

    // Download + transcribe.
    let audioBuf: Buffer | null = null;
    try {
      const res = await fetch(audioUrl);
      if (res.ok) audioBuf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      logger.debug({ err }, "reCAPTCHA audio download failed");
    }
    if (!audioBuf || audioBuf.length === 0) {
      await sleep(1000);
      continue;
    }

    const answer = await transcribeAudio(audioBuf);
    if (!answer) {
      return { solved: false, blocked: false, message: "Audio transcription failed (no STT engine returned text). Check RECAPTCHA_STT_ORDER / WIT_AI_TOKEN / cf-proxy /transcribe." };
    }

    // Type the answer and verify.
    const input = await bf.$("#audio-response, input.rc-audiochallenge-response-field");
    if (!input) {
      await sleep(1000);
      continue;
    }
    await input.click().catch(() => {});
    // Clear any prior value, then type via the page-level keyboard (the input is
    // focused after the click above).
    await input.evaluate((e: Element) => {
      (e as HTMLInputElement).value = "";
    }).catch(() => {});
    await page.keyboard.type(answer, { delay: 40 });
    await sleep(300);

    const verify = await bf.$("#recaptcha-verify-button, button.rc-audiochallenge-verify-button");
    if (verify) await verify.click().catch(() => {});
    await sleep(2500);

    if (await tokenPresent(page)) {
      return { solved: true, blocked: false, message: `reCAPTCHA solved via audio (round ${round})` };
    }
    logger.debug({ round, answer }, "reCAPTCHA audio answer not accepted — retrying with a fresh clip");
    await sleep(1200);
  }

  return { solved: false, blocked: false, message: "reCAPTCHA audio challenge not solved after 4 rounds" };
}

/**
 * Solve a reCAPTCHA v2 checkbox via its audio challenge. Backend-agnostic:
 * delegates to the cf-proxy native solver when available, else drives the
 * iframes through Playwright.
 */
export async function solveRecaptchaAudio(page: PageAdapter): Promise<RecaptchaAudioResult> {
  if (await tokenPresent(page)) {
    return { solved: true, blocked: false, message: "reCAPTCHA already solved (token present)" };
  }
  try {
    if (hasNativeSolver(page)) {
      logger.info("Solving reCAPTCHA via cf-proxy native audio solver (local whisper)");
      return await page.solveRecaptchaAudio();
    }
    logger.info("Solving reCAPTCHA via Playwright audio-challenge flow");
    return await solveViaFrames(page);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "reCAPTCHA audio solve threw");
    return { solved: false, blocked: false, message: `reCAPTCHA audio solve error: ${message}` };
  }
}
