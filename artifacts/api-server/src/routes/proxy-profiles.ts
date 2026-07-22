import { Router, type IRouter } from "express";
import { db, proxyProfilesTable, tasksTable, eq } from "@workspace/db";
import { logger } from "../lib/logger";
import { resolveExitGeo } from "./tasks";
import { resolveProxyType } from "../automation/proxy-manager";
import { z } from "zod";

const router: IRouter = Router();

// Accept a proxy URL with an explicit supported scheme. WARP is NOT a URL and is
// handled separately, so it is rejected here.
const ProxyUrl = z.string().min(1).refine(
  (u) => /^(https?|socks5|socks5h|socks4|vless|vmess|trojan|ss|hysteria2|hy2|tuic):\/\//i.test(u.trim()),
  { message: "Proxy URL must start with a supported scheme (http/https/socks5/…)" },
);

const CreateBody = z.object({ name: z.string().min(1), url: ProxyUrl });
const UpdateBody = z.object({ name: z.string().min(1).optional(), url: ProxyUrl.optional() });

/** Resolve a profile's exit geo through its own proxy URL (best-effort, never throws). */
async function resolveProfileGeo(url: string): Promise<unknown> {
  try {
    // Canonicalise the scheme the same way the runner does — e.g. hysteria2:// → "hy2",
    // socks5h → "socks5" — so sing-box's buildOutbound recognises it. A raw scheme like
    // "hysteria2" is NOT a valid sing-box proxy type and would fail the geo check.
    const proxyType = resolveProxyType({ proxyUrl: url }) ?? undefined;
    return await resolveExitGeo({ proxyUrl: url, proxyType });
  } catch (err) {
    return { configured: true, ok: false, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() };
  }
}

/** Recompute + persist a single profile's exit geo. Returns the updated row, or null if gone. */
async function refreshProfileGeo(id: number) {
  const [row] = await db.select().from(proxyProfilesTable).where(eq(proxyProfilesTable.id, id));
  if (!row) return null;
  const geo = await resolveProfileGeo(row.url);
  const [updated] = await db.update(proxyProfilesTable)
    .set({ exitGeo: geo, geoUpdatedAt: new Date() })
    .where(eq(proxyProfilesTable.id, id))
    .returning();
  return updated ?? null;
}

router.get("/proxy-profiles", async (_req, res): Promise<void> => {
  const rows = await db.select().from(proxyProfilesTable).orderBy(proxyProfilesTable.name);
  res.json(rows);
});

router.post("/proxy-profiles", async (req, res): Promise<void> => {
  const body = CreateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid input" }); return; }
  const url = body.data.url.trim();
  // Auto-test the exit IP/geo through the proxy and store it, so task pages read it
  // directly (list flag, edit card, detail) without re-querying live.
  const geo = await resolveProfileGeo(url);
  const [row] = await db.insert(proxyProfilesTable)
    .values({ name: body.data.name, url, exitGeo: geo, geoUpdatedAt: new Date() })
    .returning();
  logger.info({ id: row.id, name: row.name }, "Proxy profile created");
  res.status(201).json(row);
});

router.put("/proxy-profiles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = UpdateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid input" }); return; }
  const update: Partial<{ name: string; url: string; exitGeo: unknown; geoUpdatedAt: Date }> = {};
  if (body.data.name !== undefined) update.name = body.data.name;
  if (body.data.url !== undefined) {
    update.url = body.data.url.trim();
    // URL changed → the old exit geo no longer applies; re-test through the new proxy.
    update.exitGeo = await resolveProfileGeo(update.url);
    update.geoUpdatedAt = new Date();
  }
  const [updated] = await db.update(proxyProfilesTable).set(update).where(eq(proxyProfilesTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

// Re-fetch a single profile's exit geo on demand (refresh button).
router.post("/proxy-profiles/:id/refresh", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const updated = await refreshProfileGeo(id);
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

// Re-fetch every profile's exit geo (refresh-all button). Bounded concurrency so a
// large fleet doesn't open dozens of local proxies at once. Returns the updated rows.
router.post("/proxy-profiles/refresh-all", async (_req, res): Promise<void> => {
  const rows = await db.select().from(proxyProfilesTable).orderBy(proxyProfilesTable.name);
  const CONCURRENCY = 6;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    await Promise.all(rows.slice(i, i + CONCURRENCY).map((r) => refreshProfileGeo(r.id)));
  }
  const fresh = await db.select().from(proxyProfilesTable).orderBy(proxyProfilesTable.name);
  res.json(fresh);
});

router.delete("/proxy-profiles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.update(tasksTable).set({ proxyProfileId: null }).where(eq(tasksTable.proxyProfileId, id));
  await db.delete(proxyProfilesTable).where(eq(proxyProfilesTable.id, id));
  res.status(204).end();
});

export default router;
