import path from "path";
import fs from "fs";
import { Router, type IRouter } from "express";
import { db, tasksTable, credentialsTable, savedCredentialsTable, logsTable, eq, desc, count, and, gte, sql } from "@workspace/db";
import {
  ListTasksResponse,
  CreateTaskBody,
  GetTaskParams,
  GetTaskResponse,
  UpdateTaskParams,
  UpdateTaskBody,
  DeleteTaskParams,
  RunTaskParams,
  ListTaskLogsParams,
  ListTaskLogsResponse,
  GetTaskLogParams,
  GetTaskLogResponse,
  GetTasksSummaryResponse,
} from "@workspace/api-zod";
import { execFile } from "child_process";
import { encrypt, decrypt } from "../lib/encryption";
import { startLocalProxy } from "../automation/proxy-manager";
import { runTask, isTaskRunning, requestCancelTask } from "../automation/runner";
import { getTaskEmitter, getTaskEventBuffer, type TaskStreamEvent } from "../lib/taskEvents";
import { rescheduleTask, unscheduleTask } from "../scheduler";
import { Cron } from "croner";

import { logger } from "../lib/logger";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

const router: IRouter = Router();

/**
 * Reconcile the API's nullable task fields with the columns' types.
 *
 * The API models "clear this value" as an explicit null, but the drizzle columns
 * don't all accept one: webhook_enabled is NOT NULL DEFAULT false, so a null there
 * has to become false. Spreading the parsed body straight into .values()/.set() is
 * what broke the build. Only keys actually present are returned, so this can be
 * spread over taskFields without resurrecting fields the caller never sent (which
 * would wipe them on a PATCH-style update).
 */
function normalizeNullableTaskFields<
  T extends Partial<{
    retryCount: number | null;
    retryIntervalMinutes: number | null;
    webhookEnabled: boolean | null;
    webhookToken: string | null;
  }>,
>(fields: T): Partial<typeof tasksTable.$inferInsert> {
  // Strip the nullable-by-API keys, then re-add them with column-safe values. They
  // must be REMOVED rather than merely overridden: spreading `{...fields, ...fixed}`
  // still unions the original `| null` into the result type, which is what kept
  // failing typecheck.
  const {
    retryCount: _rc,
    retryIntervalMinutes: _ri,
    webhookEnabled: _we,
    webhookToken: _wt,
    ...rest
  } = fields;
  const out = { ...rest } as Partial<typeof tasksTable.$inferInsert>;
  if ("retryCount" in fields) out.retryCount = fields.retryCount ?? null;
  if ("retryIntervalMinutes" in fields) out.retryIntervalMinutes = fields.retryIntervalMinutes ?? null;
  // NOT NULL column — null means "off".
  if ("webhookEnabled" in fields) out.webhookEnabled = fields.webhookEnabled ?? false;
  if ("webhookToken" in fields) out.webhookToken = fields.webhookToken ?? null;
  return out;
}

// ── Exit-IP geolocation (cached in tasks.exit_geo) ───────────────────────────
// Resolved in the background on create/update (and on manual re-detect) so the
// task list + detail card can show the exit country/flag without a live proxy
// lookup every time a page is opened.
export type ExitGeo = {
  configured: boolean; direct?: boolean; ok?: boolean; error?: string; proxyType?: string;
  exitIp?: string; country?: string; countryCode?: string; region?: string; city?: string;
  isp?: string; timezone?: string; at?: string;
};
const GEO_URL =
  "http://ip-api.com/json/?fields=status,message,query,country,countryCode,regionName,city,isp,timezone";
type IpApi = {
  status?: string; message?: string; query?: string; country?: string;
  countryCode?: string; regionName?: string; city?: string; isp?: string; timezone?: string;
};
function runGeoCurl(proxyArg?: string): Promise<IpApi> {
  const args = ["-s", "--max-time", "15", ...(proxyArg ? ["-x", proxyArg] : []), GEO_URL];
  return new Promise((resolve, reject) => {
    execFile("curl", args, { timeout: 20_000 }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out) as IpApi)));
  });
}
/** Resolve exit IP + geo for a task's browserConfig — proxy exit, or host IP when no proxy. */
async function resolveExitGeo(browserConfig: unknown): Promise<ExitGeo> {
  const bc = (browserConfig ?? {}) as { proxyUrl?: string; proxyType?: string };
  const proxyUrl = (bc.proxyUrl ?? "").trim();
  const proxyType = (bc.proxyType ?? "").trim();
  const at = new Date().toISOString();
  if (!proxyUrl && proxyType !== "warp") {
    try {
      const d = await runGeoCurl();
      if (d.status !== "success") return { configured: false, direct: true, ok: false, error: d.message || "geo lookup failed", at };
      return { configured: false, direct: true, ok: true, exitIp: d.query, country: d.country, countryCode: d.countryCode, region: d.regionName, city: d.city, isp: d.isp, timezone: d.timezone, at };
    } catch (err) {
      return { configured: false, direct: true, ok: false, error: err instanceof Error ? err.message : String(err), at };
    }
  }
  let resolved: Awaited<ReturnType<typeof startLocalProxy>> = null;
  try {
    resolved = await startLocalProxy({ proxyUrl: proxyUrl || undefined, proxyType: (proxyType || undefined) as never });
    if (!resolved) return { configured: false, at };
    const curlProxy = resolved.serverUrl.replace(/^socks5:\/\//i, "socks5h://");
    const d = await runGeoCurl(curlProxy);
    if (d.status !== "success") return { configured: true, ok: false, error: d.message || "geo lookup failed", proxyType, at };
    return { configured: true, ok: true, proxyType, exitIp: d.query, country: d.country, countryCode: d.countryCode, region: d.regionName, city: d.city, isp: d.isp, timezone: d.timezone, at };
  } catch (err) {
    return { configured: true, ok: false, error: err instanceof Error ? err.message : String(err), proxyType, at };
  } finally {
    if (resolved) { try { await resolved.stop(); } catch { /* ignore */ } }
  }
}
/** Recompute a task's exit geo and store it in exit_geo. Best-effort (never throws). */
async function persistExitGeo(taskId: number): Promise<ExitGeo | null> {
  try {
    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!task) return null;
    const geo = await resolveExitGeo(task.browserConfig);
    await db.update(tasksTable).set({ exitGeo: geo }).where(eq(tasksTable.id, taskId));
    return geo;
  } catch (err) {
    logger.warn({ err, taskId }, "persistExitGeo failed");
    return null;
  }
}

