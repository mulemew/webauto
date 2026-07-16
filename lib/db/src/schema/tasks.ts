import { pgTable, text, serial, timestamp, jsonb, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  targetUrl: text("target_url").notNull(),
  // loginType is kept for backward compatibility with tasks created before the
  // "login-as-step" feature. New tasks leave this null and use an explicit
  // login step in the steps array instead.
  loginType: text("login_type"),
  steps: jsonb("steps"),
  cronExpression: text("cron_expression"),
  // Valid values: "idle" | "running" | "success" | "failed" | "needs_attention"
  status: text("status").notNull().default("idle"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  // Used by @after_completion: schedule — set to (finishedAt + delayMinutes) after each run
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  enabled: boolean("enabled").notNull().default(true),
  // Per-task browser backend override. null = use global Settings config.
  browserConfig: jsonb("browser_config"),
  // Cached exit-IP geolocation (country/flag/ISP) + a note of when it was resolved.
  // Computed in the background on create/update (and manual re-detect) so the task
  // list and detail card can show the flag without a live proxy lookup on every open.
  exitGeo: jsonb("exit_geo"),
  // Auto-retry after a failed run. null/0 = no retry (wait for the next schedule).
  retryCount: integer("retry_count"),
  retryIntervalMinutes: integer("retry_interval_minutes"),
  // How many retries the CURRENT failure streak has already used; reset on success.
  retryAttempt: integer("retry_attempt").notNull().default(0),
});

export const insertTaskSchema = createInsertSchema(tasksTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;
