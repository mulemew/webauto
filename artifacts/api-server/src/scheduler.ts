import { Cron } from "croner";
import { db, tasksTable, logsTable, eq, isNotNull, and, gte, lt, lte, sql } from "@workspace/db";
import { logger } from "./lib/logger";
import { runTask } from "./automation/runner";
import { purgeExpiredSessions } from "./lib/sessions";
import { loadRetentionConfig } from "./lib/appSettings";
import path from "path";
import fs from "fs";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");

const scheduledJobs = new Map<number, Cron>();
const randomScheduleTimeouts = new Map<number, ReturnType<typeof setTimeout>[]>();

export function getScheduledJobsCount(): number {
  return scheduledJobs.size + randomScheduleTimeouts.size;
}

function parseRandomSchedule(expression: string): { windowMinutes: number; runsPerWindow: number } | null {
  if (!expression.startsWith("@random:")) return null;
  const parts = expression.split(":");
  const windowMinutes = parseInt(parts[1] ?? "", 10);
  const runsPerWindow = parseInt(parts[2] ?? "", 10);
  if (isNaN(windowMinutes) || windowMinutes < 1 || isNaN(runsPerWindow) || runsPerWindow < 1) return null;
  return { windowMinutes, runsPerWindow };
}

function parseAfterCompletionSchedule(expression: string): number | null {
  if (!expression.startsWith("@after_completion:")) return null;
  const minutes = parseInt(expression.slice("@after_completion:".length), 10);
  if (isNaN(minutes) || minutes < 1) return null;
  return minutes;
}

