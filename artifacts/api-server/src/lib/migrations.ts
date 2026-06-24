import { pool } from "@workspace/db";
  import { logger } from "./logger";

  const SQL = `
  CREATE TABLE IF NOT EXISTS "tasks" (
    "id"              serial      PRIMARY KEY,
    "name"            text        NOT NULL,
    "target_url"      text        NOT NULL,
    "login_type"      text        NOT NULL DEFAULT 'form',
    "steps"           jsonb,
    "cron_expression" text,
    "status"          text        NOT NULL DEFAULT 'idle',
    "last_run_at"     timestamptz,
    "created_at"      timestamptz NOT NULL DEFAULT now(),
    "updated_at"      timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "credentials" (
    "id"             serial  PRIMARY KEY,
    "task_id"        integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
    "encrypted_data" text    NOT NULL,
    "created_at"     timestamptz NOT NULL DEFAULT now(),
    "updated_at"     timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "logs" (
    "id"              serial  PRIMARY KEY,
    "task_id"         integer NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
    "run_at"          timestamptz NOT NULL DEFAULT now(),
    "success"         boolean NOT NULL DEFAULT false,
    "message"         text    NOT NULL DEFAULT '',
    "screenshot_path" text,
    "duration_ms"     integer,
    "created_at"      timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT true;
    ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "next_run_at" timestamptz;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "login_type" text;
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "triggered_by" text;
  ALTER TABLE "logs"  ADD COLUMN IF NOT EXISTS "triggered_by" text;
  ALTER TABLE "logs"  ADD COLUMN IF NOT EXISTS "duration_ms"  integer;
  ALTER TABLE "logs"  ADD COLUMN IF NOT EXISTS "step_logs"    jsonb;
  ALTER TABLE "saved_credentials" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();
  ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "browser_config" jsonb;
    CREATE TABLE IF NOT EXISTS "sessions" (
    "token"      text        PRIMARY KEY,
    "expires_at" timestamptz NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "settings" (
    "key"        text PRIMARY KEY,
    "value"      text        NOT NULL,
    "updated_at" timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS "saved_credentials" (
    "id"             serial      PRIMARY KEY,
    "name"           text        NOT NULL,
    "username"       text        NOT NULL,
    "encrypted_data" text        NOT NULL,
    "created_at"     timestamptz NOT NULL DEFAULT now(),
    "updated_at"     timestamptz NOT NULL DEFAULT now()
  );
  `;

  export async function runMigrations(): Promise<void> {
    logger.info("Running database migrations...");
    const client = await pool.connect();
    try {
      await client.query(SQL);
      logger.info("Database migrations complete.");
    } finally {
      client.release();
    }
  }
  