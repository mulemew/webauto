import { db, settingsTable, eq } from "@workspace/db";
  import type { BrowserProviderConfig } from "../automation/browser-provider";

  const BROWSER_CONFIG_KEY = "browserConfig";
  const CAPTCHA_CONFIG_KEY = "captchaConfig";
  const TASK_TIMEOUT_KEY = "taskTimeoutConfig";
  const RETENTION_CONFIG_KEY = "retentionConfig";

  const DEFAULT_WS_ENDPOINT = process.env.BROWSERLESS_URL ?? "ws://browserless:3000";

  export async function loadBrowserConfig(): Promise<BrowserProviderConfig> {
    try {
      const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, BROWSER_CONFIG_KEY));
      if (row) return JSON.parse(row.value) as BrowserProviderConfig;
    } catch { /* fall through */ }
    const defaultConfig: BrowserProviderConfig = {
      provider: (process.env.BROWSER_PROVIDER as BrowserProviderConfig["provider"]) ?? "playwright",
      wsEndpoint: DEFAULT_WS_ENDPOINT,
      testUrl: "https://example.com",
      stealth: true,
      blockAds: true,
    };
    try { await saveBrowserConfig(defaultConfig); } catch { /* non-fatal */ }
    return defaultConfig;
  }

  export async function saveBrowserConfig(config: BrowserProviderConfig): Promise<void> {
    await db.insert(settingsTable).values({ key: BROWSER_CONFIG_KEY, value: JSON.stringify(config) })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify(config) } });
  }

  export interface TaskTimeoutConfig {
    timeoutMinutes: number;
  }

  const DEFAULT_TASK_TIMEOUT: TaskTimeoutConfig = { timeoutMinutes: 30 };

  export async function loadTaskTimeoutConfig(): Promise<TaskTimeoutConfig> {
    try {
      const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, TASK_TIMEOUT_KEY));
      if (row) return JSON.parse(row.value) as TaskTimeoutConfig;
    } catch { /* fall through */ }
    return DEFAULT_TASK_TIMEOUT;
  }

  export async function saveTaskTimeoutConfig(config: TaskTimeoutConfig): Promise<void> {
    await db.insert(settingsTable).values({ key: TASK_TIMEOUT_KEY, value: JSON.stringify(config) })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify(config) } });
  }

  export type CaptchaProvider = "none" | "2captcha" | "capsolver" | "anticaptcha";

  export interface CaptchaConfig {
    provider: CaptchaProvider;
    twoCaptchaApiKey: string;
    capsolverApiKey: string;
    anticaptchaApiKey: string;
  }

  const DEFAULT_CAPTCHA_CONFIG: CaptchaConfig = {
    provider: "none",
    twoCaptchaApiKey: "",
    capsolverApiKey: "",
    anticaptchaApiKey: "",
  };

  export async function loadCaptchaConfig(): Promise<CaptchaConfig> {
    try {
      const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, CAPTCHA_CONFIG_KEY));
      if (row) return JSON.parse(row.value) as CaptchaConfig;
    } catch { /* fall through */ }
    return DEFAULT_CAPTCHA_CONFIG;
  }

  export async function saveCaptchaConfig(config: CaptchaConfig): Promise<void> {
    await db.insert(settingsTable).values({ key: CAPTCHA_CONFIG_KEY, value: JSON.stringify(config) })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify(config) } });
  }

  // ── Retention config ──────────────────────────────────────────────────────────

  export interface RetentionConfig {
    /** Days to keep execution logs and screenshots. 0 = keep forever. Default: 7 */
    logRetentionDays: number;
    /** Max total screenshots disk usage in MB. 0 = unlimited. Default: 1024 */
    maxScreenshotsMb: number;
  }

  const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
    logRetentionDays: 7,
    maxScreenshotsMb: 1024,
  };

  export async function loadRetentionConfig(): Promise<RetentionConfig> {
    try {
      const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, RETENTION_CONFIG_KEY));
      if (row) return { ...DEFAULT_RETENTION_CONFIG, ...(JSON.parse(row.value) as RetentionConfig) };
    } catch { /* fall through */ }
    return DEFAULT_RETENTION_CONFIG;
  }

  export async function saveRetentionConfig(config: RetentionConfig): Promise<void> {
    await db.insert(settingsTable).values({ key: RETENTION_CONFIG_KEY, value: JSON.stringify(config) })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify(config) } });
  }

    // ── Concurrency config ────────────────────────────────────────────────────────

    export interface ConcurrencyConfig {
      /**
       * Maximum number of tasks running simultaneously.
       * Match this to your browserless MAX_CONCURRENT_SESSIONS env var so the
       * platform semaphore stays in sync with the browser backend capacity.
       * Default: 3.
       */
      maxConcurrent: number;
      /**
       * Max tasks allowed to wait in queue. If the queue is full, new triggers
       * are rejected immediately instead of piling up indefinitely.
       * Set 0 to allow unlimited queuing (not recommended). Default: 10.
       */
      maxQueueDepth: number;
      /**
       * Seconds a task may wait in queue before being dropped automatically.
       * Prevents stale tasks from executing long after they were triggered.
       * Set 0 to wait forever. Default: 300 (5 min).
       */
      queueTimeoutSecs: number;
    }

    const CONCURRENCY_CONFIG_KEY = "concurrencyConfig";

    const DEFAULT_CONCURRENCY_CONFIG: ConcurrencyConfig = {
      maxConcurrent: 3,
      maxQueueDepth: 10,
      queueTimeoutSecs: 300,
    };

    export async function loadConcurrencyConfig(): Promise<ConcurrencyConfig> {
      try {
        const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, CONCURRENCY_CONFIG_KEY));
        if (row) return { ...DEFAULT_CONCURRENCY_CONFIG, ...(JSON.parse(row.value) as Partial<ConcurrencyConfig>) };
      } catch { /* fall through */ }
      return { ...DEFAULT_CONCURRENCY_CONFIG };
    }

    export async function saveConcurrencyConfig(config: ConcurrencyConfig): Promise<void> {
      await db.insert(settingsTable).values({ key: CONCURRENCY_CONFIG_KEY, value: JSON.stringify(config) })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value: JSON.stringify(config) } });
    }
  
