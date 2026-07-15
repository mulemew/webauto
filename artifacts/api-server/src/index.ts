// Must run before any other import that reads env vars
  import { ensureSecrets } from "./lib/auto-secrets";
  ensureSecrets();

  import app from "./app";
  import { logger } from "./lib/logger";
  import { initScheduler } from "./scheduler";
  import { backfillExitGeo } from "./routes/tasks";
  import { runMigrations } from "./lib/migrations";
  import { hasStoredPassword, initPassword } from "./lib/passwordStore";
  import { pool } from "@workspace/db";

  const rawPort = process.env["PORT"];

  if (!rawPort) {
    throw new Error("PORT environment variable is required but was not provided.");
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const keyBuf = Buffer.from(process.env.ENCRYPTION_KEY!, "hex");
  if (keyBuf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Got ${keyBuf.length} bytes.`
    );
  }

  await runMigrations();

  // Ensure columns added in newer versions exist on older DB deployments.
  // ALTER TABLE … ADD COLUMN IF NOT EXISTS is idempotent and safe on every startup.
  try {
    await pool.query(`
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS triggered_by text;
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS step_logs jsonb;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    `);
    logger.info("Schema column migrations applied");
  } catch (err) {
    logger.warn({ err }, "Schema column migration warning (non-fatal)");
  }

  const envPassword = process.env.DASHBOARD_PASSWORD;
  if (envPassword && !(await hasStoredPassword())) {
    const result = await initPassword(envPassword);
    if (result.ok) {
      logger.info("DASHBOARD_PASSWORD env var detected — password initialised in database automatically");
    } else {
      logger.warn({ error: result.error }, "DASHBOARD_PASSWORD env var present but initPassword failed");
    }
  }

  app.listen(port, async (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
    await initScheduler();
    // Fill exit-geo for pre-existing tasks in the background (non-blocking).
    void backfillExitGeo();
  });
  