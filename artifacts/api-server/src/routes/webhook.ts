import crypto from "crypto";
import { Router, type IRouter } from "express";
import { db, tasksTable, eq } from "@workspace/db";
import { runTask, isTaskRunning } from "../automation/runner";

/**
 * Webhook trigger — the ONE task route that is deliberately outside requireAuth.
 *
 * External monitors (Uptime Kuma, healthchecks.io, …) can't hold a browser session,
 * so they authenticate with a per-task bearer token instead. This router is mounted
 * BEFORE requireAuth in routes/index.ts; everything else stays session-protected.
 *
 * Because it's public, it is deliberately stingy: any failure — unknown task, webhook
 * off, missing/!wrong token — answers an identical 401 with no body detail, so the
 * endpoint can't be used to enumerate task ids or probe which ones have webhooks.
 */
const router: IRouter = Router();

/** Constant-time compare so a wrong token can't be recovered by timing the response. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which would itself leak length —
  // hash both sides to a fixed width first.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

router.post("/tasks/:id/webhook", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id ?? "", 10);
  const deny = (): void => {
    res.status(401).json({ error: "Unauthorized" });
  };
  if (!Number.isFinite(id)) {
    deny();
    return;
  }

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, id));
  if (!task || !task.webhookEnabled || !task.webhookToken) {
    deny();
    return;
  }

  // Accept "Authorization: Bearer <token>" (what most monitors send) or a bare token.
  const raw = (req.header("authorization") ?? "").trim();
  const provided = raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw;
  if (!provided || !tokenMatches(provided, task.webhookToken)) {
    req.log.warn({ taskId: id }, "Webhook rejected: bad or missing token");
    deny();
    return;
  }

  if (!task.enabled) {
    // Authenticated, but the operator has the task switched off — say so plainly
    // rather than silently doing nothing, so the monitor's log shows why.
    res.status(409).json({ error: "Task is disabled" });
    return;
  }
  if (isTaskRunning(id)) {
    res.status(409).json({ error: "Task is already running" });
    return;
  }

  req.log.info({ taskId: id }, "Task run triggered by webhook");
  res.status(202).json({ message: "Task queued for execution", taskId: id });
  void runTask(id, false, "webhook").catch((err) => {
    req.log.error({ err, taskId: id }, "Webhook-triggered run failed");
  });
});

export default router;
