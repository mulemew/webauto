import { db, sessionsTable, eq, lt, ne } from "@workspace/db";
import { logger } from "./logger";

export async function addSession(token: string, expiresAt: Date): Promise<void> {
  await db.insert(sessionsTable).values({ token, expiresAt });
}

export async function hasSession(token: string): Promise<boolean> {
  const [row] = await db
    .select({ token: sessionsTable.token, expiresAt: sessionsTable.expiresAt })
    .from(sessionsTable)
    .where(eq(sessionsTable.token, token));

  if (!row) return false;

  if (row.expiresAt <= new Date()) {
    await db.delete(sessionsTable).where(eq(sessionsTable.token, token)).catch(() => {});
    return false;
  }

  return true;
}

export async function deleteSession(token: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.token, token));
}

export async function purgeExpiredSessions(): Promise<void> {
  try {
    await db.delete(sessionsTable).where(lt(sessionsTable.expiresAt, new Date()));
  } catch (err) {
    logger.warn({ err }, "Failed to purge expired sessions");
  }
}

export async function clearAllSessions(): Promise<void> {
  await db.delete(sessionsTable);
}

export async function clearOtherSessions(exceptToken: string): Promise<void> {
  await db.delete(sessionsTable).where(ne(sessionsTable.token, exceptToken));
}
