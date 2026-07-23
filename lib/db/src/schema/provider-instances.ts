import { pgTable, text, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A registered backend instance for a browser provider FAMILY. Register several of the
 * same family (each its own container) and the runner spreads concurrent tasks across
 * the healthy ones — real parallelism instead of fighting over one shared resource
 * (cf-proxy's single Xvfb mouse being the motivating case).
 *
 *   family  = "browserless" | "sb" | "fox"
 *   subtype = for browserless: "playwright" | "puppeteer"; empty for sb/fox
 *   url     = ws://…  for browserless (CDP endpoint)
 *             http://host:port  for sb (cf-proxy) and fox (camoufox-proxy)
 *
 * `healthy`/`lastError`/`lastCheckedAt` are filled by the periodic health probe; only
 * enabled + healthy instances are eligible for selection.
 */
export const providerInstancesTable = pgTable("provider_instances", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  family: text("family").notNull(),
  subtype: text("subtype").notNull().default(""),
  url: text("url").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  healthy: boolean("healthy"),
  lastError: text("last_error"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertProviderInstanceSchema = createInsertSchema(providerInstancesTable).omit({
  id: true,
  healthy: true,
  lastError: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProviderInstance = z.infer<typeof insertProviderInstanceSchema>;
export type ProviderInstance = typeof providerInstancesTable.$inferSelect;
