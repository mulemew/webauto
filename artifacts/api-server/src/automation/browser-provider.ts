import { logger } from "../lib/logger";
import { SeleniumBaseProvider } from "./seleniumbase-adapter";
import { wrapPuppeteerPage, wrapPlaywrightPage, puppeteer, chromium, firefox } from "./page-adapter";
import type { PageAdapter } from "./page-adapter";
import { startLocalProxy, type ProxyType, type ResolvedProxy } from "./proxy-manager";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Which browser backend to use:
 *
 *   playwright  — chromium.connectOverCDP()   (default)
 *                 Universal CDP. Works with any CDP-compatible service:
 *                 self-hosted Chrome, browserless, BrightData, Steel.dev, etc.
 *
 *   puppeteer   — puppeteer.connect({ browserWSEndpoint })
 *                 Universal CDP via the Puppeteer library. Same compatibility
 *                 as "playwright" — choose based on which library you prefer.
 *
 *   local       — chromium.launch()
 *                 Launches Playwright's bundled Chromium directly on the host.
 *                 Does NOT require a remote browser service. Best anti-detection
 *                 because Playwright's Chromium has built-in stealth patches.
 *                 Requires Chromium installed on the host (npm i playwright-core
 *                 && npx playwright install chromium).
 *                 wsEndpoint is ignored when provider is "local".
 *
 * Stealth and anti-detection are handled entirely client-side via init scripts
 * and Chrome launch args (DEFAULT_LAUNCH_ARGS in docker-compose), so the
 * connection method does not affect anti-detection capability.
 */
export type BrowserProviderType =
  | "playwright"
  | "puppeteer"
  | "seleniumbase"
  | "camoufox";

export interface BrowserProviderConfig {
    provider: BrowserProviderType;
    /** WebSocket endpoint — required for all providers */
    wsEndpoint?: string;
    /** URL used for the connection test in the Settings page */
    testUrl?: string;
    /**
     * Browser session timeout in milliseconds (appended as ?timeout= to the WS URL).
     * Browserless.io and compatible services honour this parameter.
     * Default: 1_800_000 ms (30 minutes).
     */
    sessionTimeoutMs?: number;
    /**
     * Enable stealth mode.
     * When true, comprehensive client-side anti-detection scripts are injected
     * into every page (navigator.webdriver, plugins, WebGL, media codecs, etc.).
     * For full coverage, also set DEFAULT_LAUNCH_ARGS in your browserless
     * docker-compose to include --disable-blink-features=AutomationControlled.
     */
    stealth?: boolean;
    /**
     * Block ads and trackers.
     * ─ Playwright: blocked client-side via context.route() against a built-in
     *   ad domain blocklist (works with any CDP service).
     * ─ Puppeteer:  adds blockAds=true to the WS URL (browserless service-side).
     */
    blockAds?: boolean;
    /**
     * HTTP or SOCKS proxy URL (e.g. "http://user:pass@host:1080").
     * ─ Playwright: applied via newContext({ proxy }) — universal.
     * ─ Puppeteer:  injected as --proxy-server Chrome flag via ?launch= (browserless).
     */
    proxyUrl?: string;
    /**
     * Proxy protocol. When omitted it is inferred from proxyUrl's scheme.
     * Values "warp" | "vless" | "vmess" | "trojan" | "hy2" | "tuic" | "ss" are
     * dialed through a local sing-box helper that exposes a plain SOCKS5 to Chromium.
     */
    proxyType?: ProxyType;
    /**
     * WARP only. How many times to register a fresh WARP identity (new exit IP) and
     * retry when reCAPTCHA refuses the audio challenge for the current IP.
     * undefined/null → fall back to RECAPTCHA_MAX_IP_ROTATIONS. 0 disables rotation.
     */
    warpRotations?: number | null;
    /**
     * Force headed (visible) or headless mode for the local Patchright provider.
     * ─ undefined  → auto: headed when a display (Xvfb/DISPLAY) is available.
     * ─ true       → force headed (best for debugging + CF Turnstile bypass).
     * ─ false      → force headless (no window, even if a display exists).
     */
    headed?: boolean;
    /**
     * Playwright storage state (cookies + localStorage) to seed the context with
     * on startup — used by "cookie mode" logins to restore a previous session.
     */
    storageState?: unknown;
    /**
     * Called after a page's context is created, with a function that dumps the
     * current storage state. Runner uses this to persist the session after a
     * successful cookie-mode login. Only wired for the Playwright/local providers.
     */
    onContextReady?: (dumpStorageState: () => Promise<unknown>) => void;
    /**
     * Ignore HTTPS certificate errors (self-signed, expired, etc.).
     * ─ Playwright: applied via newContext({ ignoreHTTPSErrors }) — universal.
     * ─ Puppeteer:  injected as --ignore-certificate-errors via ?launch= (browserless).
     */
    ignoreHTTPS?: boolean;
    /**
     * Browser viewport width in pixels. If both viewportWidth and viewportHeight
     * are set, the specified dimensions are used for every session. Otherwise a
     * random common resolution is picked per session for anti-fingerprinting.
     */
    viewportWidth?: number;
    /**
     * Browser viewport height in pixels. See viewportWidth.
     */
    viewportHeight?: number;
    /**
     * Browser fingerprint spoofing (cf-proxy / SeleniumBase backend only).
     * Configured page-side (global default in Settings, per-task override in the
     * task form) and forwarded to cf-proxy's POST /sessions. Leave os empty/off
     * for the honest (Linux) fingerprint.
     */
    fingerprint?: {
      /** "windows" | "mac" | "linux" | "" (off) */
      os?: string;
      /** IANA timezone, e.g. "America/New_York". Empty = auto-detect from exit IP. */
      timezone?: string;
      /** BCP-47 locale, e.g. "en-US". Empty = auto-detect from exit IP. */
      locale?: string;
      /** Auto-detect timezone/locale from the exit IP when they are not set. Default true. */
      autoGeo?: boolean;
      /** Camoufox only: base64 pickle of a browserforge Fingerprint for EXACT reproduction. */
      fp?: string;
      /** Camoufox only: a real captured preset dict. */
      preset?: unknown;
      /** Human-readable summary (UA / GPU / screen) — display only. */
      summary?: Record<string, unknown>;
    };
  }