/** One-time background fill of exit_geo for tasks that don't have it yet (tasks that
 *  existed before this feature). Runs sequentially so we never start many proxies at
 *  once. Called from server startup; safe to run on every boot (no-op once filled). */
export async function backfillExitGeo(): Promise<void> {
  try {
    const rows = await db.select({ id: tasksTable.id, exitGeo: tasksTable.exitGeo }).from(tasksTable);
    const pending = rows.filter((r) => !r.exitGeo).map((r) => r.id);
    if (pending.length === 0) return;
    logger.info({ count: pending.length }, "Backfilling exit geo for existing tasks");
    for (const id of pending) {
      await persistExitGeo(id);
      await new Promise((r) => setTimeout(r, 500));
    }
    logger.info("Exit geo backfill complete");
  } catch (err) {
    logger.warn({ err }, "exit geo backfill failed");
  }
}

/**
 * For each login step that has inline credentials (inlineUsername/inlinePassword),
 * create an entry in saved_credentials (encrypted), replace the inline fields
 * with the resulting credentialId, and strip the plaintext from the step.
 */
type AnyStep = Record<string, unknown>;
async function promoteInlineCredentials(
  steps: AnyStep[] | null | undefined,
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<AnyStep[] | null> {
  if (!Array.isArray(steps) || steps.length === 0) return steps ?? null;

  const result: AnyStep[] = [];
  for (const step of steps) {
    if (
      step.type === "login" &&
      typeof step.inlineUsername === "string" && step.inlineUsername.length > 0 &&
      typeof step.inlinePassword === "string" && step.inlinePassword.length > 0
    ) {
      const encryptedData = encrypt(
        JSON.stringify({
          password: step.inlinePassword,
          totpSecret: (typeof step.inlineTotp === "string" && step.inlineTotp.length > 0) ? step.inlineTotp : null,
        }),
      );
      const [saved] = await db
        .insert(savedCredentialsTable)
        .values({
          name: `Auto: ${step.inlineUsername}`,
          username: step.inlineUsername as string,
          encryptedData,
        })
        .returning();

      log.info({ savedCredentialId: saved.id, username: saved.username }, "Inline credential promoted to vault");

      // Replace inline fields with credentialId reference
      const { inlineUsername, inlinePassword, inlineTotp, ...rest } = step;
      result.push({ ...rest, credentialId: saved.id, credentialSource: "saved" });
    } else {
      result.push(step);
    }
  }
  return result;
}

router.get("/tasks/stats/summary", async (req, res): Promise<void> => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [totalRow] = await db.select({ count: count() }).from(tasksTable);
  const [runningRow] = await db
    .select({ count: count() })
    .from(tasksTable)
    .where(sql`${tasksTable.status} = 'running'`);
  const [scheduledRow] = await db
    .select({ count: count() })
    .from(tasksTable)
    .where(sql`${tasksTable.cronExpression} IS NOT NULL`);
  const [successRow] = await db
    .select({ count: count() })
    .from(logsTable)
    .where(and(sql`${logsTable.success} = true`, gte(logsTable.runAt, yesterday)));
  const [failedRow] = await db
    .select({ count: count() })
    .from(logsTable)
    .where(and(sql`${logsTable.success} = false`, gte(logsTable.runAt, yesterday)));
  const [needsAttentionRow] = await db
    .select({ count: count() })
    .from(tasksTable)
    .where(sql`${tasksTable.status} = 'needs_attention'`);
  const [queuedRow] = await db
    .select({ count: count() })
    .from(tasksTable)
    .where(sql`${tasksTable.status} = 'queued'`);

  res.json(
    GetTasksSummaryResponse.parse({
      total: totalRow?.count ?? 0,
      running: runningRow?.count ?? 0,
      successLast24h: successRow?.count ?? 0,
      failedLast24h: failedRow?.count ?? 0,
      scheduled: scheduledRow?.count ?? 0,
      needsAttention: needsAttentionRow?.count ?? 0,
      queued: queuedRow?.count ?? 0,
    })
  );
});

