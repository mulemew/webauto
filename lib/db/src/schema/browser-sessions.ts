import { pgTable, text, serial, timestamp, jsonb, integer, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Persisted browser sessions (cookies + localStorage) for "cookie mode" logins.
 *
 * When a login step enables cookie mode, the authenticated browser storage
 * state (cookies + origins/localStorage, Playwright storageState format) is
 * saved here after a successful login. On the next run, the runner restores
 * this state into a fresh browser context so the task can skip logging in
 * again while the session is still valid.
 *
 * One row per (taskId, sessionKey). sessionKey lets a single task keep more
 * than one persisted identity if ever needed; it defaults to "default".
 */
export const browserSessionsTable = pgTable(
  "browser_sessions",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id").notNull(),
    sessionKey: text("session_key").notNull().default("default"),
    // Playwright storageState() shape: { cookies: [...], origins: [...] }
    storageState: jsonb("storage_state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => ({
    taskKeyUnique: uniqueIndex("browser_sessions_task_key_unique").on(table.taskId, table.sessionKey),
  }),
);

export type BrowserSession = typeof browserSessionsTable.$inferSelect;
