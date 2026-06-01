import { Router, type IRouter } from "express";
  import { db, savedCredentialsTable, eq } from "@workspace/db";
  import { encrypt, decrypt } from "../lib/encryption";
  import { logger } from "../lib/logger";
  import { z } from "zod";

  const router: IRouter = Router();

  const CreateBody = z.object({
    name: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    totpSecret: z.string().optional().nullable(),
  });

  const UpdateBody = z.object({
    name: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().optional(),
    totpSecret: z.string().optional().nullable(),
  });

  router.get("/saved-credentials", async (req, res): Promise<void> => {
    const rows = await db
      .select({
        id: savedCredentialsTable.id,
        name: savedCredentialsTable.name,
        username: savedCredentialsTable.username,
        createdAt: savedCredentialsTable.createdAt,
        updatedAt: savedCredentialsTable.updatedAt,
      })
      .from(savedCredentialsTable)
      .orderBy(savedCredentialsTable.name);
    res.json(rows);
  });

  router.post("/saved-credentials", async (req, res): Promise<void> => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { name, username, password, totpSecret } = body.data;
    const encryptedData = encrypt(JSON.stringify({ password, totpSecret: totpSecret ?? null }));
    const [row] = await db
      .insert(savedCredentialsTable)
      .values({ name, username, encryptedData })
      .returning();
    logger.info({ id: row.id, name: row.name }, "Saved credential created");
    res.status(201).json({
      id: row.id,
      name: row.name,
      username: row.username,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  router.put("/saved-credentials/:id", async (req, res): Promise<void> => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const body = UpdateBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const [existing] = await db
      .select()
      .from(savedCredentialsTable)
      .where(eq(savedCredentialsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const update: Partial<{ name: string; username: string; encryptedData: string }> = {};
    if (body.data.name !== undefined) update.name = body.data.name;
    if (body.data.username !== undefined) update.username = body.data.username;
    if (body.data.password !== undefined && body.data.password.length > 0) {
      let prevDecrypted: { password: string; totpSecret?: string | null } = { password: "", totpSecret: null };
      try {
        prevDecrypted = JSON.parse(decrypt(existing.encryptedData));
      } catch {}
      update.encryptedData = encrypt(
        JSON.stringify({
          password: body.data.password,
          totpSecret: body.data.totpSecret !== undefined ? body.data.totpSecret : prevDecrypted.totpSecret,
        }),
      );
    } else if (body.data.totpSecret !== undefined) {
      let prevDecrypted: { password: string; totpSecret?: string | null } = { password: "", totpSecret: null };
      try {
        prevDecrypted = JSON.parse(decrypt(existing.encryptedData));
      } catch {}
      update.encryptedData = encrypt(
        JSON.stringify({ password: prevDecrypted.password, totpSecret: body.data.totpSecret }),
      );
    }
    const [updated] = await db
      .update(savedCredentialsTable)
      .set(update)
      .where(eq(savedCredentialsTable.id, id))
      .returning();
    res.json({
      id: updated.id,
      name: updated.name,
      username: updated.username,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
  });

  router.delete("/saved-credentials/:id", async (req, res): Promise<void> => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db.delete(savedCredentialsTable).where(eq(savedCredentialsTable.id, id));
    logger.info({ id }, "Saved credential deleted");
    res.status(204).end();
  });

  router.get("/saved-credentials/:id/reveal", async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.select().from(savedCredentialsTable).where(eq(savedCredentialsTable.id, id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    try {
      const { password, totpSecret } = JSON.parse(decrypt(row.encryptedData)) as { password: string; totpSecret?: string | null };
      res.json({ password, totpSecret: totpSecret ?? null });
    } catch {
      res.status(500).json({ error: "Failed to decrypt" });
    }
  });

  export default router;
  