export interface BrowserProvider {
  newPage(): Promise<PageAdapter>;
  close(): Promise<void>;
}

// ── Stealth constants ─────────────────────────────────────────────────────────

/** Pool of recent real-world Chrome UA strings — one is picked at random per session. */
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const VIEWPORT_POOL = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
  { width: 1280, height: 720 },
];

/**
 * Returns the viewport to use for a session. If the config specifies both
 * viewportWidth and viewportHeight, those are used as-is. Otherwise a random
 * common resolution is picked for anti-fingerprinting.
 */
function resolveViewport(config: BrowserProviderConfig): { width: number; height: number } {
  if (config.viewportWidth && config.viewportHeight) {
    return { width: config.viewportWidth, height: config.viewportHeight };
  }
  return pickRandom(VIEWPORT_POOL);
}

/**
 * Comprehensive stealth init script.
 * Covers all major detection vectors used by Cloudflare, DataDome, PerimeterX, etc.
 */
const STEALTH_INIT_SCRIPT = () => {
  // ── 1. navigator.webdriver ────────────────────────────────────────────
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  // Also delete from prototype chain
  // @ts-ignore
  delete Navigator.prototype.webdriver;

  // ── 2. navigator.plugins — realistic PluginArray ──────────────────────
  const makePlugin = (name: string, desc: string, filename: string) => {
    const p = Object.create(Plugin.prototype);
    Object.defineProperties(p, {
      name: { value: name, enumerable: true },
      description: { value: desc, enumerable: true },
      filename: { value: filename, enumerable: true },
      length: { value: 1, enumerable: true },
    });
    p[0] = { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" };
    return p;
  };
  const fakePlugins = [
    makePlugin("PDF Viewer", "Portable Document Format", "internal-pdf-viewer"),
    makePlugin("Chrome PDF Viewer", "Portable Document Format", "internal-pdf-viewer"),
    makePlugin("Chromium PDF Viewer", "Portable Document Format", "internal-pdf-viewer"),
    makePlugin("Microsoft Edge PDF Viewer", "Portable Document Format", "internal-pdf-viewer"),
    makePlugin("WebKit built-in PDF", "Portable Document Format", "internal-pdf-viewer"),
  ];
  Object.defineProperty(navigator, "plugins", {
    get: () => {
      const arr = fakePlugins as unknown as PluginArray;
      Object.setPrototypeOf(arr, PluginArray.prototype);
      return arr;
    },
  });
  Object.defineProperty(navigator, "mimeTypes", {
    get: () => {
      const arr = [{ type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: fakePlugins[0] }] as unknown as MimeTypeArray;
      Object.setPrototypeOf(arr, MimeTypeArray.prototype);
      return arr;
    },
  });

  // ── 3. navigator.languages ────────────────────────────────────────────
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });

  // ── 4. navigator.hardwareConcurrency & deviceMemory ───────────────────
  Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
  // @ts-ignore — deviceMemory is only available in secure contexts
  Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

  // ── 5. navigator.platform — match UA ──────────────────────────────────
  // This gets overridden per-session in the provider to match the UA chosen.

  // ── 6. window.chrome — realistic Chrome object ────────────────────────
  // @ts-ignore
  if (!window.chrome) {
    // @ts-ignore
    window.chrome = {};
  }
  // @ts-ignore
  window.chrome.runtime = {
    // ProgrammaticallySendMessage signature present in real Chrome
    connect: function () {},
    sendMessage: function () {},
    id: undefined,
  };
  // @ts-ignore
  window.chrome.loadTimes = function () {
    return {
      requestTime: Date.now() / 1000 - Math.random() * 2,
      startLoadTime: Date.now() / 1000 - Math.random(),
      commitLoadTime: Date.now() / 1000 - Math.random() * 0.5,
      finishDocumentLoadTime: Date.now() / 1000,
      finishLoadTime: Date.now() / 1000,
      firstPaintTime: Date.now() / 1000 - Math.random() * 0.3,
      firstPaintAfterLoadTime: 0,
      navigationType: "Other",
      wasFetchedViaSpdy: false,
      wasNpnNegotiated: true,
      npnNegotiatedProtocol: "h2",
      wasAlternateProtocolAvailable: false,
      connectionInfo: "h2",
    };
  };
  // @ts-ignore
  window.chrome.csi = function () {
    return { startE: Date.now(), onloadT: Date.now(), pageT: Date.now() - performance.timing.navigationStart, tran: 15 };
  };
  // @ts-ignore
  window.chrome.app = { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" } };

  // ── 7. Permissions.query — mask automation-specific behaviour ──────────
  const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (originalQuery) {
    // @ts-ignore
    window.navigator.permissions.query = (parameters: PermissionDescriptor) => {
      if (parameters.name === "notifications") {
        return Promise.resolve({ state: Notification.permission as PermissionState, onchange: null } as PermissionStatus);
      }
      return originalQuery(parameters);
    };
  }

  // ── 8. iframe contentWindow — prevent cross-origin detection ──────────
  // Ensure accessing contentWindow on same-origin iframes doesn't reveal
  // the automation context.
  try {
    const origGetter = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
    if (origGetter?.get) {
      Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
        get: function () {
          const w = origGetter.get!.call(this);
          if (w) {
            try { Object.defineProperty(w, "chrome", { value: (window as unknown as Record<string, unknown>).chrome, configurable: true }); } catch {}
          }
          return w;
        },
      });
    }
  } catch {}

  // ── 9. WebGL renderer / vendor spoofing ───────────────────────────────
  const getParameterProto = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param: GLenum) {
    // UNMASKED_VENDOR_WEBGL
    if (param === 0x9245) return "Google Inc. (NVIDIA)";
    // UNMASKED_RENDERER_WEBGL
    if (param === 0x9246) return "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)";
    return getParameterProto.call(this, param);
  };
  // Also patch WebGL2
  const getParameter2Proto = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (param: GLenum) {
    if (param === 0x9245) return "Google Inc. (NVIDIA)";
    if (param === 0x9246) return "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)";
    return getParameter2Proto.call(this, param);
  };

  // ── 10. Prevent sourceURL / toString leaks ────────────────────────────
  // Make evaluateOnNewDocument scripts harder to fingerprint
  const origToString = Function.prototype.toString;
  // @ts-ignore
  Function.prototype.toString = function () {
    // If this is a native function being spoofed, return the native signature
    if (this === Function.prototype.toString) return "function toString() { [native code] }";
    return origToString.call(this);
  };

  // ── 11. Media codecs — realistic canPlayType responses ─────────────
  const origCanPlayType = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type: string) {
    // Return realistic responses for common probes used by fingerprinters
    if (type === 'video/mp4; codecs="avc1.42E01E"') return "probably";
    if (type === 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"') return "probably";
    if (type === "video/webm") return "probably";
    if (type === 'video/webm; codecs="vp8, vorbis"') return "probably";
    if (type === 'video/webm; codecs="vp9"') return "probably";
    if (type === "audio/mpeg") return "probably";
    if (type === 'audio/mp4; codecs="mp4a.40.2"') return "probably";
    if (type === "audio/webm") return "probably";
    if (type === 'audio/ogg; codecs="vorbis"') return "probably";
    return origCanPlayType.call(this, type);
  };

  // ── 12. navigator.vendor — match Chrome ───────────────────────────────
  Object.defineProperty(navigator, "vendor", { get: () => "Google Inc." });

  // ── 13. Screen dimensions — match viewport ────────────────────────────
    // Will be overridden by the provider to match the random viewport chosen.

    // ── 14–16. Canvas / Audio / ClientRects fingerprint patches ────────────
    //
    // REMOVED.  These patches injected noise into getImageData, AudioContext,
    // and getBoundingClientRect to randomise fingerprints across sessions.
    //
    // However, Cloudflare Turnstile (and similar PoW-based captchas) call
    // these APIs multiple times and perform consistency checks.  ANY noise —
    // even deterministic-per-session — causes the PoW to fail because:
    //   • Canvas: Turnstile reads, draws, reads again → results must match
    //   • ClientRects: repeated calls on the same element must be identical
    //   • Audio: Turnstile compares successive analyser snapshots
    //
    // When running through browserless (stock Chromium + these JS patches),
    // Turnstile permanently stuck on "Verifying…" because PoW never passed.
    // Local Playwright was unaffected because it uses its own bundled Chromium
    // with built-in anti-detection that does NOT patch these APIs.
    //
    // The other stealth patches (webdriver, plugins, chrome object, WebGL,
    // permissions, Function.toString, media codecs) are sufficient for
    // anti-detection without breaking captcha verification.

    // ── 17. WebRTC IP leak prevention ────────────────────────────────────────
    // Neuter WebRTC to prevent IP leaks, but keep APIs visible with realistic
    // mock implementations.  Setting them to undefined is itself a detection
    // signal since real browsers always expose these APIs.
    try {
      Object.defineProperty(navigator, "mediaDevices", {
        get: () => ({
          enumerateDevices: () => Promise.resolve([]),
          getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
          getDisplayMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => true,
        }),
      });
    } catch {}
    try {
      const _FakeRTC = function () { throw new DOMException("Permission denied", "NotAllowedError"); } as any;
      _FakeRTC.prototype = {};
      _FakeRTC.generateCertificate = () => Promise.reject(new DOMException("Not supported"));
      (window as any).RTCPeerConnection = _FakeRTC;
      (window as any).webkitRTCPeerConnection = _FakeRTC;
    } catch {}

    // ── 18. Battery API mock ──────────────────────────────────────────────────
    // Headless Chrome has no battery info — a well-known headless signal.
    // Return a plausible "plugged-in laptop" state.
    try {
      (navigator as any).getBattery = () => Promise.resolve({
        charging: true, chargingTime: 0, dischargingTime: Infinity,
        level: 0.87 + Math.random() * 0.1,
        addEventListener: () => {}, removeEventListener: () => {},
      });
    } catch {}

    // ── 19. CDP / automation runtime trace cleanup ────────────────────────────
    // ChromeDriver and some CDP setups leave window.cdc_* globals.
    // Playwright doesn't inject them, but defensive cleanup costs nothing.
    try {
      const g = window as unknown as Record<string, unknown>;
      for (const key of Object.keys(g)) {
        if (/^(cdc_|__driver_|__webdriver_|__nightmare|_phantom|callPhantom)/.test(key)) {
          try { delete g[key]; } catch {}
        }
      }
    } catch {}
  };