function formatIntervalLabel(totalMinutes: number): string {
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

function scheduleNextRunAfterCompletion(taskId: number, delayMinutes: number): void {
  const nextRunAt = new Date(Date.now() + delayMinutes * 60 * 1000);
  db.update(tasksTable).set({ nextRunAt }).where(eq(tasksTable.id, taskId)).catch(() => {});
  logger.info({ taskId, delayMinutes, nextRunAt: nextRunAt.toISOString() }, "Post-completion next run seeded");
}

export function describeScheduleExpression(expression: string | null | undefined): string | null {
  if (!expression) return null;
  const random = parseRandomSchedule(expression);
  if (random) return `Every ${formatIntervalLabel(random.windowMinutes)} for ${random.runsPerWindow} run${random.runsPerWindow === 1 ? "" : "s"}`;
  const afterCompletion = parseAfterCompletionSchedule(expression);
  if (afterCompletion !== null) return `Run again ${formatIntervalLabel(afterCompletion)} after completion`;
  return expression;
}

export async function initScheduler(): Promise<void> {
  logger.info("Initializing task scheduler");

  try {
    const result = await db
      .update(tasksTable).set({ status: "failed" })
      .where(eq(tasksTable.status, "running"))
      .returning({ id: tasksTable.id });
    if (result.length > 0) {
      logger.warn({ count: result.length, ids: result.map((r: { id: number }) => r.id) }, "Reset interrupted tasks to 'failed'");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to reset interrupted running tasks on startup");
  }

  const tasks = await db.select().from(tasksTable)
    .where(and(isNotNull(tasksTable.cronExpression), eq(tasksTable.enabled, true)));

  for (const task of tasks) {
    if (task.cronExpression) scheduleTask(task.id, task.cronExpression);
  }

  logger.info({ count: scheduledJobs.size + randomScheduleTimeouts.size }, "Scheduler initialized");

  // Trigger any @after_completion: tasks whose nextRunAt was missed during downtime
  try {
    const overdueTasks = await db.select().from(tasksTable)
      .where(and(eq(tasksTable.enabled, true), isNotNull(tasksTable.nextRunAt)));
    for (const task of overdueTasks) {
      // Same rule as the poller: recover overdue @after_completion runs AND pending
      // retries (standard-cron / manual). Skip @random — it re-seeds its own window.
      if (task.cronExpression && parseRandomSchedule(task.cronExpression) !== null) continue;
      if (!task.nextRunAt || task.nextRunAt > new Date()) continue;
      logger.info({ taskId: task.id }, "Triggering overdue nextRunAt task on startup (post-completion or retry)");
      await db.update(tasksTable).set({ nextRunAt: null }).where(eq(tasksTable.id, task.id));
      runTask(task.id, false, "cron").catch((err: unknown) => logger.error({ taskId: task.id, err }, "Overdue nextRunAt task failed"));
    }
  } catch (err) {
    logger.warn({ err }, "Failed to check overdue post-completion tasks on startup");
  }

  // Polling loop: every 30 s fire any post-completion tasks whose nextRunAt has arrived
  setInterval(async () => {
    try {
      const now = new Date();
      const due = await db.select().from(tasksTable)
        .where(and(eq(tasksTable.enabled, true), isNotNull(tasksTable.nextRunAt), lte(tasksTable.nextRunAt, now)));
      for (const task of due) {
        // Fire due nextRunAt runs: @after_completion (their normal trigger) AND failure
        // RETRIES on standard-cron / manual tasks — whose nextRunAt is ONLY ever set by
        // scheduleRetryIfConfigured, so a due one is always a pending retry. @random tasks
        // drive their own nextRunAt via setTimeout, so skip them to avoid a double run.
        if (task.cronExpression && parseRandomSchedule(task.cronExpression) !== null) continue;
        await db.update(tasksTable).set({ nextRunAt: null }).where(eq(tasksTable.id, task.id));
        logger.info({ taskId: task.id, cron: task.cronExpression }, "Due nextRunAt task triggered (post-completion or retry)");
        runTask(task.id, false, "cron").catch((err: unknown) => logger.error({ taskId: task.id, err }, "Due nextRunAt task run failed"));
      }
    } catch (err) {
      logger.error({ err }, "Post-completion scheduler poll error");
    }
  }, 30_000).unref();

  // Daily session purge
  new Cron("0 3 * * *", async () => {
    logger.info("Running daily expired session purge");
    await purgeExpiredSessions();
  });

  // Daily retention cleanup
  new Cron("30 3 * * *", async () => {
    logger.info("Running daily retention cleanup");
    await runRetentionCleanup();
  });
}

/** Delete old logs and screenshots based on retention config. */
export async function runRetentionCleanup(): Promise<void> {
  try {
    const config = await loadRetentionConfig();

    // Delete old log rows
    if (config.logRetentionDays > 0) {
      const cutoff = new Date(Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000);
      const deleted = await db.delete(logsTable)
        .where(lt(logsTable.runAt, cutoff))
        .returning({ id: logsTable.id });
      if (deleted.length > 0) logger.info({ count: deleted.length, cutoff }, "Deleted old log rows");
    }

    // Enforce screenshot disk size limit
    if (config.maxScreenshotsMb > 0) {
      await enforceScreenshotSizeLimit(config.maxScreenshotsMb);
    }
  } catch (err) {
    logger.error({ err }, "Retention cleanup failed");
  }
}

async function enforceScreenshotSizeLimit(maxMb: number): Promise<void> {
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) return;
    const maxBytes = maxMb * 1024 * 1024;
    const files = fs.readdirSync(SCREENSHOTS_DIR)
      .filter((f) => f.endsWith(".png"))
      .map((f) => {
        const fp = path.join(SCREENSHOTS_DIR, f);
        return { name: f, path: fp, mtime: fs.statSync(fp).mtimeMs, size: fs.statSync(fp).size };
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    let totalBytes = files.reduce((s, f) => s + f.size, 0);
    let removed = 0;
    for (const file of files) {
      if (totalBytes <= maxBytes) break;
      fs.unlinkSync(file.path);
      totalBytes -= file.size;
      removed++;
    }
    if (removed > 0) logger.info({ removed, maxMb }, "Removed old screenshots to enforce size limit");
  } catch (err) {
    logger.error({ err }, "Screenshot size enforcement failed");
  }
}

function clearRandomTimeouts(taskId: number): void {
  const existing = randomScheduleTimeouts.get(taskId);
  if (existing) { existing.forEach(clearTimeout); randomScheduleTimeouts.delete(taskId); }
}

function scheduleRandomTask(taskId: number, windowMinutes: number, runsPerWindow: number): void {
  clearRandomTimeouts(taskId);
  const windowMs = windowMinutes * 60 * 1000;

  async function scheduleWindow(): Promise<void> {
    const now = Date.now();

    // ── Window anchoring ──────────────────────────────────────────────
    // Instead of epoch-aligned windows (which create arbitrary boundaries
    // and can cause gaps up to 2x windowMs), anchor the window to the
    // task's most recent run.  This guarantees the gap between consecutive
    // runs is always ≤ windowMs.
    let anchorMs: number;
    try {
      const [lastRun] = await db
        .select({ runAt: logsTable.runAt })
        .from(logsTable)
        .where(eq(logsTable.taskId, taskId))
        .orderBy(sql`${logsTable.runAt} desc`)
        .limit(1);
      anchorMs = lastRun ? new Date(lastRun.runAt).getTime() : 0;
    } catch {
      anchorMs = 0;
    }

    let windowStart: number;
    let windowEnd: number;
    if (anchorMs > 0 && anchorMs <= now) {
      const elapsed = now - anchorMs;
      const windowsSinceAnchor = Math.floor(elapsed / windowMs);
      windowStart = anchorMs + windowsSinceAnchor * windowMs;
      windowEnd = windowStart + windowMs;
    } else {
      windowStart = now;
      windowEnd = now + windowMs;
    }

    // 查询本窗口内已运行次数（成功和失败都计入），防止重启/禁用/修改配置后多跑
    let runsInWindow = 0;
    try {
      const [result] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(logsTable)
        .where(and(
          eq(logsTable.taskId, taskId),
          gte(logsTable.runAt, new Date(windowStart)),
          lt(logsTable.runAt, new Date(windowEnd)),
        ));
      runsInWindow = result?.count ?? 0;
    } catch (err) {
      logger.warn({ taskId, err }, "Failed to count runs in window, assuming 0");
    }

    const remainingRuns = Math.max(0, runsPerWindow - runsInWindow);
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    if (remainingRuns > 0) {
      // 在剩余窗口时间内（[now, windowEnd]）生成随机运行时间
      const remainingMs = windowEnd - now;
      const runTimes: number[] = [];
      for (let i = 0; i < remainingRuns; i++) {
        runTimes.push(now + Math.random() * remainingMs);
      }
      runTimes.sort((a, b) => a - b);

      for (let _ri = 0; _ri < runTimes.length; _ri++) {
        const runTime = runTimes[_ri];
        const delay = runTime - now;
        if (delay > 0) {
          const _capturedIndex = _ri;
          const t = setTimeout(async () => {
            const _nextInWindow = runTimes.slice(_capturedIndex + 1).find((t) => t > Date.now());
            db.update(tasksTable)
              .set({ nextRunAt: _nextInWindow !== undefined ? new Date(_nextInWindow) : new Date(windowEnd) })
              .where(eq(tasksTable.id, taskId))
              .catch(() => {});
            try {
              const [task] = await db.select({ enabled: tasksTable.enabled }).from(tasksTable).where(eq(tasksTable.id, taskId));
              if (task?.enabled) {
                logger.info({ taskId, windowMinutes, runsPerWindow }, "Random-interval task run triggered");
                await runTask(taskId, false, "cron");
              }
            } catch (err) {
              logger.error({ taskId, err }, "Random-interval task run failed");
            }
          }, delay);
          timeouts.push(t);
        }
      }

      const firstFutureRun = runTimes[0];
      db.update(tasksTable).set({ nextRunAt: new Date(firstFutureRun) }).where(eq(tasksTable.id, taskId)).catch(() => {});
      logger.info({ taskId, windowMinutes, runsPerWindow, runsInWindow, remainingRuns, windowEndsAt: new Date(windowEnd).toISOString() }, "Random schedule window activated");
    } else {
      const estimatedNextRun = windowEnd + Math.random() * windowMs;
      db.update(tasksTable).set({ nextRunAt: new Date(estimatedNextRun) }).where(eq(tasksTable.id, taskId)).catch(() => {});
      logger.info({ taskId, windowMinutes, runsPerWindow, runsInWindow }, "Random window quota met, waiting for next window");
    }

    const nextWindowDelay = windowEnd - now;
    const nextTimer = setTimeout(() => {
      db.select({ cronExpression: tasksTable.cronExpression, enabled: tasksTable.enabled })
        .from(tasksTable).where(eq(tasksTable.id, taskId))
        .then((rows: { cronExpression: string | null; enabled: boolean }[]) => {
          const task = rows[0];
          if (task?.enabled && task.cronExpression && parseRandomSchedule(task.cronExpression)) {
            scheduleWindow().catch((err: unknown) => logger.error({ taskId, err }, "scheduleWindow error"));
          } else {
            randomScheduleTimeouts.delete(taskId);
          }
        })
        .catch(() => randomScheduleTimeouts.delete(taskId));
    }, nextWindowDelay > 0 ? nextWindowDelay : 1000);
    timeouts.push(nextTimer);
    randomScheduleTimeouts.set(taskId, timeouts);
  }

  scheduleWindow().catch((err: unknown) => logger.error({ taskId, err }, "scheduleWindow initial error"));
}

export function scheduleTask(taskId: number, expression: string): void {
  unscheduleTask(taskId);
  const randomParams = parseRandomSchedule(expression);
  if (randomParams) { scheduleRandomTask(taskId, randomParams.windowMinutes, randomParams.runsPerWindow); return; }
  // @after_completion: tasks run via nextRunAt polling — no Cron job needed.
  // Seed nextRunAt immediately so the "next run" countdown shows up as soon as
  // the schedule is saved, instead of only appearing after the first manual run.
  const afterCompletionMinutes = parseAfterCompletionSchedule(expression);
  if (afterCompletionMinutes !== null) {
    logger.info({ taskId, expression }, "Post-completion interval task registered (driven by poller)");
    (async () => {
      try {
        const [t] = await db
          .select({ enabled: tasksTable.enabled, nextRunAt: tasksTable.nextRunAt })
          .from(tasksTable)
          .where(eq(tasksTable.id, taskId));
        // Only seed when enabled and no pending run is already scheduled.
        if (t?.enabled && !t.nextRunAt) {
          scheduleNextRunAfterCompletion(taskId, afterCompletionMinutes);
        }
      } catch (err) {
        logger.warn({ taskId, err }, "Failed to seed post-completion nextRunAt");
      }
    })();
    return;
  }

  // Validate by trying to construct a Cron — throws on invalid expression.
  try {
    const test = new Cron(expression);
    test.stop();
  } catch {
    logger.warn({ taskId, expression }, "Invalid cron expression, skipping schedule");
    return;
  }

  const job = new Cron(expression, async () => {
    try {
      logger.info({ taskId }, "Cron-triggered task run");
      const [t] = await db.select({ enabled: tasksTable.enabled }).from(tasksTable).where(eq(tasksTable.id, taskId));
      if (!t?.enabled) { logger.info({ taskId }, "Skipping disabled task"); return; }
      await runTask(taskId, false, "cron");
    } catch (err) {
      logger.error({ taskId, err }, "Cron job execution failed");
    }
  });

  scheduledJobs.set(taskId, job);
  logger.info({ taskId, expression, nextRun: job.nextRun()?.toISOString() }, "Task scheduled");
}

export function unscheduleTask(taskId: number): void {
  const existing = scheduledJobs.get(taskId);
  if (existing) { existing.stop(); scheduledJobs.delete(taskId); logger.info({ taskId }, "Task unscheduled"); }
  clearRandomTimeouts(taskId);
}

export function rescheduleTask(taskId: number, cronExpression: string | null | undefined): void {
  if (cronExpression) scheduleTask(taskId, cronExpression);
  else unscheduleTask(taskId);
}
