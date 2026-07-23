import { db, providersTable, eq } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * Named browser backends (the "Providers" page). A task picks one by id
 * (browserConfig.providerId); the runner uses that provider's type + url and enforces
 * the provider's OWN concurrency limit. No provider selected → the Settings default
 * backend is used (backward compatible).
 */
export type ResolvedProvider = { id: number; name: string; type: string; url: string; concurrency: number };

/** Load a provider by id (only if enabled). Null when missing/disabled → caller falls
 *  back to the Settings default backend. */
export async function resolveProvider(providerId: number | null | undefined): Promise<ResolvedProvider | null> {
  if (!providerId) return null;
  const [p] = await db.select().from(providersTable).where(eq(providersTable.id, providerId));
  if (!p || !p.enabled) return null;
  return { id: p.id, name: p.name, type: p.type, url: p.url, concurrency: Math.max(1, p.concurrency) };
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