// ── Ad / tracker domain blocklist (compact EasyList subset) ──────────────────

/**
 * High-impact ad and tracker domains. Requests matching these patterns are
 * aborted at the network layer when blockAds is enabled.
 *
 * Playwright path: blocked via context.route() (client-side, universal).
 * Puppeteer path:  blocked via ?blockAds=true on the WS URL (browserless service-side).
 */
const AD_DOMAIN_PATTERNS = [
  // ── Major ad networks ──
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "adnxs.com",
  "adsrvr.org",
  "amazon-adsystem.com",
  "facebook.net",
  "fbcdn.net",
  "analytics.tiktok.com",
  "ads-twitter.com",
  "ads.linkedin.com",
  // ── Programmatic / SSP / DSP ──
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "casalemedia.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "moatads.com",
  "serving-sys.com",
  "adform.net",
  "bidswitch.net",
  "sharethis.com",
  "sharethrough.com",
  // ── Tracking / analytics ──
  "scorecardresearch.com",
  "quantserve.com",
  "bluekai.com",
  "demdex.net",
  "krxd.net",
  "exelator.com",
  "tapad.com",
  "rlcdn.com",
  "hotjar.com",
  "mouseflow.com",
  "fullstory.com",
  "newrelic.com",
  "nr-data.net",
  "sentry.io",
  // ── Pop-ups / malware / annoyances ──
  "popads.net",
  "popcash.net",
  "propellerads.com",
  "revenuehits.com",
];

