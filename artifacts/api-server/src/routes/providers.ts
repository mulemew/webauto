import { Router, type IRouter } from "express";
import { db, providersTable, tasksTable, eq, sql } from "@workspace/db";
import { logger } from "../lib/logger";
import { checkProviderHealth, refreshProviderHealth } from "../automation/providers";
import { z } from "zod";

const router: IRouter = Router();

const Type = z.enum(["playwright", "puppeteer", "seleniumbase", "camoufox"]);

const CreateBody = z
  .object({
    name: z.string().min(1),
    type: Type,
    url: z.string().min(1),
    concurrency: z.number().int().min(1).max(64).optional().default(1),
    enabled: z.boolean().optional().default(true),
  })
  .refine((b) => (b.type === "playwright" || b.type === "puppeteer" ? /^wss?:\/\//i.test(b.url) : /^https?:\/\//i.test(b.url)), {
    message: "playwright/puppeteer URL must be ws(s)://; seleniumbase/camoufox URL must be http(s)://",
  });

const UpdateBody = z.object({
  name: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

router.get("/providers", async (_req, res): Promise<void> => {
  const rows = await db.select().from(providersTable).orderBy(providersTable.type, providersTable.name);
  res.json(rows);
});

router.post("/providers", async (req, res): Promise<void> => {
  const body = CreateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid input" }); return; }
  const d = body.data;
  const { healthy, error } = await checkProviderHealth({ type: d.type, url: d.url.trim() });
  const [row] = await db
    .insert(providersTable)
    .values({ name: d.name, type: d.type, url: d.url.trim(), concurrency: d.concurrency, enabled: d.enabled, healthy, lastError: error, lastCheckedAt: new Date() })
    .returning();
  logger.info({ id: row.id, name: row.name, type: row.type }, "Provider created");
  res.status(201).json(row);
});

router.put("/providers/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = UpdateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid input" }); return; }
  const update: Partial<{ name: string; url: string; concurrency: number; enabled: boolean }> = {};
  if (body.data.name !== undefined) update.name = body.data.name;
  if (body.data.url !== undefined) update.url = body.data.url.trim();
  if (body.data.concurrency !== undefined) update.concurrency = body.data.concurrency;
  if (body.data.enabled !== undefined) update.enabled = body.data.enabled;
  const [updated] = await db.update(providersTable).set(update).where(eq(providersTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  const refreshed = await refreshProviderHealth(id);
  res.json(refreshed ?? updated);
});

router.post("/providers/:id/health", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const updated = await refreshProviderHealth(id);
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.post("/providers/health-all", async (_req, res): Promise<void> => {
  const rows = await db.select().from(providersTable);
  await Promise.all(rows.map((r) => refreshProviderHealth(r.id)));
  const fresh = await db.select().from(providersTable).orderBy(providersTable.type, providersTable.name);
  res.json(fresh);
});

router.delete("/providers/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  // Clear the reference from any task's browserConfig so it falls back to the default.
  await db.update(tasksTable)
    .set({ browserConfig: sql`${tasksTable.browserConfig} - 'providerId'` })
    .where(sql`${tasksTable.browserConfig}->>'providerId' = ${String(id)}`);
  await db.delete(providersTable).where(eq(providersTable.id, id));
  res.status(204).end();
});

export default router;
