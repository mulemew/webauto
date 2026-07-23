import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A named, reusable browser backend. Moved out of Settings so you can register several
 * (e.g. two remote browserless endpoints) and pick one per task from a dropdown.
 *
 *   type = "playwright" | "puppeteer" | "seleniumbase" | "camoufox"
 *   url  = ws(s)://…  for playwright/puppeteer (CDP endpoint)
 *          http(s)://host:port  for seleniumbase (cf-proxy) and camoufox (camoufox-proxy)
 *   concurrency = how many tasks may run on THIS provider at once (each provider has its
 *                 own limit; there is no global cap).
 *
 * `healthy`/`lastError`/`lastCheckedAt` are filled by the periodic health probe.
 */
export const providersTable = pgTable("providers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  url: text("url").notNull().default(""),
  concurrency: integer("concurrency").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  healthy: boolean("healthy"),
  lastError: text("last_error"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertProviderSchema = createInsertSchema(providersTable).omit({
  id: true,
  healthy: true,
  lastError: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProvider = z.infer<typeof insertProviderSchema>;
export type Provider = typeof providersTable.$inferSelect;
