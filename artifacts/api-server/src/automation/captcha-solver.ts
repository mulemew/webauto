import { logger } from "../lib/logger";

export type CaptchaTokenType = "reCAPTCHA" | "hCaptcha" | "Turnstile";

export interface TokenSolveParams {
  type: CaptchaTokenType;
  sitekey: string;
  pageUrl: string;
}

export interface CaptchaSolver {
  /** Human-readable provider name */
  readonly name: string;
  /**
   * Solve a token-based captcha (reCAPTCHA / hCaptcha / Turnstile).
   * Returns the solved token string, or null on failure.
   */
  solveToken(params: TokenSolveParams): Promise<string | null>;
  /**
   * Solve an image captcha from a base64-encoded PNG/JPEG.
   * Returns the plaintext answer, or null on failure.
   */
  solveImage(base64: string): Promise<string | null>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 2captcha ──────────────────────────────────────────────────────────────────

export class TwoCaptchaSolver implements CaptchaSolver {
  readonly name = "2captcha";
  private static readonly BASE = "https://2captcha.com";

  constructor(private readonly apiKey: string) {}

  async solveToken({ type, sitekey, pageUrl }: TokenSolveParams): Promise<string | null> {
    try {
      let method: string;
      let keyParam: string;
      if (type === "reCAPTCHA") {
        method = "userrecaptcha";
        keyParam = `&googlekey=${encodeURIComponent(sitekey)}`;
      } else if (type === "hCaptcha") {
        method = "hcaptcha";
        keyParam = `&sitekey=${encodeURIComponent(sitekey)}`;
      } else {
        method = "turnstile";
        keyParam = `&sitekey=${encodeURIComponent(sitekey)}`;
      }

      const submitUrl =
        `${TwoCaptchaSolver.BASE}/in.php?key=${this.apiKey}` +
        `&method=${method}${keyParam}` +
        `&pageurl=${encodeURIComponent(pageUrl)}&json=1`;

      const submitJson = await fetchJson<{ status: number; request: string }>(submitUrl);
      if (submitJson.status !== 1) {
        logger.warn({ response: submitJson.request }, "2captcha submission rejected");
        return null;
      }

      const id = submitJson.request;
      await sleep(20_000);
      return await this.pollResult(id);
    } catch (err) {
      logger.error({ err }, "2captcha solveToken error");
      return null;
    }
  }

  async solveImage(base64: string): Promise<string | null> {
    try {
      const submitUrl =
        `${TwoCaptchaSolver.BASE}/in.php?key=${this.apiKey}` +
        `&method=base64&body=${encodeURIComponent(base64)}&json=1`;
      const submitJson = await fetchJson<{ status: number; request: string }>(submitUrl);
      if (submitJson.status !== 1) return null;
      await sleep(5_000);
      return await this.pollResult(submitJson.request, 6, 3_000);
    } catch (err) {
      logger.error({ err }, "2captcha solveImage error");
      return null;
    }
  }

  private async pollResult(
    id: string,
    maxAttempts = 10,
    interval = 5_000
  ): Promise<string | null> {
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(interval);
      const pollJson = await fetchJson<{ status: number; request: string }>(
        `${TwoCaptchaSolver.BASE}/res.php?key=${this.apiKey}&action=get&id=${id}&json=1`
      );
      if (pollJson.status === 1) return pollJson.request;
      if (pollJson.request !== "CAPCHA_NOT_READY") {
        logger.warn({ response: pollJson.request }, "2captcha poll error");
        return null;
      }
    }
    logger.warn("2captcha: timed out waiting for solution");
    return null;
  }
}

// ── Capsolver ─────────────────────────────────────────────────────────────────

export class CapsolverSolver implements CaptchaSolver {
  readonly name = "capsolver";
  private static readonly BASE = "https://api.capsolver.com";

  constructor(private readonly apiKey: string) {}

  private taskType(type: CaptchaTokenType): string {
    if (type === "reCAPTCHA") return "ReCaptchaV2TaskProxyless";
    if (type === "hCaptcha") return "HCaptchaTaskProxyless";
    return "AntiTurnstileTaskProxyless";
  }

  async solveToken({ type, sitekey, pageUrl }: TokenSolveParams): Promise<string | null> {
    try {
      const createJson = await postJson<{ errorId: number; taskId?: string }>(
        `${CapsolverSolver.BASE}/createTask`,
        {
          clientKey: this.apiKey,
          task: { type: this.taskType(type), websiteURL: pageUrl, websiteKey: sitekey },
        }
      );
      if (createJson.errorId !== 0 || !createJson.taskId) {
        logger.warn({ createJson }, "Capsolver createTask failed");
        return null;
      }
      await sleep(5_000);
      return await this.pollResult(createJson.taskId);
    } catch (err) {
      logger.error({ err }, "Capsolver solveToken error");
      return null;
    }
  }

