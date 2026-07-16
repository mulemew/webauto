/**
   * SeleniumBasePageAdapter — PageAdapter backed by the Python cf-proxy sidecar.
   *
   * All browser operations are delegated to cf-proxy (http://cf-proxy:7317) which
   * runs SeleniumBase in UC (undetected Chrome) mode.  Every goto() call uses
   * uc_open_with_reconnect(), which temporarily disconnects CDP so Cloudflare sees
   * a real browser during the challenge window, then reconnects after it passes.
   *
   * This is the highest-reliability Cloudflare bypass available without paid services.
   */

  import type {
    PageAdapter,
    ElementAdapter,
    FrameAdapter,
    KeyboardAdapter,
    MouseAdapter,
    DialogAdapter,
  } from "./page-adapter";
  import { logger } from "../lib/logger";
  import type { BrowserProvider, BrowserProviderConfig } from "./browser-provider";
  import { startLocalProxy, type ResolvedProxy } from "./proxy-manager";

  const DEFAULT_CF_PROXY_URL = "http://cf-proxy:7317";

  // ── HTTP helpers ─────────────────────────────────────────────────────────────

  function maskUrl(url: string): string {
    return url.replace(/([?&]token=)[^&]*/g, "$1***");
  }

  async function cfFetch(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `cf-proxy request failed: ${init?.method ?? "GET"} ${maskUrl(url)} (${message}). ` +
          `Check that the SeleniumBase cf-proxy sidecar is running and that CF_PROXY_URL is reachable from api-server.`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data["error"]) {
      throw new Error(String(data["error"] ?? `HTTP ${res.status} ${res.statusText}`));
    }
    return data;
  }

  function cfGet(baseUrl: string, path: string): Promise<Record<string, unknown>> {
    return cfFetch(`${baseUrl}${path}`);
  }

  function cfPost(baseUrl: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    return cfFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async function cfDelete(baseUrl: string, path: string): Promise<void> {
    await fetch(`${baseUrl}${path}`, { method: "DELETE" });
  }

  // ── Element adapter ───────────────────────────────────────────────────────────

  function makeElementAdapter(baseUrl: string, sid: string, selector: string): ElementAdapter {
    return {
      async click(): Promise<void> {
        await cfPost(baseUrl, `/sessions/${sid}/element/click`, { selector });
      },
      async evaluate<T>(fn: (el: Element) => T): Promise<T> {
        const script = `return (${fn.toString()})(arguments[0])`;
        const data = await cfPost(baseUrl, `/sessions/${sid}/element/evaluate`, { selector, script });
        return data["result"] as T;
      },
      async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
        const data = await cfPost(baseUrl, `/sessions/${sid}/find-element`, { selector });
        return (data["rect"] as { x: number; y: number; width: number; height: number }) ?? null;
      },
      async screenshot(opts?: { encoding?: "base64" | "binary" }): Promise<Buffer | string> {
        const data = await cfPost(baseUrl, `/sessions/${sid}/element/screenshot`, { selector });
        const b64 = data["data"];
        if (typeof b64 !== "string" || !b64) {
          throw new Error(`cf-proxy element screenshot returned invalid data (type=${typeof b64})`);
        }
        return opts?.encoding === "base64" ? b64 : Buffer.from(b64, "base64");
      },
    };
  }

  // ── Page adapter ──────────────────────────────────────────────────────────────

  export class SeleniumBasePageAdapter implements PageAdapter {
    private readonly baseUrl: string;
    readonly sid: string;
    private _cachedUrl: string = "about:blank";
    private _closed = false;
    private _cachedFrames: FrameAdapter[] = [];
    /** Local sing-box helper backing an advanced proxy — stopped on close(). */
    private _resolvedProxy: ResolvedProxy | null = null;

    constructor(baseUrl: string, sid: string, resolvedProxy: ResolvedProxy | null = null) {
      this.baseUrl = baseUrl;
      this.sid = sid;
      this._resolvedProxy = resolvedProxy;
    }

    readonly keyboard: KeyboardAdapter = {
      type: async (text: string, opts?: { delay?: number }): Promise<void> => {
        await cfPost(this.baseUrl, `/sessions/${this.sid}/keyboard/type`, {
          text,
          delay: opts?.delay ?? 0,
        });
      },
      press: async (key: string): Promise<void> => {
        await cfPost(this.baseUrl, `/sessions/${this.sid}/keyboard/press`, { key });
      },
    };

    readonly mouse: MouseAdapter = {
      move: async (x: number, y: number): Promise<void> => {
        await cfPost(this.baseUrl, `/sessions/${this.sid}/mouse/move`, { x, y });
      },
      click: async (x: number, y: number): Promise<void> => {
        await cfPost(this.baseUrl, `/sessions/${this.sid}/mouse/click`, { x, y });
      },
    };

    async goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void> {
      const timeoutMs = options?.timeout ?? 60_000;
      const data = await cfPost(this.baseUrl, `/sessions/${this.sid}/goto`, {
        url,
        bypass_cf: true,
        timeout: Math.floor(timeoutMs / 1000),
      });
      this._cachedUrl = (data["url"] as string) ?? url;
    }

    async click(selector: string): Promise<void> {
      await cfPost(this.baseUrl, `/sessions/${this.sid}/click`, { selector });
      // Refresh URL in case click triggered navigation
      try {
        const d = await cfGet(this.baseUrl, `/sessions/${this.sid}/url`);
        this._cachedUrl = (d["url"] as string) ?? this._cachedUrl;
      } catch { /* non-critical */ }
    }

    async hover(selector: string): Promise<void> {
      await cfPost(this.baseUrl, `/sessions/${this.sid}/hover`, { selector });
    }

    async waitForSelector(selector: string, options?: { timeout?: number }): Promise<void> {
      const timeout = options?.timeout ?? 30_000;
      await cfPost(this.baseUrl, `/sessions/${this.sid}/wait-for-selector`, { selector, timeout });
    }

    async waitForNavigation(options?: { waitUntil?: string; timeout?: number }): Promise<void> {
      const timeout = options?.timeout ?? 30_000;
      const data = await cfPost(this.baseUrl, `/sessions/${this.sid}/wait-for-navigation`, { timeout });
      this._cachedUrl = (data["url"] as string) ?? this._cachedUrl;
    }

    async $(selector: string): Promise<ElementAdapter | null> {
      try {
        const data = await cfPost(this.baseUrl, `/sessions/${this.sid}/find-element`, { selector });
        if (!data["found"]) return null;
        return makeElementAdapter(this.baseUrl, this.sid, selector);
      } catch {
        return null;
      }
    }

    async evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T> {
      const script =
        typeof fn === "function"
          ? `return (${fn.toString()}).apply(null, arguments)`
          : (fn as string);
      const data = await cfPost(this.baseUrl, `/sessions/${this.sid}/evaluate`, { script, args });
      return data["result"] as T;
    }

    async screenshot(options?: {
      type?: "png" | "jpeg";
      encoding?: "base64" | "binary";
      timeout?: number;
    }): Promise<Buffer | string> {
      const data = await cfPost(this.baseUrl, `/sessions/${this.sid}/screenshot`, {});
      const b64 = data["data"];
      if (typeof b64 !== "string" || !b64) {
        throw new Error(`cf-proxy screenshot returned invalid data (type=${typeof b64})`);
      }
      return options?.encoding === "base64" ? b64 : Buffer.from(b64, "base64");
    }

    url(): string {
      return this._cachedUrl;
    }

    async title(): Promise<string> {
      const data = await cfGet(this.baseUrl, `/sessions/${this.sid}/title`);
      return (data["title"] as string) ?? "";
    }

    on(event: "dialog", handler: (dialog: DialogAdapter) => void): void {
      // Best-effort: SeleniumBase auto-dismisses unexpected alerts via driver.
      // Complex dialog flows should use evaluate() to interact with the DOM.
      void handler;
    }

    async close(_options?: Record<string, unknown>): Promise<void> {
      this._closed = true;
      await cfDelete(this.baseUrl, `/sessions/${this.sid}`);
      if (this._resolvedProxy) {
        await this._resolvedProxy.stop().catch(() => {});
        this._resolvedProxy = null;
      }
    }

    viewport(): { width: number; height: number } | null {
      return { width: 1280, height: 900 };
    }

    frames(): FrameAdapter[] {
      // Synchronous — cache frames from last fetchFrames() call.
      // This is inherently limited since frames() is sync in the PageAdapter
      // interface but cf-proxy requires an async HTTP call.
      // The Turnstile detection code calls frames() to check for CF iframes.
      // We provide a cached result populated by fetchFrames().
      return this._cachedFrames;
    }

    /**
     * Fetch frames from cf-proxy and update cache.
     * Call this before code that relies on frames() (e.g. Turnstile detection).
     */
    async fetchFrames(): Promise<FrameAdapter[]> {
      try {
        const data = await cfGet(this.baseUrl, `/sessions/${this.sid}/frames`);
        const rawFrames = (data["frames"] as Array<{ url: string; name: string }>) ?? [];
        this._cachedFrames = rawFrames.map((f) => ({
          url: () => f.url,
          name: () => f.name,
          $: async () => null,
        }));
      } catch {
        this._cachedFrames = [];
      }
      return this._cachedFrames;
    }

    /**
     * Click an embedded Turnstile widget using SB's uc_gui_click_captcha + xdotool.
     * This is the most reliable way to solve Turnstile on cf-proxy because it uses
     * OS-level clicks that CF cannot detect.
     */
    /**
     * Swap the proxy's exit IP in place (WARP: register a new identity and restart
     * sing-box on the same local SOCKS port). The browser keeps its proxy setting —
     * only the egress changes — so the session/page survive. Returns false when the
     * proxy type can't rotate.
     */
    async rotateProxy(): Promise<boolean> {
      const r = this._resolvedProxy?.rotate;
      if (!r) return false;
      return (await r()) ?? false;
    }

    async clickTurnstile(maxRetries = 3): Promise<boolean> {
      try {
        const data = await cfPost(this.baseUrl, `/sessions/${this.sid}/click-turnstile`, {
          max_retries: maxRetries,
          timeout: 60,
        });
        return !!(data["solved"]);
      } catch (err) {
        logger.debug({ err }, "clickTurnstile via cf-proxy failed");
        return false;
      }
    }

    /**
     * Solve a reCAPTCHA v2 checkbox via its audio challenge, natively in
     * cf-proxy (Selenium cross-origin frame switching + local Whisper STT).
     * Used by the backend-agnostic recaptcha-audio solver.
     */
    async solveRecaptchaAudio(): Promise<{ solved: boolean; blocked: boolean; message: string }> {
      try {
        const data = await cfPost(this.baseUrl, `/sessions/${this.sid}/solve-recaptcha-audio`, {
          max_rounds: 4,
          timeout: 120,
        });
        return {
          solved: !!data["solved"],
          blocked: !!data["blocked"],
          message: (data["message"] as string) ?? "",
        };
      } catch (err) {
        logger.debug({ err }, "solveRecaptchaAudio via cf-proxy failed");
        return { solved: false, blocked: false, message: err instanceof Error ? err.message : String(err) };
      }
    }

    async waitForNewPage(options?: { timeout?: number }): Promise<PageAdapter> {
      const timeout = options?.timeout ?? 30_000;
      const data = await cfPost(this.baseUrl, `/sessions/${this.sid}/wait-for-new-page`, { timeout });
      const newAdapter = new SeleniumBasePageAdapter(this.baseUrl, data["session_id"] as string);
      newAdapter._cachedUrl = (data["url"] as string) ?? "about:blank";
      return newAdapter;
    }

    isClosed(): boolean {
      return this._closed;
    }

    getOpenPages(): PageAdapter[] {
      return [this];
    }
  }

  // ── Provider ──────────────────────────────────────────────────────────────────

  export class SeleniumBaseProvider implements BrowserProvider {
    private readonly envBaseUrl: string;
    private readonly overrideCandidate: string | undefined;
    private readonly config: BrowserProviderConfig | null;
    /** Resolved effective cf-proxy base URL, memoized after first probe. */
    private resolvedBaseUrl: string | null = null;
    private resolving: Promise<string> | null = null;

    constructor(
      baseUrl: string = DEFAULT_CF_PROXY_URL,
      config: BrowserProviderConfig | null = null,
      overrideCandidate?: string,
    ) {
      this.envBaseUrl = (baseUrl || DEFAULT_CF_PROXY_URL).replace(/\/$/, "");
      this.overrideCandidate = overrideCandidate?.replace(/\/$/, "") || undefined;
      this.config = config;
    }

    /**
     * Probe a candidate URL's cf-proxy /health endpoint. A genuine cf-proxy
     * responds 200 with a JSON body shaped like `{ ok: true, sessions, pool }`.
     * Anything else (browserless, a ws-only endpoint, an unreachable host, or a
     * non-cf-proxy HTTP service) is rejected so we never point sessions at it.
     */
    private static async isReachableCfProxy(baseUrl: string): Promise<boolean> {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) return false;
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        // cf-proxy /health always returns `ok: true` and a `pool` object.
        return !!data && data["ok"] === true && "pool" in data;
      } catch {
        return false;
      }
    }

    /**
     * Resolve the effective cf-proxy base URL exactly once. The explicit
     * wsEndpoint override is honored ONLY when it passes a live cf-proxy
     * /health probe; otherwise we fall back to the env-configured CF_PROXY_URL.
     * This stops a wrong/stale value in settings from failing every task with
     * "fetch failed".
     */
    private async resolveBaseUrl(): Promise<string> {
      if (this.resolvedBaseUrl) return this.resolvedBaseUrl;
      if (this.resolving) return this.resolving;
      this.resolving = (async () => {
        if (this.overrideCandidate && this.overrideCandidate !== this.envBaseUrl) {
          const ok = await SeleniumBaseProvider.isReachableCfProxy(this.overrideCandidate);
          if (ok) {
            logger.info(
              { baseUrl: this.overrideCandidate },
              "Using explicit cf-proxy override endpoint (passed /health probe)",
            );
            this.resolvedBaseUrl = this.overrideCandidate;
            return this.resolvedBaseUrl;
          }
          logger.warn(
            { candidate: this.overrideCandidate, fallback: this.envBaseUrl },
            "Configured seleniumbase endpoint is not a reachable cf-proxy — ignoring override and using CF_PROXY_URL",
          );
        }
        this.resolvedBaseUrl = this.envBaseUrl;
        return this.resolvedBaseUrl;
      })();
      try {
        return await this.resolving;
      } finally {
        this.resolving = null;
      }
    }

    async newPage(): Promise<SeleniumBasePageAdapter> {
      const baseUrl = await this.resolveBaseUrl();
      logger.info({ cfProxyUrl: baseUrl }, "Creating SeleniumBase UC session...");

      // ── Resolve the per-task proxy so cf-proxy's Chrome routes through it ──
      // cf-proxy runs in a SEPARATE container, so 127.0.0.1 there is itself.
      // For advanced protocols (vless/vmess/trojan/hy2/tuic/ss/warp) we start a local
      // sing-box helper bound to a cross-container-reachable address (remote
      // consumer) and hand cf-proxy the resulting socks5:// URL. Plain
      // http/socks5 proxies are passed straight through.
      let resolvedProxy: ResolvedProxy | null = null;
      let proxyServerUrl: string | null = null;
      if (this.config && (this.config.proxyUrl || this.config.proxyType)) {
        try {
          resolvedProxy = await startLocalProxy(
            { proxyType: this.config.proxyType, proxyUrl: this.config.proxyUrl },
            true, // remoteConsumer — cf-proxy's browser is in another container
          );
          proxyServerUrl = resolvedProxy?.serverUrl ?? null;
          if (proxyServerUrl) {
            logger.info({ proxyServerUrl }, "SeleniumBase session will use resolved proxy");
          }
        } catch (err) {
          logger.error({ err, proxyType: this.config.proxyType }, "Failed to resolve proxy for cf-proxy");
          throw err;
        }
      }

      // Forward the page-configured fingerprint (if any) so cf-proxy applies the
      // OS profile per session. Only include it when an OS is actually selected.
      const fp = this.config?.fingerprint;
      const fpBody =
        fp && fp.os && fp.os !== "off"
          ? {
              fingerprint: {
                os: fp.os,
                timezone: fp.timezone ?? "",
                locale: fp.locale ?? "",
                auto_geo: fp.autoGeo !== false,
              },
            }
          : undefined;
      const body =
        proxyServerUrl || fpBody
          ? { ...(proxyServerUrl ? { proxy: proxyServerUrl } : {}), ...(fpBody ?? {}) }
          : undefined;
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (resolvedProxy) await resolvedProxy.stop().catch(() => {});
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Cannot connect to SeleniumBase cf-proxy at ${maskUrl(baseUrl)} (${message}). ` +
            `Verify the cf-proxy container is healthy and CF_PROXY_URL is correct for the current Docker network.`,
        );
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || !data["session_id"]) {
        if (resolvedProxy) await resolvedProxy.stop().catch(() => {});
        throw new Error(
          `SeleniumBase session creation failed: ${data["error"] ?? `HTTP ${res.status}`}`,
        );
      }
      const sid = data["session_id"] as string;
      logger.info({ sid, proxied: !!proxyServerUrl }, "SeleniumBase UC session ready");
      return new SeleniumBasePageAdapter(baseUrl, sid, resolvedProxy);
    }

    async close(): Promise<void> {
      // Sessions are closed individually when page.close() is called
    }
  }
