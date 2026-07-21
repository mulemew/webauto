import { pgTable, text, serial, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A named, reusable browser-fingerprint profile. A task references one so the
 * SAME device fingerprint is used every run (a real user = one stable device),
 * instead of configuring/randomising it per task. WARP proxy is handled
 * separately and is NOT part of this.
 *
 * `os` picks the base platform; `config` holds the concrete, internally
 * consistent details (screen, locale, timezone, and — for the Camoufox backend —
 * its fingerprint seed / overrides). Kept as jsonb so the shape can evolve
 * without a migration.
 */
export const fingerprintProfilesTable = pgTable("fingerprint_profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // "windows" | "mac" | "linux"
  os: text("os").notNull(),
  config: jsonb("config"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertFingerprintProfileSchema = createInsertSchema(fingerprintProfilesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertFingerprintProfile = z.infer<typeof insertFingerprintProfileSchema>;
export type FingerprintProfile = typeof fingerprintProfilesTable.$inferSelect;
