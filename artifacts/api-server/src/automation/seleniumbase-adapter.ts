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

  async function cfFetch(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(url, init);
    const data = (await res.json()) as Record<string, unknown>;
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
    private readonly baseUrl: string;
    private readonly config: BrowserProviderConfig | null;

    constructor(baseUrl: string = DEFAULT_CF_PROXY_URL, config: BrowserProviderConfig | null = null) {
      this.baseUrl = baseUrl;
      this.config = config;
    }

    async newPage(): Promise<SeleniumBasePageAdapter> {
      logger.info({ cfProxyUrl: this.baseUrl }, "Creating SeleniumBase UC session...");

      // ── Resolve the per-task proxy so cf-proxy's Chrome routes through it ──
      // cf-proxy runs in a SEPARATE container, so 127.0.0.1 there is itself.
      // For advanced protocols (vless/vmess/trojan/hy2/warp) we start a local
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
          logger.error({ err, proxyType: this.config.proxyType }, "Failed to resolve proxy for cf-proxy — proceeding without it");
          throw err;
        }
      }

      const body = proxyServerUrl ? { proxy: proxyServerUrl } : undefined;
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/sessions`, {
          method: "POST",
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (resolvedProxy) await resolvedProxy.stop().catch(() => {});
        throw err;
      }
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok || !data["session_id"]) {
        if (resolvedProxy) await resolvedProxy.stop().catch(() => {});
        throw new Error(
          `SeleniumBase session creation failed: ${data["error"] ?? `HTTP ${res.status}`}`,
        );
      }
      const sid = data["session_id"] as string;
      logger.info({ sid, proxied: !!proxyServerUrl }, "SeleniumBase UC session ready");
      return new SeleniumBasePageAdapter(this.baseUrl, sid, resolvedProxy);
    }

    async close(): Promise<void> {
      // Sessions are closed individually when page.close() is called
    }
  }
