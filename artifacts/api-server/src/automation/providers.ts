import { db, providersTable, settingsTable, tasksTable, eq, PROVIDER_TYPE_PARAMS } from "@workspace/db";
import { logger } from "../lib/logger";
import { loadBrowserConfig, loadConcurrencyConfig } from "../lib/appSettings";

/**
 * Named browser backends (the "Providers" page). A task picks one by id
 * (browserConfig.providerId); the runner uses that provider's type + url and enforces
 * the provider's OWN concurrency limit. No provider selected → the Settings default
 * backend is used (backward compatible).
 */
export type ResolvedProvider = {
  id: number; name: string; type: string; url: string; concurrency: number;
  stealth: boolean | null; blockAds: boolean | null; ignoreHttps: boolean | null;
  sessionTimeoutMs: number | null; viewportWidth: number | null; viewportHeight: number | null;
};

/** Load a provider by id (only if enabled). Null when missing/disabled → caller falls
 *  back to the Settings default backend. */
export async function resolveProvider(providerId: number | null | undefined): Promise<ResolvedProvider | null> {
  if (!providerId) return null;
  const [p] = await db.select().from(providersTable).where(eq(providersTable.id, providerId));
  if (!p || !p.enabled) return null;
  return {
    id: p.id, name: p.name, type: p.type, url: p.url, concurrency: Math.max(1, p.concurrency),
    stealth: p.stealth, blockAds: p.blockAds, ignoreHttps: p.ignoreHttps,
    sessionTimeoutMs: p.sessionTimeoutMs, viewportWidth: p.viewportWidth, viewportHeight: p.viewportHeight,
  };
}

/** Probe one provider. playwright/puppeteer are CDP ws endpoints (reachable = healthy,
 *  they're often token-gated); seleniumbase/camoufox expose GET /health. */
export async function checkProviderHealth(p: { type: string; url: string }): Promise<{ healthy: boolean; error: string | null }> {
  const url = (p.url ?? "").trim();
  if (!url) return { healthy: false, error: "no url" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    if (p.type === "playwright" || p.type === "puppeteer") {
      const u = new URL(url);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:";
      u.pathname = "/json/version";
      await fetch(u.toString(), { signal: ctrl.signal });
      return { healthy: true, error: null };
    }
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: ctrl.signal });
    if (!res.ok) return { healthy: false, error: `HTTP ${res.status}` };
    return { healthy: true, error: null };
  } catch (err) {
    return { healthy: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Recompute + persist one provider's health. */
export async function refreshProviderHealth(id: number) {
  const [p] = await db.select().from(providersTable).where(eq(providersTable.id, id));
  if (!p) return null;
  const { healthy, error } = await checkProviderHealth(p);
  const [updated] = await db
    .update(providersTable)
    .set({ healthy, lastError: error, lastCheckedAt: new Date() })
    .where(eq(providersTable.id, id))
    .returning();
  return updated ?? null;
}

const SEED_FLAG_KEY = "providersSeeded";

/** One-time migration: turn the CURRENT Settings backend into a named provider so the
 *  Providers page isn't empty after the config moved out of Settings. Runs once ever
 *  (a settings flag guards it), so later manual deletions aren't undone. */
export async function seedProvidersFromSettings(): Promise<void> {
  try {
    const [flag] = await db.select().from(settingsTable).where(eq(settingsTable.key, SEED_FLAG_KEY));
    if (flag) return;

    const existing = await db.select({ id: providersTable.id }).from(providersTable).limit(1);
    if (existing.length === 0) {
      const cfg = await loadBrowserConfig();
      // Every backend TYPE actually in use = the Settings default + each task's override.
      const types = new Set<string>([cfg.provider ?? "playwright"]);
      const tasks = await db.select({ bc: tasksTable.browserConfig }).from(tasksTable);
      for (const t of tasks) {
        const p = (t.bc as { provider?: string } | null)?.provider;
        if (p) types.add(p);
      }
      // Resolve each type's backend URL: sb/camoufox behind their sidecar env URLs;
      // playwright/puppeteer use the Settings wsEndpoint (or BROWSERLESS_URL).
      const urlFor = (type: string): string => {
        if (type === "seleniumbase") return (process.env.CF_PROXY_URL ?? "http://cf-proxy:7317").replace(/\/$/, "");
        if (type === "camoufox") return (process.env.CAMOUFOX_URL ?? "http://camoufox-proxy:7318").replace(/\/$/, "");
        return ((cfg.wsEndpoint || process.env.BROWSERLESS_URL) ?? "").replace(/\/$/, "");
      };
      const conc = Math.max(1, (await loadConcurrencyConfig()).maxConcurrent);
      // Carry the Settings backend params so the seeded provider matches today's behaviour.
      const sc = cfg as { stealth?: boolean; blockAds?: boolean; ignoreHTTPS?: boolean; sessionTimeoutMs?: number; viewportWidth?: number; viewportHeight?: number };
      for (const type of types) {
        const url = urlFor(type);
        if (!url) continue;
        const caps = PROVIDER_TYPE_PARAMS[type] ?? { stealth: false, blockAds: false, ignoreHttps: false, sessionTimeout: false, viewport: false };
        const { healthy, error } = await checkProviderHealth({ type, url });
        await db.insert(providersTable).values({
          name: `Settings（${type}）`, type, url, concurrency: conc, enabled: true,
          stealth: caps.stealth ? (sc.stealth ?? null) : null,
          blockAds: caps.blockAds ? (sc.blockAds ?? null) : null,
          ignoreHttps: caps.ignoreHttps ? (sc.ignoreHTTPS ?? null) : null,
          sessionTimeoutMs: caps.sessionTimeout ? (sc.sessionTimeoutMs ?? null) : null,
          viewportWidth: caps.viewport ? (sc.viewportWidth ?? null) : null,
          viewportHeight: caps.viewport ? (sc.viewportHeight ?? null) : null,
          healthy, lastError: error, lastCheckedAt: new Date(),
        });
        logger.info({ type, url, concurrency: conc }, "Seeded provider from an in-use backend");
      }
    }
    await db.insert(settingsTable).values({ key: SEED_FLAG_KEY, value: "1" })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: "1" } });
  } catch (err) {
    logger.warn({ err }, "seedProvidersFromSettings failed");
  }
}

/** Poll every enabled provider's health so the page + selection reflect reachability. */
export function startProviderHealthPolling(): void {
  const tick = async () => {
    try {
      const rows = await db.select().from(providersTable);
      await Promise.all(
        rows.filter((r) => r.enabled).map(async (r) => {
          const { healthy, error } = await checkProviderHealth(r);
          await db.update(providersTable).set({ healthy, lastError: error, lastCheckedAt: new Date() }).where(eq(providersTable.id, r.id)).catch(() => {});
        }),
      );
    } catch (err) {
      logger.warn({ err }, "Provider health poll failed");
    }
  };
  void tick();
  setInterval(() => void tick(), 60_000).unref();
}
