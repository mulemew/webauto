import { pgTable, text, serial, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A named, reusable exit proxy. Add several once, then pick one per task from a
 * dropdown (like saved credentials) instead of re-typing the proxy every time.
 *
 * `url` is the full proxy URL the browser dials, e.g.
 *   socks5://user:pass@host:port  |  http://user:pass@host:port
 * WARP is a WireGuard identity, not an address — it is NOT stored here and keeps
 * its own per-task handling.
 */
export const proxyProfilesTable = pgTable("proxy_profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  // Cached exit-IP geolocation (country/city/ip/isp…) so task pages read it directly
  // instead of resolving through the proxy every render. Refreshed on demand.
  exitGeo: jsonb("exit_geo"),
  geoUpdatedAt: timestamp("geo_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertProxyProfileSchema = createInsertSchema(proxyProfilesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProxyProfile = z.infer<typeof insertProxyProfileSchema>;
export type ProxyProfile = typeof proxyProfilesTable.$inferSelect;