router.get("/tasks/stats/history", async (_req, res): Promise<void> => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      day: sql<string>`date_trunc('day', ${logsTable.runAt})::text`,
      success: sql<number>`count(*) filter (where ${logsTable.success} = true)`,
      failed: sql<number>`count(*) filter (where ${logsTable.success} = false)`,
    })
    .from(logsTable)
    .where(gte(logsTable.runAt, sevenDaysAgo))
    .groupBy(sql`date_trunc('day', ${logsTable.runAt})`)
    .orderBy(sql`date_trunc('day', ${logsTable.runAt})`);

  const byDay = new Map<string, { success: number; failed: number }>();
  for (const row of rows) {
    const day = row.day.slice(0, 10);
    byDay.set(day, { success: Number(row.success), failed: Number(row.failed) });
  }

  const result: Array<{ date: string; success: number; failed: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, ...(byDay.get(key) ?? { success: 0, failed: 0 }) });
  }

  res.json(result);
});

router.get("/tasks/next-runs", async (_req, res): Promise<void> => {
    const taskRows = await db
      .select({ id: tasksTable.id, cronExpression: tasksTable.cronExpression, nextRunAt: tasksTable.nextRunAt })
      .from(tasksTable)
      .where(eq(tasksTable.enabled, true));

    const now = new Date();
    const result = taskRows
      .filter((t) => t.cronExpression)
      .map((t) => {
        // @after_completion tasks: nextRunAt is written to DB by runner after each run;
        // getNextCronRun does not understand this format.
        if (t.cronExpression?.startsWith("@after_completion:")) {
          return { taskId: t.id, nextRunAt: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null };
        }
        // @random: tasks: next run time is written to DB by scheduleWindow in scheduler.
        if (t.cronExpression?.startsWith("@random:")) {
          return { taskId: t.id, nextRunAt: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null };
        }
        return {
          taskId: t.id,
          nextRunAt: getNextCronRun(t.cronExpression!, now)?.toISOString() ?? null,
        };
      });

    res.json(result);
  });

router.get("/tasks", async (req, res): Promise<void> => {
  const tasks = await db.select().from(tasksTable).orderBy(desc(tasksTable.createdAt));
  // Re-attach the cached exit geo after schema parse (the generated response schema
  // doesn't model it) so the list can render the exit flag without a live lookup.
  const parsed = ListTasksResponse.parse(tasks);
  res.json(parsed.map((p, i) => ({ ...p, exitGeo: tasks[i]?.exitGeo ?? null })));
});

router.post("/tasks", async (req, res): Promise<void> => {
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { credentials, steps, cronExpression, browserConfig, ...taskFields } = parsed.data;

  // Convert inline credentials in login steps to saved_credentials entries
  const sanitizedSteps = await promoteInlineCredentials(steps ?? null, req.log);

  const [task] = await db
    .insert(tasksTable)
    .values({
      ...normalizeNullableTaskFields(taskFields),
      // Required columns — restated so the Partial the helper returns still
      // satisfies .values()'s insert type.
      name: taskFields.name,
      targetUrl: taskFields.targetUrl,
      steps: sanitizedSteps,
      cronExpression: cronExpression ?? null,
      browserConfig: browserConfig ?? null,
      status: "idle",
    })
    .returning();

  // Legacy: store task-level credentials if explicitly provided in request body
  if (credentials && credentials.username) {
    const credData = {
      username: credentials.username,
      password: credentials.password,
      totpSecret: credentials.totpSecret ?? undefined,
    };
    await db.insert(credentialsTable).values({
      taskId: task.id,
      encryptedData: encrypt(JSON.stringify(credData)),
    });
  }

  if (cronExpression) {
    rescheduleTask(task.id, cronExpression);
  }

  req.log.info({ taskId: task.id }, "Task created");
  // Resolve + cache the exit geo in the background (don't block the create response).
  void persistExitGeo(task.id);
  res.status(201).json(GetTaskResponse.parse(task));
});


/**
 * Recent run outcomes per task, oldest→newest, for the dashboard's uptime-style
 * status squares.
 *
 * The list only ever showed the LAST run, so a task that fails 1 run in 10 looked
 * perfectly healthy. Returning the last N outcomes makes the odd failure visible at a
 * glance without opening the task.
 *
 * One query for every task (window function) rather than N queries — the dashboard
 * polls this.
 */
router.get("/tasks/recent-runs", async (req, res): Promise<void> => {
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "12"), 10) || 12));
  const rows = await db.execute(sql`
    SELECT task_id, success, run_at, duration_ms
    FROM (
      SELECT task_id, success, run_at, duration_ms,
             ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY run_at DESC) AS rn
      FROM logs
    ) t
    WHERE rn <= ${limit}
    ORDER BY task_id, run_at ASC
  `);
  const out = new Map<number, Array<{ success: boolean; runAt: string; durationMs: number | null }>>();
  for (const r of rows.rows as Array<Record<string, unknown>>) {
    const id = Number(r.task_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push({
      success: r.success === true,
      runAt: r.run_at instanceof Date ? r.run_at.toISOString() : String(r.run_at),
      durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    });
  }
  res.json(Array.from(out.entries()).map(([taskId, runs]) => ({ taskId, runs })));
});