/** Pre-compiled regex for ad domain matching (used by Playwright route). */
const AD_BLOCK_RE = new RegExp(
  AD_DOMAIN_PATTERNS.map((d) => d.replace(/\./g, "\\.")).join("|"),
);

// ── Navigation timeout ────────────────────────────────────────────────────────

/**
 * Resolve the per-config proxy into a Chromium-usable server URL, starting a
 * local sing-box helper for advanced protocols (warp/vless/vmess/trojan/hy2/tuic/ss).
 * Returns null when no proxy is configured. The caller is responsible for
 * calling `.stop()` on the returned helper when the browser closes.
 */
async function resolveProxyForConfig(
  config: BrowserProviderConfig,
  remoteConsumer = false,
): Promise<ResolvedProxy | null> {
  if (!config.proxyUrl && !config.proxyType) return null;
  try {
    return await startLocalProxy({ proxyType: config.proxyType, proxyUrl: config.proxyUrl }, remoteConsumer);
  } catch (err) {
    logger.error({ err, proxyType: config.proxyType }, "Failed to start proxy — proceeding without it");
    throw err;
  }
}

// ── Navigation timeout ────────────────────────────────────────────────────────

/**
 * Default navigation timeout for all page.goto() / waitForNavigation() calls.
 * Remote browser services inject a low default (10 s) that causes premature
 * failures on slow or JS-heavy pages. We always override it.
 */
