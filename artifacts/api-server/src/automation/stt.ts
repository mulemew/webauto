/**
 * stt.ts — speech-to-text for the reCAPTCHA audio-challenge solver.
 *
 * Transcription is backend-agnostic: whichever browser backend drove the
 * challenge, the downloaded audio is handed here to be turned into text.
 *
 * Engine order (configurable via RECAPTCHA_STT_ORDER, comma-separated):
 *   1. "whisper" — POST the audio to cf-proxy's /transcribe endpoint, which runs
 *                  faster-whisper LOCALLY. Free, no API key, no per-IP rate limit
 *                  and no risk of a future paywall. Default primary.
 *   2. "witai"   — Facebook/Meta wit.ai /speech API. Free tier, needs a server
 *                  token (WIT_AI_TOKEN). Reliable and fast when configured.
 *   3. "google"  — SpeechRecognition-style free Google endpoint. No key, but it
 *                  is an unofficial demo endpoint Google can throttle/kill at any
 *                  time. Last-resort fallback.
 *
 * All engines receive the raw audio bytes (reCAPTCHA serves MP3). wit.ai and the
 * whisper sidecar accept MP3 directly; the Google endpoint needs 16 kHz mono
 * FLAC, which cf-proxy's /transcribe can also produce — so for "google" we route
 * through cf-proxy too when available and otherwise skip (documented below).
 */
import { logger } from "../lib/logger";

const DEFAULT_CF_PROXY_URL = process.env.CF_PROXY_URL ?? "http://cf-proxy:7317";

function engineOrder(): string[] {
  const raw = process.env.RECAPTCHA_STT_ORDER;
  if (raw && raw.trim()) {
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return ["whisper", "witai", "google"];
}

/** Normalise a raw transcript to the shape reCAPTCHA expects (lowercase words). */
function cleanTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── whisper (via cf-proxy local faster-whisper) ──────────────────────────────

async function transcribeViaWhisper(audio: Buffer): Promise<string | null> {
  const url = `${DEFAULT_CF_PROXY_URL.replace(/\/$/, "")}/transcribe`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        // Cast around the lib.dom `BodyInit` vs @types/node `Buffer<ArrayBufferLike>`
        // mismatch — Node's fetch accepts a Buffer body at runtime.
        body: audio as unknown as BodyInit,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string };
    if (!res.ok || data.error || typeof data.text !== "string") {
      logger.debug({ status: res.status, err: data.error }, "cf-proxy /transcribe returned no text");
      return null;
    }
    const cleaned = cleanTranscript(data.text);
    return cleaned || null;
  } catch (err) {
    logger.debug({ err }, "whisper (cf-proxy /transcribe) unavailable");
    return null;
  }
}

// ── wit.ai ───────────────────────────────────────────────────────────────────

async function transcribeViaWitAi(audio: Buffer): Promise<string | null> {
  const token = process.env.WIT_AI_TOKEN;
  if (!token) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch("https://api.wit.ai/speech?v=20230215", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          // reCAPTCHA serves MPEG audio; wit.ai decodes it server-side.
          "Content-Type": "audio/mpeg3",
        },
        // Cast around the lib.dom `BodyInit` vs @types/node `Buffer<ArrayBufferLike>`
        // mismatch — Node's fetch accepts a Buffer body at runtime.
        body: audio as unknown as BodyInit,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    // wit.ai streams multiple JSON objects; the final one carries the full text.
    const body = await res.text();
    if (!res.ok) {
      logger.debug({ status: res.status }, "wit.ai /speech error");
      return null;
    }
    // Grab the last "text" field in the (possibly chunked) response.
    const matches = [...body.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
    const last = matches.length ? matches[matches.length - 1][1] : "";
    const cleaned = cleanTranscript(last.replace(/\\"/g, '"'));
    return cleaned || null;
  } catch (err) {
    logger.debug({ err }, "wit.ai transcription failed");
    return null;
  }
}

// ── google (unofficial free endpoint, via cf-proxy FLAC conversion) ──────────

async function transcribeViaGoogle(audio: Buffer): Promise<string | null> {
  // The free Google speech endpoint needs 16 kHz mono FLAC. Rather than pull a
  // second audio toolchain into the Node container, ask cf-proxy to do the
  // conversion + recognition (it has ffmpeg + SpeechRecognition). If cf-proxy is
  // not reachable this simply returns null and the chain ends.
  const url = `${DEFAULT_CF_PROXY_URL.replace(/\/$/, "")}/transcribe?engine=google`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        // Cast around the lib.dom `BodyInit` vs @types/node `Buffer<ArrayBufferLike>`
        // mismatch — Node's fetch accepts a Buffer body at runtime.
        body: audio as unknown as BodyInit,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok || data.error || typeof data.text !== "string") return null;
    const cleaned = cleanTranscript(data.text);
    return cleaned || null;
  } catch (err) {
    logger.debug({ err }, "google STT (via cf-proxy) unavailable");
    return null;
  }
}

/**
 * Transcribe reCAPTCHA audio to text, trying each configured engine in order
 * until one returns a non-empty result. Returns null if every engine fails.
 */
export async function transcribeAudio(audio: Buffer): Promise<string | null> {
  for (const engine of engineOrder()) {
    let text: string | null = null;
    if (engine === "whisper") text = await transcribeViaWhisper(audio);
    else if (engine === "witai") text = await transcribeViaWitAi(audio);
    else if (engine === "google") text = await transcribeViaGoogle(audio);
    else {
      logger.warn({ engine }, "Unknown STT engine in RECAPTCHA_STT_ORDER — skipping");
      continue;
    }
    if (text) {
      logger.info({ engine, chars: text.length }, "reCAPTCHA audio transcribed");
      return text;
    }
    logger.debug({ engine }, "STT engine returned no text — trying next");
  }
  return null;
}
