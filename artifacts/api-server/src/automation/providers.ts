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

// v2: the v1 guard was "only if the table is EMPTY", which skipped everything when the
// user had already added even one provider by hand. v2 fills PER-TYPE gaps instead.
const SEED_FLAG_KEY = "providersSeededV2";

/** One-time migration: for every backend TYPE actually in use (Settings default + each
 *  task's override), create a provider IF none of that type exists yet — so the page
 *  reflects your real backends. Idempotent per type; guarded by a flag so it runs once. */
export async function seedProvidersFromSettings(): Promise<void> {
  try {
    const [flag] = await db.select().from(settingsTable).where(eq(settingsTable.key, SEED_FLAG_KEY));
    if (flag) return;

    const cfg = await loadBrowserConfig();
    const types = new Set<string>([cfg.provider ?? "playwright"]);
    const tasks = await db.select({ bc: tasksTable.browserConfig }).from(tasksTable);
    for (const t of tasks) {
      const p = (t.bc as { provider?: string } | null)?.provider;
      if (p) types.add(p);
    }
    // Types that ALREADY have a provider — don't duplicate those (e.g. a hand-added fox).
    const existing = await db.select({ type: providersTable.type }).from(providersTable);
    const have = new Set(existing.map((r) => r.type));

    // Resolve each type's backend URL: sb/camoufox behind their sidecar env URLs;
    // playwright/puppeteer use the Settings wsEndpoint (or BROWSERLESS_URL).
    const urlFor = (type: string): string => {
      if (type === "seleniumbase") return (process.env.CF_PROXY_URL ?? "http://cf-proxy:7317").replace(/\/$/, "");
      if (type === "camoufox") return (process.env.CAMOUFOX_URL ?? "http://camoufox-proxy:7318").replace(/\/$/, "");
      return ((cfg.wsEndpoint || process.env.BROWSERLESS_URL) ?? "").replace(/\/$/, "");
    };
    const conc = Math.max(1, (await loadConcurrencyConfig()).maxConcurrent);
    const sc = cfg as { stealth?: boolean; blockAds?: boolean; ignoreHTTPS?: boolean; sessionTimeoutMs?: number; viewportWidth?: number; viewportHeight?: number };
    logger.info({ inUse: [...types], alreadyHave: [...have] }, "seedProvidersFromSettings: filling per-type gaps");
    for (const type of types) {
      if (have.has(type)) continue; // this type already has a provider
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
    await db.insert(settingsTable).values({ key: SEED_FLAG_KEY, value: "1" })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: "1" } });
  } catch (err) {
    logger.warn({ err }, "seedProvidersFromSettings failed");
  }
}

// v2: re-run after the fixed seed (v1 may have run with no providers to bind to).
const BIND_FLAG_KEY = "tasksBoundToProvidersV2";

/** One-time migration: bind existing tasks to the provider matching their current engine
 *  type, so you don't have to open each task and pick one. Only binds when there is
 *  EXACTLY ONE enabled provider of that type (no ambiguity) and the task isn't already
 *  bound. Runs once ever (its own flag), independent of the seed. */
export async function autoBindTasksToProviders(): Promise<void> {
  try {
    const [flag] = await db.select().from(settingsTable).where(eq(settingsTable.key, BIND_FLAG_KEY));
    if (flag) return;

    const provs = await db.select().from(providersTable).where(eq(providersTable.enabled, true));
    // type → the single provider of that type (skip types with 0 or >1 to avoid guessing).
    const byType = new Map<string, number>();
    const seenTwice = new Set<string>();
    for (const p of provs) {
      if (byType.has(p.type)) { seenTwice.add(p.type); continue; }
      byType.set(p.type, p.id);
    }
    for (const t of seenTwice) byType.delete(t);

    if (byType.size > 0) {
      const tasks = await db.select().from(tasksTable);
      let bound = 0;
      for (const t of tasks) {
        const bc = (t.browserConfig ?? null) as { provider?: string; providerId?: number | null } | null;
        if (!bc || bc.providerId != null) continue;
        const pid = bc.provider ? byType.get(bc.provider) : undefined;
        if (pid) {
          await db.update(tasksTable).set({ browserConfig: { ...bc, providerId: pid } }).where(eq(tasksTable.id, t.id));
          bound++;
        }
      }
      if (bound) logger.info({ bound }, "Auto-bound existing tasks to matching providers");
    }
    await db.insert(settingsTable).values({ key: BIND_FLAG_KEY, value: "1" })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: "1" } });
  } catch (err) {
    logger.warn({ err }, "autoBindTasksToProviders failed");
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