const NAV_TIMEOUT_MS = 60_000;

// ── Puppeteer CDP provider ────────────────────────────────────────────────────

class PuppeteerCDPProvider implements BrowserProvider {
    constructor(private readonly config: BrowserProviderConfig & { wsEndpoint: string }) {}

    async newPage(): Promise<PageAdapter> {
      // For Puppeteer CDP, proxy and ignoreHTTPS must be baked into the WS URL as
      // Chrome launch flags (browserless reads them from the ?launch= JSON param).
      // Resolve advanced proxy types (warp/vless/…) to a local SOCKS5 first.
      const _resolvedProxy = await resolveProxyForConfig(this.config, true);
      const _cfg = _resolvedProxy ? { ...this.config, proxyUrl: _resolvedProxy.serverUrl } : this.config;
      const ws = buildWsUrl(_cfg, true);
      const safeUrl = ws.replace(/([?&]token=)[^&]*/g, "$1***");
      logger.info({ wsEndpoint: safeUrl }, "Connecting to remote CDP browser (Puppeteer)");

      const browser = await puppeteer.connect({ browserWSEndpoint: ws });
    const page = await browser.newPage();

    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const vp = resolveViewport(this.config);
    const ua = pickRandom(UA_POOL);
    await page.setViewport(vp);
    await page.setUserAgent(ua);
    // Merge all per-page init scripts into ONE evaluateOnNewDocument call to
      // cut CDP round-trips over the remote browserless connection. Every extra
      // evaluateOnNewDocument is a separate CDP message exchange — with stealth
      // enabled this was 3 round-trips per page; now it is 1.
      const platform = ua.includes("Macintosh") ? "MacIntel" : ua.includes("Linux") ? "Linux x86_64" : "Win32";
      const combinedInitScript = `(${STEALTH_INIT_SCRIPT.toString()})();
  Object.defineProperty(screen,'width',{get:()=>${vp.width}});
  Object.defineProperty(screen,'height',{get:()=>${vp.height}});
  Object.defineProperty(screen,'availWidth',{get:()=>${vp.width}});
  Object.defineProperty(screen,'availHeight',{get:()=>${vp.height - 40}});
  Object.defineProperty(window,'outerWidth',{get:()=>${vp.width}});
  Object.defineProperty(window,'outerHeight',{get:()=>${vp.height}});
  Object.defineProperty(navigator,'platform',{get:()=>"${platform}"});`;
      await page.evaluateOnNewDocument(combinedInitScript);

    const adapter = wrapPuppeteerPage(page);

    const origClose = adapter.close.bind(adapter);
    adapter.close = async (opts) => {
      await origClose(opts).catch(() => {});
      await browser.disconnect().catch(() => {});
      if (_resolvedProxy) await _resolvedProxy.stop().catch(() => {});
    };

    const makePuppeteerNewPageWaiter = (opts?: { timeout?: number }): Promise<PageAdapter> =>
      new Promise<PageAdapter>((resolve, reject) => {
        const timeout = opts?.timeout ?? 30000;
        const timer = setTimeout(
          () => reject(new Error(`Timeout waiting for new page (${timeout}ms)`)),
          timeout,
        );
        browser.once("targetcreated", async (target) => {
          if (target.type() === "page") {
            clearTimeout(timer);
            try {
              const newPage = await target.asPage();
              newPage.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
              newPage.setDefaultTimeout(NAV_TIMEOUT_MS);
              await newPage.setViewport(vp);
              await newPage.setUserAgent(ua);
              await newPage.evaluateOnNewDocument(STEALTH_INIT_SCRIPT);
              const newAdapter = wrapPuppeteerPage(newPage);
              newAdapter.close = async () => { await newPage.close().catch(() => {}); };
              newAdapter.waitForNewPage = makePuppeteerNewPageWaiter;
              resolve(newAdapter);
            } catch (e) {
              reject(e);
            }
          }
        });
      });

    adapter.waitForNewPage = makePuppeteerNewPageWaiter;
    return adapter;
  }

