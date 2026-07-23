import { db, providerInstancesTable, eq } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * Provider-instance registry + auto-distribution.
 *
 * A task's provider maps to a FAMILY; the runner asks pickInstance() for the least-busy
 * healthy registered instance of that family and routes the session to its URL, so
 * concurrent tasks land on DIFFERENT backend containers (real parallelism). When no
 * instance is registered, the runner falls back to the env default — nothing changes.
 */
export type ProviderFamily = "browserless" | "sb" | "fox";

/** Map a task's browser provider to the instance family + subtype it draws from. */
export function providerToFamily(provider: string | undefined): { family: ProviderFamily; subtype: string } | null {
  switch (provider) {
    case "playwright": return { family: "browserless", subtype: "playwright" };
    case "puppeteer": return { family: "browserless", subtype: "puppeteer" };
    case "seleniumbase": return { family: "sb", subtype: "" };
    case "camoufox": return { family: "fox", subtype: "" };
    default: return null;
  }
}

// Live session counts per instance id, so pickInstance can spread load ("least-busy").
// In-memory: a restart resets counts, which is fine — nothing is running then anyway.
const _busy = new Map<number, number>();
// Round-robin cursor per family:subtype to break ties fairly across equal-load instances.
const _rr = new Map<string, number>();

export function instanceBusyCount(id: number): number {
  return _busy.get(id) ?? 0;
}

/** Pick the least-busy healthy+enabled instance for a family/subtype, or null if none are
 *  registered/eligible (caller then uses the env default). Increments the busy count. */
export async function pickInstance(
  family: ProviderFamily,
  subtype: string,
): Promise<{ id: number; url: string; name: string } | null> {
  const rows = await db.select().from(providerInstancesTable).where(eq(providerInstancesTable.family, family));
  const eligible = rows.filter(
    (r) => r.enabled && r.healthy === true && (family !== "browserless" || r.subtype === subtype),
  );
  if (eligible.length === 0) return null;

  const minBusy = Math.min(...eligible.map((r) => instanceBusyCount(r.id)));
  const leastBusy = eligible.filter((r) => instanceBusyCount(r.id) === minBusy);
  // Round-robin among the equally-least-busy so a tie doesn't always hit the same one.
  const key = `${family}:${subtype}`;
  const cursor = (_rr.get(key) ?? 0) % leastBusy.length;
  _rr.set(key, cursor + 1);
  const chosen = leastBusy[cursor];

  _busy.set(chosen.id, instanceBusyCount(chosen.id) + 1);
  logger.info({ family, subtype, instance: chosen.name, busy: instanceBusyCount(chosen.id) }, "Assigned provider instance");
  return { id: chosen.id, url: chosen.url, name: chosen.name };
}

/** Release a session's hold on an instance (call once when the task run finishes). */
export function releaseInstance(id: number): void {
  _busy.set(id, Math.max(0, instanceBusyCount(id) - 1));
}

/** Probe one instance. sb/fox expose GET /health; browserless (CDP ws) is probed via its
 *  http /json/version. Best-effort with a short timeout. */
export async function checkInstanceHealth(inst: { family: string; url: string }): Promise<{ healthy: boolean; error: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    if (inst.family === "browserless") {
      // ws://host:port/…?token=… → http(s)://host:port/json/version?token=… . browserless
      // often gates this behind a token, so ANY HTTP response means the server is up and
      // reachable — only a network error (refused/timeout) is unhealthy.
      const u = new URL(inst.url);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:";
      u.pathname = "/json/version";
      await fetch(u.toString(), { signal: ctrl.signal });
      return { healthy: true, error: null };
    }
    // sb (cf-proxy) / fox (camoufox-proxy): GET /health must return 2xx.
    const res = await fetch(`${inst.url.replace(/\/$/, "")}/health`, { signal: ctrl.signal });
    if (!res.ok) return { healthy: false, error: `HTTP ${res.status}` };
    return { healthy: true, error: null };
  } catch (err) {
    return { healthy: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Recompute + persist one instance's health. Returns the updated row. */
export async function refreshInstanceHealth(id: number) {
  const [inst] = await db.select().from(providerInstancesTable).where(eq(providerInstancesTable.id, id));
  if (!inst) return null;
  const { healthy, error } = await checkInstanceHealth(inst);
  const [updated] = await db
    .update(providerInstancesTable)
    .set({ healthy, lastError: error, lastCheckedAt: new Date() })
    .where(eq(providerInstancesTable.id, id))
    .returning();
  return updated ?? null;
}

/** Poll every enabled instance's health on an interval so selection only ever hands out
 *  reachable backends. Safe to call once at startup. */
export function startInstanceHealthPolling(): void {
  const tick = async () => {
    try {
      const rows = await db.select().from(providerInstancesTable);
      await Promise.all(
        rows.filter((r) => r.enabled).map(async (r) => {
          const { healthy, error } = await checkInstanceHealth(r);
          await db
            .update(providerInstancesTable)
            .set({ healthy, lastError: error, lastCheckedAt: new Date() })
            .where(eq(providerInstancesTable.id, r.id))
            .catch(() => {});
        }),
      );
    } catch (err) {
      logger.warn({ err }, "Provider-instance health poll failed");
    }
  };
  void tick();
  setInterval(() => void tick(), 60_000).unref();
}
