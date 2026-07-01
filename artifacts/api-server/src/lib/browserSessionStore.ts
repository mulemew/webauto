import { db, browserSessionsTable, eq, and } from "@workspace/db";
import { encrypt, decrypt } from "./encryption";
import { logger } from "./logger";

/**
 * Persistent per-task browser session store (cookie mode).
 *
 * Stores the Playwright storage state (cookies + localStorage) encrypted so that
 * a task can restore its logged-in session on the next run instead of logging in
 * again. Keyed by (taskId, sessionKey) — sessionKey defaults to "default" and
 * lets a single task keep multiple isolated sessions if needed.
 */

const DEFAULT_KEY = "default";

/** Load and decrypt a saved storage state, or null if none exists. */
export async function loadBrowserSession(
  taskId: number,
  sessionKey: string = DEFAULT_KEY,
): Promise<unknown | null> {
  try {
    const [row] = await db
      .select()
      .from(browserSessionsTable)
      .where(
        and(
          eq(browserSessionsTable.taskId, taskId),
          eq(browserSessionsTable.sessionKey, sessionKey),
        ),
      );
    if (!row) return null;
    const raw = (row.storageState as { enc?: string } | null)?.enc;
    if (!raw) return null;
    return JSON.parse(decrypt(raw));
  } catch (err) {
    logger.warn({ taskId, sessionKey, err }, "Failed to load browser session");
    return null;
  }
}

/** Encrypt and upsert a storage state for a task. */
export async function saveBrowserSession(
  taskId: number,
  storageState: unknown,
  sessionKey: string = DEFAULT_KEY,
): Promise<void> {
  try {
    const enc = encrypt(JSON.stringify(storageState));
    await db
      .insert(browserSessionsTable)
      .values({ taskId, sessionKey, storageState: { enc } })
      .onConflictDoUpdate({
        target: [browserSessionsTable.taskId, browserSessionsTable.sessionKey],
        set: { storageState: { enc }, updatedAt: new Date() },
      });
    logger.info({ taskId, sessionKey }, "Browser session persisted");
  } catch (err) {
    logger.warn({ taskId, sessionKey, err }, "Failed to save browser session");
  }
}

/** Delete a task's saved session(s). Used for session isolation / reset. */
export async function clearBrowserSession(
  taskId: number,
  sessionKey?: string,
): Promise<void> {
  try {
    if (sessionKey) {
      await db
        .delete(browserSessionsTable)
        .where(
          and(
            eq(browserSessionsTable.taskId, taskId),
            eq(browserSessionsTable.sessionKey, sessionKey),
          ),
        );
    } else {
      await db
        .delete(browserSessionsTable)
        .where(eq(browserSessionsTable.taskId, taskId));
    }
  } catch (err) {
    logger.warn({ taskId, sessionKey, err }, "Failed to clear browser session");
  }
}

/** Whether a task has any login step with cookie mode enabled. */
export function taskUsesCookieMode(steps: unknown): {
  enabled: boolean;
  sessionKey: string;
} {
  if (!Array.isArray(steps)) return { enabled: false, sessionKey: DEFAULT_KEY };
  for (const s of steps as Array<Record<string, unknown>>) {
    if (s && s.type === "login" && s.cookieMode === true) {
      const key =
        typeof s.sessionKey === "string" && s.sessionKey.trim()
          ? s.sessionKey.trim()
          : DEFAULT_KEY;
      return { enabled: true, sessionKey: key };
    }
  }
  return { enabled: false, sessionKey: DEFAULT_KEY };
}