  async solveImage(base64: string): Promise<string | null> {
    try {
      const createJson = await postJson<{ errorId: number; taskId?: string }>(
        `${CapsolverSolver.BASE}/createTask`,
        { clientKey: this.apiKey, task: { type: "ImageToTextTask", body: base64 } }
      );
      if (createJson.errorId !== 0 || !createJson.taskId) return null;
      await sleep(3_000);
      return await this.pollResult(createJson.taskId, 6, 3_000);
    } catch (err) {
      logger.error({ err }, "Capsolver solveImage error");
      return null;
    }
  }

  private async pollResult(
    taskId: string,
    maxAttempts = 24,
    interval = 5_000
  ): Promise<string | null> {
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(interval);
      const pollJson = await postJson<{
        errorId: number;
        status: string;
        solution?: { token?: string; gRecaptchaResponse?: string; text?: string };
      }>(`${CapsolverSolver.BASE}/getTaskResult`, { clientKey: this.apiKey, taskId });

      if (pollJson.status === "ready") {
        return (
          pollJson.solution?.token ??
          pollJson.solution?.gRecaptchaResponse ??
          pollJson.solution?.text ??
          null
        );
      }
      if (pollJson.status !== "processing") {
        logger.warn({ pollJson }, "Capsolver task error");
        return null;
      }
    }
    logger.warn("Capsolver: timed out");
    return null;
  }
}

// ── Anti-Captcha ──────────────────────────────────────────────────────────────

export class AntiCaptchaSolver implements CaptchaSolver {
  readonly name = "anticaptcha";
  private static readonly BASE = "https://api.anti-captcha.com";

  constructor(private readonly apiKey: string) {}

  private taskType(type: CaptchaTokenType): string {
    if (type === "reCAPTCHA") return "NoCaptchaTaskProxyless";
    if (type === "hCaptcha") return "HCaptchaTaskProxyless";
    return "AntiTurnstileTaskProxyless";
  }

  async solveToken({ type, sitekey, pageUrl }: TokenSolveParams): Promise<string | null> {
    try {
      const createJson = await postJson<{ errorId: number; taskId?: number }>(
        `${AntiCaptchaSolver.BASE}/createTask`,
        {
          clientKey: this.apiKey,
          task: { type: this.taskType(type), websiteURL: pageUrl, websiteKey: sitekey },
        }
      );
      if (createJson.errorId !== 0 || !createJson.taskId) return null;
      await sleep(15_000);
      return await this.pollResult(createJson.taskId);
    } catch (err) {
      logger.error({ err }, "AntiCaptcha solveToken error");
      return null;
    }
  }

  async solveImage(base64: string): Promise<string | null> {
    try {
      const createJson = await postJson<{ errorId: number; taskId?: number }>(
        `${AntiCaptchaSolver.BASE}/createTask`,
        { clientKey: this.apiKey, task: { type: "ImageToTextTask", body: base64 } }
      );
      if (createJson.errorId !== 0 || !createJson.taskId) return null;
      await sleep(3_000);
      return await this.pollResult(createJson.taskId, 6, 3_000);
    } catch (err) {
      logger.error({ err }, "AntiCaptcha solveImage error");
      return null;
    }
  }

  private async pollResult(
    taskId: number,
    maxAttempts = 12,
    interval = 5_000
  ): Promise<string | null> {
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(interval);
      const pollJson = await postJson<{
        errorId: number;
        status: string;
        solution?: { gRecaptchaResponse?: string; token?: string; text?: string; answer?: string };
      }>(`${AntiCaptchaSolver.BASE}/getTaskResult`, { clientKey: this.apiKey, taskId });

      if (pollJson.status === "ready") {
        return (
          pollJson.solution?.gRecaptchaResponse ??
          pollJson.solution?.token ??
          pollJson.solution?.text ??
          pollJson.solution?.answer ??
          null
        );
      }
      if (pollJson.status !== "processing") {
        logger.warn({ pollJson }, "AntiCaptcha task error");
        return null;
      }
    }
    logger.warn("AntiCaptcha: timed out");
    return null;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a CaptchaSolver from a config object (loaded from the database).
 * Returns null if provider is "none" or the required API key is empty.
 */
export function createCaptchaSolverFromConfig(config: {
  provider: string;
  twoCaptchaApiKey: string;
  capsolverApiKey: string;
  anticaptchaApiKey: string;
}): CaptchaSolver | null {
  const provider = config.provider.toLowerCase();

  if (provider === "capsolver") {
    if (!config.capsolverApiKey) {
      logger.warn("Captcha provider=capsolver but capsolverApiKey is not set");
      return null;
    }
    logger.info("Captcha solver: Capsolver");
    return new CapsolverSolver(config.capsolverApiKey);
  }

  if (provider === "anticaptcha") {
    if (!config.anticaptchaApiKey) {
      logger.warn("Captcha provider=anticaptcha but anticaptchaApiKey is not set");
      return null;
    }
    logger.info("Captcha solver: Anti-Captcha");
    return new AntiCaptchaSolver(config.anticaptchaApiKey);
  }

  if (provider === "2captcha") {
    if (!config.twoCaptchaApiKey) {
      logger.warn("Captcha provider=2captcha but twoCaptchaApiKey is not set");
      return null;
    }
    logger.info("Captcha solver: 2captcha");
    return new TwoCaptchaSolver(config.twoCaptchaApiKey);
  }

  return null;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}