  async close(): Promise<void> {}
}

// ── Playwright CDP provider ───────────────────────────────────────────────────

class PlaywrightCDPProvider implements BrowserProvider {
    constructor(protected readonly config: BrowserProviderConfig & { wsEndpoint: string }) {}

    async newPage(): Promise<PageAdapter> {
      // For Playwright providers, proxy and ignoreHTTPS are context-level options —
      // they work universally regardless of which remote service is in use.
      const ws = buildWsUrl(this.config, false);
      const safeUrl = ws.replace(/([?&]token=)[^&]*/g, "$1***");
      logger.info({ wsEndpoint: safeUrl }, "Connecting to remote CDP browser (Playwright connectOverCDP)");

      const browser = await chromium.connectOverCDP(ws);
      return this._makePageAdapter(browser);
    }

    protected async _makePageAdapter(browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>): Promise<PageAdapter> {
      const vp = resolveViewport(this.config);
      const ua = pickRandom(UA_POOL);
      const proxyServer = await resolveProxyForConfig(this.config, true);
      const context = await browser.newContext({
        viewport: vp,
        userAgent: ua,
        screen: vp,
        ...(proxyServer ? { proxy: { server: proxyServer.serverUrl } } : {}),
        ...(this.config.storageState ? { storageState: this.config.storageState as never } : {}),
        ignoreHTTPSErrors: this.config.ignoreHTTPS ?? false,
      });

    // Expose a storage-state dumper for cookie-mode session persistence.
    if (this.config.onContextReady) {
      this.config.onContextReady(async () => context.storageState());
    }

    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    context.setDefaultTimeout(NAV_TIMEOUT_MS);

    // Block ads & trackers at the network layer (client-side implementation)
    if (this.config.blockAds) {
      await context.route((url) => AD_BLOCK_RE.test(url.hostname), (route) => route.abort());
    }

    await context.addInitScript(STEALTH_INIT_SCRIPT);
    // Override screen dimensions and navigator.platform to match chosen UA/viewport
    const pwPlatform = ua.includes("Macintosh") ? "MacIntel" : ua.includes("Linux") ? "Linux x86_64" : "Win32";
    await context.addInitScript(([w, h, p]: [number, number, string]) => {
      Object.defineProperty(screen, "width", { get: () => w });
      Object.defineProperty(screen, "height", { get: () => h });
      Object.defineProperty(screen, "availWidth", { get: () => w });
      Object.defineProperty(screen, "availHeight", { get: () => h - 40 });
      Object.defineProperty(window, "outerWidth", { get: () => w });
      Object.defineProperty(window, "outerHeight", { get: () => h });
      Object.defineProperty(navigator, "platform", { get: () => p });
    }, [vp.width, vp.height, pwPlatform] as [number, number, string]);
    const page = await context.newPage();

    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const makeAdapter = (p: import("playwright-core").Page): PageAdapter => {
      p.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      p.setDefaultTimeout(NAV_TIMEOUT_MS);
      const a = wrapPlaywrightPage(p);
      a.close = async () => { await p.close().catch(() => {}); };
      a.waitForNewPage = async (opts) => {
        const newPage = await context.waitForEvent("page", { timeout: opts?.timeout ?? 30000 });
        try { await newPage.waitForLoadState("domcontentloaded", { timeout: 5000 }); } catch { /* ignore */ }
        return makeAdapter(newPage);
      };
      return a;
    };

    const adapter = makeAdapter(page);

    adapter.close = async () => {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      if (proxyServer) await proxyServer.stop().catch(() => {});
    };

    return adapter;
  }

