import { Router, type IRouter } from "express";
import { db, fingerprintProfilesTable, tasksTable, eq, sql } from "@workspace/db";
import { logger } from "../lib/logger";
import { z } from "zod";

const router: IRouter = Router();

const OS = z.enum(["windows", "mac", "linux"]);

const CreateBody = z.object({
  name: z.string().min(1),
  os: OS,
  config: z.record(z.string(), z.unknown()).nullable().optional(),
});

const UpdateBody = z.object({
  name: z.string().min(1).optional(),
  os: OS.optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
});

router.get("/fingerprint-profiles", async (_req, res): Promise<void> => {
  const rows = await db.select().from(fingerprintProfilesTable).orderBy(fingerprintProfilesTable.name);
  res.json(rows);
});

// Proxy to the camoufox-proxy sidecar's /generate (the browser is internal-only). The UI
// calls this from the "Generate" button; save the returned `config` into a profile.
router.get("/fingerprint-profiles/generate", async (req, res): Promise<void> => {
  const os = String(req.query.os ?? "windows");
  const source = String(req.query.source ?? "browserforge");
  const base = (process.env.CAMOUFOX_URL ?? "http://camoufox-proxy:7318").replace(/\/$/, "");
  try {
    const r = await fetch(`${base}/generate?os=${encodeURIComponent(os)}&source=${encodeURIComponent(source)}`);
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `camoufox-proxy unreachable: ${err instanceof Error ? err.message : String(err)}` });
  }
});

router.post("/fingerprint-profiles", async (req, res): Promise<void> => {
  const body = CreateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Invalid input" }); return; }
  const [row] = await db.insert(fingerprintProfilesTable)
    .values({ name: body.data.name, os: body.data.os, config: body.data.config ?? null })
    .returning();
  logger.info({ id: row.id, name: row.name }, "Fingerprint profile created");
  res.status(201).json(row);
});

router.put("/fingerprint-profiles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = UpdateBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Invalid input" }); return; }
  const update: Partial<{ name: string; os: string; config: unknown }> = {};
  if (body.data.name !== undefined) update.name = body.data.name;
  if (body.data.os !== undefined) update.os = body.data.os;
  if (body.data.config !== undefined) update.config = body.data.config;
  const [updated] = await db.update(fingerprintProfilesTable).set(update).where(eq(fingerprintProfilesTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.delete("/fingerprint-profiles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  // Clear the reference from every task's browserConfig (jsonb — the real ref) so they
  // fall back to the inline/honest fingerprint. The runner guards a dangling id anyway.
  const match = sql`${tasksTable.browserConfig}->>'fingerprintProfileId' = ${String(id)}`;
  const affected = await db.select({ id: tasksTable.id }).from(tasksTable).where(match);
  await db.update(tasksTable).set({ browserConfig: sql`${tasksTable.browserConfig} - 'fingerprintProfileId'`, fingerprintProfileId: null }).where(match);
  await db.delete(fingerprintProfilesTable).where(eq(fingerprintProfilesTable.id, id));
  res.json({ deleted: true, affectedTasks: affected.length });
});

export default router;