router.get("/tasks/last-runs", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      taskId: logsTable.taskId,
      success: logsTable.success,
      runAt:   logsTable.runAt,
      durationMs: logsTable.durationMs,
    })
    .from(logsTable)
    .where(
      sql`${logsTable.id} IN (
        SELECT DISTINCT ON (task_id) id
        FROM logs
        ORDER BY task_id, run_at DESC
      )`
    );
  res.json(rows);
});

router.get("/tasks/:id/schedule-info", async (req, res): Promise<void> => {
  const params = GetTaskParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [task] = await db
    .select({ id: tasksTable.id, cronExpression: tasksTable.cronExpression, nextRunAt: tasksTable.nextRunAt })
    .from(tasksTable)
    .where(eq(tasksTable.id, params.data.id));
  if (!task) { res.status(404).json({ error: "Task not found" }); return; }
  const now = new Date();
  if (!task.cronExpression) {
    res.json({ nextRunAt: null, windowRunsCount: null, runsPerWindow: null, windowEndsAt: null }); return;
  }
  if (task.cronExpression.startsWith("@after_completion:")) {
    res.json({ nextRunAt: task.nextRunAt ? new Date(task.nextRunAt).toISOString() : null, windowRunsCount: null, runsPerWindow: null, windowEndsAt: null }); return;
  }
  if (task.cronExpression.startsWith("@random:")) {
    const parts = task.cronExpression.split(":");
    const windowMinutes = parseInt(parts[1] ?? "60", 10);
    const runsPerWindowN = parseInt(parts[2] ?? "1", 10);
    const windowMs = windowMinutes * 60 * 1000;
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const windowEnd = new Date(windowStart.getTime() + windowMs);
    const [countRow] = await db
      .select({ cnt: count() })
      .from(logsTable)
      .where(and(eq(logsTable.taskId, params.data.id), gte(logsTable.createdAt, windowStart)));
    const windowRunsCount = Number(countRow?.cnt ?? 0);
    res.json({ nextRunAt: task.nextRunAt ? new Date(task.nextRunAt).toISOString() : null, windowRunsCount, runsPerWindow: runsPerWindowN, windowEndsAt: windowEnd.toISOString() }); return;
  }
  const nextRun = getNextCronRun(task.cronExpression, now);
  res.json({ nextRunAt: nextRun ? nextRun.toISOString() : null, windowRunsCount: null, runsPerWindow: null, windowEndsAt: null });
});

