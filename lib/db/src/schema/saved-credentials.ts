import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
  import { createInsertSchema } from "drizzle-zod";
  import { z } from "zod/v4";

  export const savedCredentialsTable = pgTable("saved_credentials", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    username: text("username").notNull(),
    encryptedData: text("encrypted_data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  });

  export const insertSavedCredentialSchema = createInsertSchema(savedCredentialsTable).omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });
  export type InsertSavedCredential = z.infer<typeof insertSavedCredentialSchema>;
  export type SavedCredential = typeof savedCredentialsTable.$inferSelect;
  