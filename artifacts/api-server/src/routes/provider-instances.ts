import { Router, type IRouter } from "express";
import { db, providerInstancesTable, eq } from "@workspace/db";
import { logger } from "../lib/logger";
import { checkInstanceHealth, refreshInstanceHealth, instanceBusyCount } from "../automation/provider-instances";
import { z } from "zod";

const router: IRouter = Router();

const Family = z.enum(["browserless", "sb", "fox"]);

// browserless instances are CDP ws endpoints; sb/fox are http(s) sidecar URLs.
const CreateBody = z
  .object({
    name: z.string().min(1),
    family: Family,
    subtype: z.string().optional().default(""),
    url: z.string().min(1),
    enabled: z.boolean().optional().default(true),
  })
  .refine((b) => (b.family === "browserless" ? /^wss?:\/\//i.test(b.url) : /^https?:\/\//i.test(b.url)), {
    message: "browserless URL must be ws(s)://; sb/fox URL must be http(s)://",
  })
  .refine((b) => (b.family === "browserless" ? b.subtype === "playwright" || b.subtype === "puppeteer" : true), {
    message: "browserless instances need subtype playwright or puppeteer",
  });

const UpdateBody = z.object({
  name: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

router.get("/provider-instances", async (_req, res): Promise<void> => {
  const rows = await db.select().from(providerInstancesTable).orderBy(providerInstancesTable.family, providerInstancesTable.name);
  res.json(rows.map((r) => ({ ...r, busy: instanceBusyCount(r.id) })));
});

router.post("/provider-instances", async (req, res): Promise<void> => {
  const body = CreateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid input" }); return; }
  const d = body.data;
  const subtype = d.family === "browserless" ? d.subtype : "";
  // Probe health on create so the row is immediately eligible (or shows why not).
  const { healthy, error } = await checkInstanceHealth({ family: d.family, url: d.url.trim() });
  const [row] = await db
    .insert(providerInstancesTable)
    .values({ name: d.name, family: d.family, subtype, url: d.url.trim(), enabled: d.enabled, healthy, lastError: error, lastCheckedAt: new Date() })
    .returning();
  logger.info({ id: row.id, name: row.name, family: row.family }, "Provider instance created");
  res.status(201).json(row);
});

router.put("/provider-instances/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = UpdateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid input" }); return; }
  const update: Partial<{ name: string; url: string; enabled: boolean }> = {};
  if (body.data.name !== undefined) update.name = body.data.name;
  if (body.data.url !== undefined) update.url = body.data.url.trim();
  if (body.data.enabled !== undefined) update.enabled = body.data.enabled;
  const [updated] = await db.update(providerInstancesTable).set(update).where(eq(providerInstancesTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  // A changed URL / re-enable should re-probe so eligibility reflects reality.
  const refreshed = await refreshInstanceHealth(id);
  res.json(refreshed ?? updated);
});

router.post("/provider-instances/:id/health", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const updated = await refreshInstanceHealth(id);
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.post("/provider-instances/health-all", async (_req, res): Promise<void> => {
  const rows = await db.select().from(providerInstancesTable);
  await Promise.all(rows.map((r) => refreshInstanceHealth(r.id)));
  const fresh = await db.select().from(providerInstancesTable).orderBy(providerInstancesTable.family, providerInstancesTable.name);
  res.json(fresh.map((r) => ({ ...r, busy: instanceBusyCount(r.id) })));
});

router.delete("/provider-instances/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(providerInstancesTable).where(eq(providerInstancesTable.id, id));
  res.status(204).end();
});

export default router;
