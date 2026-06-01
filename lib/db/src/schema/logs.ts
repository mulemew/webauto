import { pgTable, text, serial, integer, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";
  import { createInsertSchema } from "drizzle-zod";
  import { z } from "zod/v4";
  import { tasksTable } from "./tasks";

  export const logsTable = pgTable(
    "logs",
    {
      id: serial("id").primaryKey(),
      taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
      runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
      success: boolean("success").notNull().default(false),
      message: text("message").notNull().default(""),
      screenshotPath: text("screenshot_path"),
      durationMs: integer("duration_ms"),
      // 'manual' | 'cron' | 'dry_run' — null for old rows before this column was added
      triggeredBy: text("triggered_by"),
      // JSON array of per-step results: [{stepIndex, type, success, message, screenshotPath}]
      stepLogs: jsonb("step_logs"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
    index("logs_task_id_idx").on(table.taskId),
    index("logs_run_at_idx").on(table.runAt),
  ],
  );

  export const insertLogSchema = createInsertSchema(logsTable).omit({ id: true, createdAt: true });
  export type InsertLog = z.infer<typeof insertLogSchema>;
  export type Log = typeof logsTable.$inferSelect;
  