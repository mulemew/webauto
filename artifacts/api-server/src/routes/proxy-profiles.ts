import { Router, type IRouter } from "express";
import { db, proxyProfilesTable, tasksTable, eq } from "@workspace/db";
import { logger } from "../lib/logger";
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

router.get("/proxy-profiles", async (_req, res): Promise<void> => {
  const rows = await db.select().from(proxyProfilesTable).orderBy(proxyProfilesTable.name);
  res.json(rows);
});

router.post("/proxy-profiles", async (req, res): Promise<void> => {
  const body = CreateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid input" }); return; }
  const [row] = await db.insert(proxyProfilesTable)
    .values({ name: body.data.name, url: body.data.url.trim() })
    .returning();
  logger.info({ id: row.id, name: row.name }, "Proxy profile created");
  res.status(201).json(row);
});

router.put("/proxy-profiles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = UpdateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid input" }); return; }
  const update: Partial<{ name: string; url: string }> = {};
  if (body.data.name !== undefined) update.name = body.data.name;
  if (body.data.url !== undefined) update.url = body.data.url.trim();
  const [updated] = await db.update(proxyProfilesTable).set(update).where(eq(proxyProfilesTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.delete("/proxy-profiles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.update(tasksTable).set({ proxyProfileId: null }).where(eq(tasksTable.proxyProfileId, id));
  await db.delete(proxyProfilesTable).where(eq(proxyProfilesTable.id, id));
  res.status(204).end();
});

export default router;