router.get("/tasks/:id/logs/history", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid task id" }); return; }
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${logsTable.runAt}), 'YYYY-MM-DD')`,
      success: sql<number>`count(*) filter (where ${logsTable.success} = true)`,
      failed: sql<number>`count(*) filter (where ${logsTable.success} = false)`,
    })
    .from(logsTable)
    .where(and(eq(logsTable.taskId, id), gte(logsTable.runAt, thirtyDaysAgo)))
    .groupBy(sql`date_trunc('day', ${logsTable.runAt})`)
    .orderBy(sql`date_trunc('day', ${logsTable.runAt})`);
  res.json(rows);
});

  // GET /api/tasks/logs — cross-task log explorer
  router.get("/tasks/logs", async (req, res): Promise<void> => {
    const { taskId: taskIdQ, status: statusQ, triggeredBy: triggeredByQ, limit: limQ, offset: offQ } = req.query as Record<string, string>;
    const limitN = Math.min(parseInt(limQ ?? "50", 10), 200);
    const offsetN = parseInt(offQ ?? "0", 10);

    // Build WHERE clause with proper parameterized queries ($1, $2, ...)
    const whereParts: string[] = ["1=1"];
    const vals: unknown[] = [];
    let paramIdx = 1;
    if (taskIdQ && !isNaN(parseInt(taskIdQ, 10))) {
      whereParts.push(`task_id = $${paramIdx++}`);
      vals.push(parseInt(taskIdQ, 10));
    }
    if (statusQ === "success") { whereParts.push(`success = $${paramIdx++}`); vals.push(true); }
    if (statusQ === "failed") { whereParts.push(`success = $${paramIdx++}`); vals.push(false); }
    if (triggeredByQ) { whereParts.push(`triggered_by = $${paramIdx++}`); vals.push(triggeredByQ); }

    const whereClause = whereParts.join(" AND ");
    const countVals = [...vals];
    const limitPIdx = paramIdx++;
    const offsetPIdx = paramIdx++;
    vals.push(limitN, offsetN);

    const { pool } = await import("@workspace/db");
    const [logsResult, countResult, tasksResult] = await Promise.all([
      pool.query(
        `SELECT id, task_id, run_at, success, message, screenshot_path, duration_ms, triggered_by FROM logs WHERE ${whereClause} ORDER BY run_at DESC LIMIT $${limitPIdx} OFFSET $${offsetPIdx}`,
        vals
      ),
      pool.query(`SELECT COUNT(*)::int as total FROM logs WHERE ${whereClause}`, countVals),
      pool.query("SELECT id, name FROM tasks"),
    ]);

    const taskNameMap: Record<number, string> = Object.fromEntries(tasksResult.rows.map((t: { id: number; name: string }) => [t.id, t.name]));

    res.json({
      logs: logsResult.rows.map((r: { id: number; task_id: number; run_at: string; success: boolean; message: string; screenshot_path: string | null; duration_ms: number | null; triggered_by: string | null }) => ({
        id: r.id,
        taskId: r.task_id,
        taskName: taskNameMap[r.task_id] ?? `Task #${r.task_id}`,
        runAt: r.run_at,
        success: r.success,
        message: r.message,
        screenshotPath: r.screenshot_path,
        durationMs: r.duration_ms,
        triggeredBy: r.triggered_by,
      })),
      total: countResult.rows[0]?.total ?? 0,
      limit: limitN,
      offset: offsetN,
    });
  });

  router.get("/tasks/:id", async (req, res): Promise<void> => {
  const params = GetTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, params.data.id));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  // Resolve credentials from all login steps
  let credentialsData: { username: string; hasTotpSecret: boolean } | undefined;
  const loginCredentials: Array<{ loginMethod: string; username: string; hasTotpSecret: boolean }> = [];

  if (Array.isArray(task.steps)) {
    const loginSteps = (task.steps as Array<{ type: string; loginMethod?: string; credentialId?: number; inlineUsername?: string; inlinePassword?: string; inlineTotp?: string }>)
      .filter((s) => s.type === "login");

    for (const ls of loginSteps) {
      if (ls.credentialId) {
        const [savedCred] = await db
          .select()
          .from(savedCredentialsTable)
          .where(eq(savedCredentialsTable.id, ls.credentialId));
        if (savedCred) {
          let hasTotpSecret = false;
          try {
            const dec = JSON.parse(decrypt(savedCred.encryptedData)) as { password: string; totpSecret?: string | null };
            hasTotpSecret = !!dec.totpSecret;
          } catch {}
          loginCredentials.push({ loginMethod: ls.loginMethod ?? "form", username: savedCred.username, hasTotpSecret });
        }
      } else if (ls.inlineUsername) {
        loginCredentials.push({ loginMethod: ls.loginMethod ?? "form", username: ls.inlineUsername, hasTotpSecret: !!ls.inlineTotp });
      }
    }
  }

  // Fallback: check legacy task-level credential table
  if (loginCredentials.length === 0) {
    const [credRow] = await db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.taskId, task.id));
    if (credRow) {
      try {
        const dec = JSON.parse(decrypt(credRow.encryptedData)) as { username: string; totpSecret?: string };
        loginCredentials.push({ loginMethod: "form", username: dec.username, hasTotpSecret: !!dec.totpSecret });
      } catch {
        req.log.warn({ taskId: task.id }, "Failed to decrypt credentials");
      }
    }
  }

  // For backward compat: set credentials to first entry
  if (loginCredentials.length > 0) {
    credentialsData = { username: loginCredentials[0].username, hasTotpSecret: loginCredentials[0].hasTotpSecret };
  }

  res.json({ ...GetTaskResponse.parse({ ...task, credentials: credentialsData }), loginCredentials, exitGeo: task.exitGeo ?? null });
});

  // Resolve the EXIT IP + geolocation of the task's configured proxy, live. The
  // lookup is routed THROUGH the proxy (starting a local sing-box helper for
  // advanced protocols) so the returned IP/country is what target sites actually
  // see — used by the TaskDetail "Proxy Exit IP" card. Best-effort: returns
  // { configured:false } when no proxy is set, or { ok:false, error } on failure.
  // Returns the CACHED exit geo (tasks.exit_geo). Pass ?refresh=1 to recompute the
  // live lookup and persist it — the detail card's "re-detect" button does this.
  // Normal page opens read the cache, so no proxy is started on every view.
  router.get("/tasks/:id/proxy-geo", async (req, res): Promise<void> => {
    const params = GetTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, params.data.id));
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    const stored = (task.exitGeo ?? null) as ExitGeo | null;
    if (!refresh && stored) {
      res.json(stored);
      return;
    }
    const geo = await persistExitGeo(task.id);
    res.json(geo ?? { configured: false });
  });

