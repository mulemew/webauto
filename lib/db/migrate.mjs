#!/usr/bin/env node
  /**
   * Production migration script — creates all tables using raw SQL.
   * Uses CREATE TABLE IF NOT EXISTS so it is safe to re-run at any time.
   * No drizzle-kit required at runtime.
   */
  import pg from "pg";

  const { Client } = pg;

  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });

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

  -- Additive migrations (safe to re-run via IF NOT EXISTS / IF NOT EXISTS)
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_run_at timestamptz;
    ALTER TABLE logs ADD COLUMN IF NOT EXISTS triggered_by text;
    ALTER TABLE logs ADD COLUMN IF NOT EXISTS step_logs jsonb;
    ALTER TABLE logs ADD COLUMN IF NOT EXISTS duration_ms integer;

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

  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS browser_config jsonb;

  CREATE TABLE IF NOT EXISTS "browser_sessions" (
    "id"            serial      PRIMARY KEY,
    "task_id"       integer     NOT NULL,
    "session_key"   text        NOT NULL DEFAULT 'default',
    "storage_state" jsonb       NOT NULL,
    "created_at"    timestamptz NOT NULL DEFAULT now(),
    "updated_at"    timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "browser_sessions_task_key_unique" ON "browser_sessions" ("task_id", "session_key");
  `;

  try {
    await client.connect();
    console.log("Connected. Running migrations...");
    await client.query(SQL);
    console.log("Migrations complete.");
    await client.end();
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err.message);
    await client.end().catch(() => {});
    process.exit(1);
  }
 