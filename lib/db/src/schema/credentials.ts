import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tasksTable } from "./tasks";

export const credentialsTable = pgTable("credentials", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  encryptedData: text("encrypted_data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCredentialSchema = createInsertSchema(credentialsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCredential = z.infer<typeof insertCredentialSchema>;
export type Credential = typeof credentialsTable.$inferSelect;
