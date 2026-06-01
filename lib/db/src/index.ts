import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";

// Re-export drizzle-orm operators so consuming packages use the same
// drizzle-orm instance as the one that built the table/column types.
// This avoids the "duplicate private property" TS error caused by pnpm
// resolving drizzle-orm to different store paths depending on peer deps.
export { eq, ne, gt, gte, lt, lte, and, or, not, isNull, isNotNull, desc, asc, count, sql, inArray } from "drizzle-orm";