  async close(): Promise<void> {}
}

// ── Factory ───────────────────────────────────────────────────────────────────

// ── Camoufox provider (anti-detect Firefox via the camoufox-proxy sidecar) ──────
// A SEPARATE provider. Does not touch the SeleniumBase cf-proxy path. The sidecar
// launches a Camoufox Playwright server per session with the requested fingerprint/
// proxy; here we just firefox.connect() to it and drive it with the existing adapter.
const CAMOUFOX_URL = (process.env.CAMOUFOX_URL ?? "http://camoufox-proxy:7318").replace(/\/$/, "");

function parseProxyForCamoufox(proxyUrl?: string): { server: string; username?: string; password?: string } | undefined {
  if (!proxyUrl || !proxyUrl.trim()) return undefined;
  try {
    const u = new URL(proxyUrl.trim());
    const out: { server: string; username?: string; password?: string } = { server: `${u.protocol}//${u.host}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch { return undefined; }
}

class CamoufoxProvider implements BrowserProvider {
  private readonly _browsers = new Set<import("playwright-core").Browser>();
  private readonly _ids = new Map<import("playwright-core").Browser, string>();
  constructor(private readonly config: BrowserProviderConfig) {}

  private async release(id: string): Promise<void> {
    try {
      await fetch(`${CAMOUFOX_URL}/release`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      });
    } catch { /* ignore */ }
  }

  async newPage(): Promise<PageAdapter> {
    const vp = resolveViewport(this.config);
    const fp = this.config.fingerprint ?? {};
    const res = await fetch(`${CAMOUFOX_URL}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        os: fp.os || "",
        locale: fp.locale || "",
        timezone: fp.timezone || "",
        screen: `${vp.width}x${vp.height}`,
        proxy: parseProxyForCamoufox(this.config.proxyUrl),
        // The saved profile's fixed fingerprint (browserforge pickle or preset); the
        // sidecar reproduces it exactly via launch_server(fingerprint=/fingerprint_preset=).
        fingerprint: fp,
      }),
    });
    if (!res.ok) throw new Error(`camoufox-proxy /launch failed: ${res.status} ${await res.text().catch(() => "")}`);
    const { id, ws } = (await res.json()) as { id: string; ws: string };

    let browser: import("playwright-core").Browser;
    try {
      browser = (await firefox.connect(ws)) as unknown as import("playwright-core").Browser;
    } catch (err) {
      await this.release(id);
      throw err;
    }
    this._browsers.add(browser);
    this._ids.set(browser, id);

    const context = await browser.newContext({
      viewport: vp,
      ...(this.config.storageState ? { storageState: this.config.storageState as never } : {}),
      ignoreHTTPSErrors: this.config.ignoreHTTPS ?? false,
    });
    if (this.config.onContextReady) this.config.onContextReady(async () => context.storageState());
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    if (this.config.blockAds) {
      await context.route((url) => AD_BLOCK_RE.test(url.hostname), (route) => route.abort());
    }

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const makeAdapter = (p: import("playwright-core").Page): PageAdapter => {
      p.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      p.setDefaultTimeout(NAV_TIMEOUT_MS);
      const a = wrapPlaywrightPage(p);
      a.close = async () => { await p.close().catch(() => {}); };
      a.waitForNewPage = async (opts) => {
        const np = await context.waitForEvent("page", { timeout: opts?.timeout ?? 30000 });
        try { await np.waitForLoadState("domcontentloaded", { timeout: 5000 }); } catch { /* ignore */ }
        return makeAdapter(np);
      };
      return a;
    };

    const adapter = makeAdapter(page);
    adapter.close = async () => {
      this._browsers.delete(browser);
      this._ids.delete(browser);
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      await this.release(id);
    };
    return adapter;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this._browsers].map(async (b) => {
      const id = this._ids.get(b);
      await b.close().catch(() => {});
      if (id) await this.release(id);
    }));
    this._browsers.clear();
    this._ids.clear();
  }
}