router.put("/tasks/:id", async (req, res): Promise<void> => {
  const params = UpdateTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(tasksTable).where(eq(tasksTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const { credentials, steps, cronExpression, browserConfig, ...taskFields } = parsed.data;

  const updateData: Partial<typeof tasksTable.$inferInsert> = normalizeNullableTaskFields(taskFields);
  if (steps !== undefined) {
    updateData.steps = await promoteInlineCredentials(steps, req.log);
  }
  if (cronExpression !== undefined) updateData.cronExpression = cronExpression;
  if (browserConfig !== undefined) updateData.browserConfig = browserConfig ?? null;

  const [updated] = await db
    .update(tasksTable)
    .set(updateData)
    .where(eq(tasksTable.id, params.data.id))
    .returning();

  if (credentials && credentials.password) {
    const [existingCred] = await db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.taskId, params.data.id));

    let mergedCredData: { username: string; password: string; totpSecret?: string };

    if (existingCred) {
      let existingDecrypted: { username: string; password: string; totpSecret?: string } = {
        username: credentials.username,
        password: credentials.password,
      };
      try {
        existingDecrypted = JSON.parse(decrypt(existingCred.encryptedData));
      } catch {}
      mergedCredData = {
        username: credentials.username,
        password: credentials.password,
        totpSecret: credentials.totpSecret ?? existingDecrypted.totpSecret,
      };
      await db
        .update(credentialsTable)
        .set({ encryptedData: encrypt(JSON.stringify(mergedCredData)) })
        .where(eq(credentialsTable.taskId, params.data.id));
    } else {
      mergedCredData = {
        username: credentials.username,
        password: credentials.password,
        totpSecret: credentials.totpSecret ?? undefined,
      };
      await db.insert(credentialsTable).values({
        taskId: params.data.id,
        encryptedData: encrypt(JSON.stringify(mergedCredData)),
      });
    }
  } else if (credentials && credentials.username && !credentials.password) {
    // Username update only — preserve existing password
    const [existingCred] = await db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.taskId, params.data.id));

    if (existingCred) {
      try {
        const existingDecrypted = JSON.parse(decrypt(existingCred.encryptedData)) as {
          username: string;
          password: string;
          totpSecret?: string;
        };
        const updatedCred = {
          username: credentials.username,
          password: existingDecrypted.password,
          totpSecret: credentials.totpSecret !== null ? (credentials.totpSecret ?? existingDecrypted.totpSecret) : undefined,
        };
        await db
          .update(credentialsTable)
          .set({ encryptedData: encrypt(JSON.stringify(updatedCred)) })
          .where(eq(credentialsTable.taskId, params.data.id));
      } catch {
        req.log.warn({ taskId: params.data.id }, "Failed to merge credentials, keeping existing");
      }
    }
  } else if (credentials === null) {
    // Explicitly clearing credentials
    await db.delete(credentialsTable).where(eq(credentialsTable.taskId, params.data.id));
    req.log.info({ taskId: params.data.id }, "Credentials cleared");
  }

  rescheduleTask(updated.id, updated.cronExpression);
  // Re-resolve the exit geo in the background — proxy/config may have changed.
  void persistExitGeo(updated.id);
  res.json({ ...GetTaskResponse.parse(updated), exitGeo: updated.exitGeo ?? null });
});