/**
   * Builds the final WebSocket URL by injecting query parameters from the
   * provider config. Existing params are never overwritten, so values
   * already present in the user-supplied URL always take precedence.
   *
   * Parameter scope:
   *   timeout   ─ session lifetime (ms). Browserless + compatible services.
   *   blockAds  ─ Puppeteer path only (browserless service-side feature).
   *               Playwright path handles ad blocking client-side via context.route().
   *   launch    ─ Chrome flags JSON (Puppeteer path only).
   *               Playwright uses newContext() options for proxy/ignoreHTTPS.
   *
   * Stealth and ad blocking for Playwright are handled entirely client-side.
   */
  function buildWsUrl(config: BrowserProviderConfig, includeChromeFlags: boolean): string {
    const wsEndpoint = config.wsEndpoint ?? "";
    try {
      const url = new URL(wsEndpoint);

      // Session timeout
      if (!url.searchParams.has("timeout")) {
        url.searchParams.set("timeout", String(config.sessionTimeoutMs ?? 1_800_000));
      }

      // Chrome launch flags — ALWAYS include anti-detection flags regardless of
      // provider (Playwright or Puppeteer). Remote browser services like browserless
      // use stock Chromium which exposes automation markers that Playwright's bundled
      // Chromium patches out. These flags are critical for Cloudflare Turnstile,
      // GeeTest, and other anti-bot systems.
      const extraArgs: string[] = [];

      if (config.stealth !== false) {
        extraArgs.push(
          "--disable-blink-features=AutomationControlled",
          "--disable-features=AutomationControlled,IsolateOrigins,site-per-process",
          "--disable-site-isolation-trials",
          "--disable-infobars",
          "--no-first-run",
          "--disable-component-extensions-with-background-pages",
          "--no-default-browser-check",
        );
      }

      // Puppeteer/browserless-specific params
      if (includeChromeFlags) {
        // Ad/tracker blocking (browserless service-side feature)
        if (config.blockAds && !url.searchParams.has("blockAds")) {
          url.searchParams.set("blockAds", "true");
        }

        if (config.proxyUrl) extraArgs.push(`--proxy-server=${config.proxyUrl}`);
        if (config.ignoreHTTPS) extraArgs.push("--ignore-certificate-errors");
      }

      if (extraArgs.length > 0 && !url.searchParams.has("launch")) {
        url.searchParams.set("launch", JSON.stringify({ args: extraArgs }));
      }

      return url.toString();
    } catch {
      return wsEndpoint; // not a parseable URL ─ leave unchanged
    }
  }

  export function createBrowserProvider(config: BrowserProviderConfig): BrowserProvider {
  const p = config.provider ?? "playwright";

  if (p === "camoufox") {
    return new CamoufoxProvider(config);
  }

  if (p === "seleniumbase") {
      // ── cf-proxy base URL resolution ──────────────────────────────────────
      // Primary source is always CF_PROXY_URL (env), which points at the
      // cf-proxy sidecar container. config.wsEndpoint is treated ONLY as an
      // explicit override candidate: it must be an http(s) URL AND must pass a
      // live cf-proxy /health probe (done lazily inside SeleniumBaseProvider)
      // before it is used. This prevents a wrong value accidentally stored in
      // settings (e.g. a leftover browserless ws:// / http:// endpoint) from
      // pointing every session at a non-cf-proxy host and failing the whole
      // batch with "fetch failed".
      const envBaseUrl = (process.env.CF_PROXY_URL ?? "http://cf-proxy:7317").replace(/\/$/, "");
      const endpoint = config.wsEndpoint?.trim();
      const overrideCandidate =
        endpoint && /^https?:\/\//i.test(endpoint) ? endpoint.replace(/\/$/, "") : undefined;
      return new SeleniumBaseProvider(envBaseUrl, config, overrideCandidate);
    }

    if (!config.wsEndpoint) {
      throw new Error(
        `BROWSER_PROVIDER="${p}" requires a WebSocket endpoint. ` +
          `Set BROWSERLESS_URL (env) or configure it in the dashboard settings.`,
      );
    }

  const fullConfig = config as BrowserProviderConfig & { wsEndpoint: string };

    if (p === "puppeteer") {
      return new PuppeteerCDPProvider(fullConfig);
    }

    // Default: Playwright CDP
    return new PlaywrightCDPProvider(fullConfig);
  }

export function getBrowserProviderFromEnv(): BrowserProvider {
  const provider = (process.env.BROWSER_PROVIDER ?? "playwright") as BrowserProviderType;
  const wsEndpoint = process.env.BROWSERLESS_URL;
  return createBrowserProvider({ provider, wsEndpoint, stealth: true, blockAds: true });
}

export { getBrowserProviderFromEnv as getBrowserProvider };