router.delete("/tasks/:id", async (req, res): Promise<void> => {
  const params = DeleteTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(tasksTable)
    .where(eq(tasksTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  rescheduleTask(params.data.id, null);
  res.sendStatus(204);
});

/**
 * NOTE the two-segment path: "/tasks/:id" only ever matches a SINGLE segment, so
 * "/tasks/backup/export" can never be swallowed as id="export" regardless of
 * registration order (same reason /tasks/stats/summary is safe).
 *
 * Export tasks as a JSON backup.
 *
 * ?template=1 strips concrete values (target/login URLs, step selectors' values,
 * proxy URL, pasted cookies, schedule) so the result is a shareable skeleton rather
 * than a copy of your account setup.
 *
 * Secrets are NEVER exported: credentials live encrypted in saved_credentials and are
 * referenced by id, so an export carries the reference, not the password. Import into
 * a different instance therefore needs those credentials re-created.
 */
router.get("/tasks/backup/export", async (req, res): Promise<void> => {
  const template = req.query.template === "1" || req.query.template === "true";
  const rows = await db.select().from(tasksTable).orderBy(desc(tasksTable.createdAt));

  const scrubStep = (s: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...s };
    if (!template) return out;
    // Keep the shape (type/selectorType/flags), drop the instance-specific values.
    for (const k of ["url", "loginUrl", "value", "cookies", "inlineUsername", "inlinePassword", "inlineTotp"]) {
      if (k in out) out[k] = "";
    }
    delete out.credentialId;
    return out;
  };

  const tasks = rows.map((t) => {
    const steps = Array.isArray(t.steps) ? (t.steps as Array<Record<string, unknown>>).map(scrubStep) : t.steps;
    const bc = (t.browserConfig ?? null) as Record<string, unknown> | null;
    return {
      name: template ? `${t.name} (template)` : t.name,
      targetUrl: template ? "" : t.targetUrl,
      loginType: t.loginType,
      steps,
      cronExpression: template ? null : t.cronExpression,
      retryCount: t.retryCount,
      retryIntervalMinutes: t.retryIntervalMinutes,
      browserConfig: bc && template ? { ...bc, proxyUrl: "" } : bc,
      enabled: false,
    };
  });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="webauto-${template ? "templates" : "tasks"}-${new Date().toISOString().slice(0, 10)}.json"`,
  );
  res.json({ version: 1, kind: template ? "template" : "backup", exportedAt: new Date().toISOString(), tasks });
});

/**
 * Import tasks from an export file. Always ADDITIVE — imported tasks are created as
 * new, disabled rows; nothing existing is overwritten or deleted, so a mistaken
 * import can be undone by deleting the new tasks.
 */
router.post("/tasks/backup/import", async (req, res): Promise<void> => {
  const body = req.body as { tasks?: Array<Record<string, unknown>> } | undefined;
  const incoming = body?.tasks;
  if (!Array.isArray(incoming) || incoming.length === 0) {
    res.status(400).json({ error: "Body must be an export file: { tasks: [...] }" });
    return;
  }
  const created: number[] = [];
  const skipped: string[] = [];
  for (const t of incoming) {
    const name = typeof t.name === "string" && t.name.trim() ? t.name.trim() : "";
    const targetUrl = typeof t.targetUrl === "string" ? t.targetUrl : "";
    if (!name) {
      skipped.push("(unnamed task)");
      continue;
    }
    try {
      const [row] = await db
        .insert(tasksTable)
        .values({
          name,
          // targetUrl is NOT NULL; templates export it blank, so keep a placeholder
          // the user must fill in rather than rejecting the whole import.
          targetUrl: targetUrl || "about:blank",
          loginType: (t.loginType as string | null) ?? null,
          steps: (t.steps as unknown) ?? null,
          cronExpression: (t.cronExpression as string | null) ?? null,
          retryCount: (t.retryCount as number | null) ?? null,
          retryIntervalMinutes: (t.retryIntervalMinutes as number | null) ?? null,
          browserConfig: (t.browserConfig as unknown) ?? null,
          status: "idle",
          enabled: false,
        })
        .returning();
      created.push(row.id);
    } catch (err) {
      req.log.warn({ err, name }, "task import failed for one entry");
      skipped.push(name);
    }
  }
  req.log.info({ created: created.length, skipped: skipped.length }, "Tasks imported");
  res.status(201).json({ ok: true, created: created.length, skipped, ids: created });
});

/**
 * Clone a task: copies steps + browserConfig + schedule into a new "<name> (copy)"
 * task. The clone starts DISABLED and idle so it never fires on its schedule before
 * you've reviewed it, and it gets no run history. Credentials referenced by login
 * steps are saved_credentials ids, so the clone reuses them without duplicating
 * secrets.
 */
router.post("/tasks/:id/clone", async (req, res): Promise<void> => {
  const params = GetTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [src] = await db.select().from(tasksTable).where(eq(tasksTable.id, params.data.id));
  if (!src) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const [clone] = await db
    .insert(tasksTable)
    .values({
      name: `${src.name} (copy)`,
      targetUrl: src.targetUrl,
      loginType: src.loginType,
      steps: src.steps,
      cronExpression: src.cronExpression,
      browserConfig: src.browserConfig,
      exitGeo: src.exitGeo,
      status: "idle",
      enabled: false,
    })
    .returning();

  req.log.info({ from: src.id, to: clone.id }, "Task cloned");
  res.status(201).json(GetTaskResponse.parse(clone));
});

router.post("/tasks/:id/run", async (req, res): Promise<void> => {
  const params = RunTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, params.data.id));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  if (isTaskRunning(params.data.id)) {
    res.status(409).json({ error: "Task is already running" });
    return;
  }

  req.log.info({ taskId: params.data.id, reqId: req.id }, "Task run triggered manually");
  res.status(202).json({ message: "Task queued for execution", taskId: params.data.id });
  setImmediate(() => runTask(params.data.id, false, "manual"));
});

router.post("/tasks/:id/dry-run", async (req, res): Promise<void> => {
  const params = RunTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, params.data.id));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  if (isTaskRunning(params.data.id)) {
    res.status(409).json({ error: "Task is already running or a dry run is in progress" });
    return;
  }

  req.log.info({ taskId: params.data.id, reqId: req.id }, "Dry run triggered manually");
  res.status(202).json({ message: "Dry run queued", taskId: params.data.id });
  setImmediate(() => runTask(params.data.id, true));
});

router.get("/tasks/:id/logs", async (req, res): Promise<void> => {
  const params = ListTaskLogsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const rawLimit = parseInt(String(req.query.limit ?? "100"), 10);
  const rawOffset = parseInt(String(req.query.offset ?? "0"), 10);
  const limit = Number.isNaN(rawLimit) || rawLimit < 1 ? 100 : Math.min(rawLimit, 500);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const rows = await db
    .select({
      id: logsTable.id,
      taskId: logsTable.taskId,
      runAt: logsTable.runAt,
      success: logsTable.success,
      message: logsTable.message,
      screenshotPath: logsTable.screenshotPath,
      durationMs: logsTable.durationMs,
      createdAt: logsTable.createdAt,
      stepLogs: logsTable.stepLogs,
    })
    .from(logsTable)
    .where(eq(logsTable.taskId, params.data.id))
    .orderBy(desc(logsTable.runAt))
    .limit(limit)
    .offset(offset);

  const logs = rows.map(({ screenshotPath, ...rest }: { screenshotPath: string | null; [key: string]: unknown }) => ({
    ...rest,
    hasScreenshot: screenshotPath != null && screenshotPath.length > 0,
  }));

  res.json(ListTaskLogsResponse.parse(logs));
});

router.get("/tasks/:id/logs/stream", async (req, res): Promise<void> => {
  const taskId = parseInt(req.params.id ?? "", 10);
  if (isNaN(taskId)) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof (res as any).flush === "function") (res as any).flush();
  };

  if (!isTaskRunning(taskId)) {
    // Replay event buffer for recently-finished tasks (e.g. cron tasks)
    const buffered = getTaskEventBuffer(taskId);
    for (const event of buffered) {
      send(event);
    }
    if (buffered.length === 0 || buffered[buffered.length - 1]?.type !== "done") {
      send({ type: "done", success: null, message: "Task is not currently running." });
    }
    res.end();
    return;
  }

  // Task is running — replay buffered events so late-connecting clients catch up
  const buffered = getTaskEventBuffer(taskId);
  for (const event of buffered) {
    send(event);
    if (event.type === "done") { res.end(); return; }
  }

  const emitter = getTaskEmitter(taskId);

  const onEvent = (event: TaskStreamEvent) => {
    try {
      send(event);
      if (event.type === "done") {
        cleanup();
        res.end();
      }
    } catch {
      cleanup();
    }
  };

  const cleanup = () => {
    emitter.off("event", onEvent);
  };

  emitter.on("event", onEvent);

  req.on("close", cleanup);
  res.on("error", cleanup);
});

router.get("/tasks/:id/logs/:logId", async (req, res): Promise<void> => {
  const params = GetTaskLogParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [log] = await db
    .select()
    .from(logsTable)
    .where(and(eq(logsTable.id, params.data.logId), eq(logsTable.taskId, params.data.id)));

  if (!log) {
    res.status(404).json({ error: "Log not found" });
    return;
  }

  const parsed = GetTaskLogResponse.parse({
    ...log,
    hasScreenshot: log.screenshotPath != null && log.screenshotPath.length > 0,
  });
  res.json({
    ...parsed,
    triggeredBy: log.triggeredBy,
    stepLogs: Array.isArray(log.stepLogs) ? log.stepLogs : [],
  });
});


// List all step screenshots for a task (for gallery view in UI)
  router.get("/tasks/:id/step-screenshots", async (req, res): Promise<void> => {
    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid task id" }); return; }
    const screenshotsDir = path.resolve(DATA_DIR, "screenshots");
    if (!fs.existsSync(screenshotsDir)) { res.json({ screenshots: [] }); return; }
    const prefix = `task-${id}-step`;
    const files = fs.readdirSync(screenshotsDir)
      .filter(f => f.startsWith(prefix) && f.endsWith(".png") && /^task-\d+-step\d+-[a-z_]*-?\d+\.png$/.test(f))
      .map(filename => {
        const m = filename.match(/^task-(\d+)-step(\d+)-(?:[a-z_]+-)?(\d+)\.png$/);
        return m ? { filename, stepIndex: parseInt(m[2], 10), timestamp: parseInt(m[3], 10) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a!.timestamp - b!.timestamp);
    res.json({ screenshots: files });
  });

  // Serve intermediate step screenshots emitted via SSE during live runs
router.get("/tasks/:id/step-screenshots/:filename", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id ?? "", 10);
  const filename = req.params.filename ?? "";
  if (isNaN(id) || !filename) { res.status(400).json({ error: "Invalid request" }); return; }
  // Security: filename must match expected pattern and belong to this task
  // Allowed: step screenshots (task-{id}-step{n}-{suffix}-{ts}.png) or final/error screenshots (task-{id}-{ts}.png)
  const isStepShot  = /^task-\d+-step\d+-[a-z_]*-?\d+\.png$/.test(filename);
  const isFinalShot = /^task-\d+-\d+\.png$/.test(filename);
  if ((!isStepShot && !isFinalShot) || !filename.startsWith(`task-${id}-`)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const filePath = path.resolve(DATA_DIR, "screenshots", filename);
  const resolvedDataDir = path.resolve(DATA_DIR);
  if (!filePath.startsWith(resolvedDataDir)) { res.status(403).json({ error: "Forbidden" }); return; }
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: "Screenshot not found" }); return; }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  fs.createReadStream(filePath).pipe(res);
});
router.get("/tasks/:id/logs/:logId/screenshot", async (req, res): Promise<void> => {
  const params = GetTaskLogParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [log] = await db
    .select({ screenshotPath: logsTable.screenshotPath })
    .from(logsTable)
    .where(and(eq(logsTable.id, params.data.logId), eq(logsTable.taskId, params.data.id)));

  if (!log) {
    res.status(404).json({ error: "Log not found" });
    return;
  }

  if (!log.screenshotPath) {
    res.status(404).json({ error: "No screenshot available for this log" });
    return;
  }

  const filePath = path.resolve(DATA_DIR, log.screenshotPath);
  const resolvedDataDir = path.resolve(DATA_DIR);
  if (!filePath.startsWith(resolvedDataDir + path.sep) && filePath !== resolvedDataDir) {
    logger.warn({ screenshotPath: log.screenshotPath }, "Path traversal attempt blocked");
    res.status(400).json({ error: "Invalid screenshot path" });
    return;
  }

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Screenshot file not found on disk" });
    return;
  }

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  fs.createReadStream(filePath).pipe(res);
});

function getNextCronRun(expression: string, _from: Date = new Date()): Date | null {
  try {
    const job = new Cron(expression);
    const next = job.nextRun();
    job.stop();
    return next;
  } catch {
    return null;
  }
}

router.patch("/tasks/:id/enabled", async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== "boolean") { res.status(400).json({ error: "enabled must be boolean" }); return; }
    const [task] = await db.update(tasksTable).set({ enabled }).where(eq(tasksTable.id, id)).returning();
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }
    if (!enabled) {
      unscheduleTask(id);
      await db.update(tasksTable).set({ nextRunAt: null }).where(eq(tasksTable.id, id));
    } else if (task.cronExpression) {
      rescheduleTask(id, task.cronExpression);
    }
    res.json({ ok: true, enabled });
  });

  
  router.post("/tasks/:id/stop", async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid task id" }); return; }
    if (!isTaskRunning(id)) { res.status(409).json({ error: "Task is not currently running" }); return; }
    requestCancelTask(id);
    req.log.info({ taskId: id }, "Task cancellation requested");
    res.json({ ok: true, message: "Cancellation requested" });
  });


  export default router;
