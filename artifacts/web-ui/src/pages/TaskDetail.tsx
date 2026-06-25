import { useState, useEffect, useRef, useMemo } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { ArrowLeft, ChevronDown, Play, Settings2, Trash2, Edit, Calendar, Link as LinkIcon, Shield, Terminal, Clock, Image as ImageIcon, AlertTriangle, RefreshCw, Maximize2, Navigation, MousePointer, Keyboard, Eye, Camera, FlaskConical, Radio, Square, Zap, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useQueryClient, useQuery } from "@tanstack/react-query";

import { useGetTask, useDeleteTask, useRunTask, useListTaskLogs, useToggleTaskEnabled, getGetTaskQueryKey, getListTasksQueryKey, getListTaskLogsQueryKey } from "@workspace/api-client-react";
import { useLang } from "@/contexts/lang-context";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { StatusBadge, StatusIcon } from "@/components/StatusBadge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { usePollingInterval } from "@/hooks/use-polling-interval";
import { usePollPaused } from "@/contexts/poll-paused-context";
import { useTimeSince } from "@/hooks/use-time-since";
import { useTaskLogStream, type StreamEntry } from "@/hooks/use-task-log-stream";

import TaskHistoryChart from "@/components/TaskHistoryChart";

function LogScreenshotCell({ taskId, logId }: { taskId: number; logId: number }) {
  const [loaded, setLoaded] = useState(false);
  const src = `/api/tasks/${taskId}/logs/${logId}/screenshot`;

  return (
    <HoverCard openDelay={300} closeDelay={100} onOpenChange={(open) => { if (open) setLoaded(true); }}>
      <Dialog>
        <HoverCardTrigger asChild>
          <DialogTrigger asChild>
            <button
              type="button"
              aria-label="Preview screenshot"
              title="Click to view screenshot"
              className="cursor-zoom-in p-0 border-0 bg-transparent leading-none"
              onClick={(e) => e.stopPropagation()}
            >
              <ImageIcon className="h-3 w-3 text-muted-foreground hover:text-foreground transition-colors" />
            </button>
          </DialogTrigger>
        </HoverCardTrigger>
        <DialogContent className="max-w-5xl bg-zinc-950 border-zinc-800 p-1">
          <img
            src={src}
            alt="Execution screenshot"
            className="w-full h-auto object-contain max-h-[85vh]"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).insertAdjacentHTML("afterend", '<p class="text-sm text-zinc-500 font-mono text-center py-8">截图已过期</p>'); }}
          />
        </DialogContent>
      </Dialog>
      <HoverCardContent
        side="top"
        align="start"
        className="w-auto p-1 bg-zinc-950 border-zinc-800"
      >
        <img
          src={loaded ? src : undefined}
          alt="Screenshot thumbnail"
          className="w-60 h-[135px] object-contain rounded"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).insertAdjacentHTML("afterend", '<p class="text-xs text-zinc-500 font-mono text-center py-4">截图已过期</p>'); }}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

export default function TaskDetail() {
  const { t } = useLang();
  const [match, params] = useRoute("/tasks/:id");
  const taskId = match && params?.id ? parseInt(params.id, 10) : 0;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pollingInterval] = usePollingInterval();
  const { paused } = usePollPaused();
  const [isJustTriggered, setIsJustTriggered] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);

  const { data: rawTask, isLoading: isLoadingTask, dataUpdatedAt: taskUpdatedAt } = useGetTask(taskId, {
    query: {
      enabled: !!taskId,
      queryKey: getGetTaskQueryKey(taskId),
      refetchInterval: (query) =>
        isJustTriggered
          ? 500
          : !paused && query.state.data?.status === "running"
          ? pollingInterval
          : 15_000,
    },
  });

  const isRunning = !paused && (rawTask?.status === "running" || isJustTriggered);

  // Keep last-known task in a ref so we never briefly show t.taskNotFound
  // during background refetches triggered by stop/done events.
  const taskCacheRef = useRef<typeof rawTask>(undefined);
  if (rawTask !== undefined) taskCacheRef.current = rawTask;
  const stableTask = rawTask ?? taskCacheRef.current;

  // Clear isJustTriggered once task status is confirmed (not idle)
  useEffect(() => {
    if (stableTask?.status && stableTask.status !== "idle") {
      setIsJustTriggered(false);
    }
  }, [stableTask?.status]);

  const { data: logs, isLoading: isLoadingLogs, dataUpdatedAt: logsUpdatedAt } = useListTaskLogs(taskId, {
    query: {
      enabled: !!taskId,
      queryKey: getListTaskLogsQueryKey(taskId),
      refetchInterval: isRunning ? pollingInterval : 30_000,
    },
  });

  const lastUpdatedAt = Math.max(taskUpdatedAt || 0, logsUpdatedAt || 0) || undefined;
  const updatedAgo = useTimeSince(lastUpdatedAt);

  // ── Persisted timeline (sessionStorage per task) ─────────────────────────
    const persistedKey = `task-stream-${taskId}`;
    const [persistedEntries, setPersistedEntries] = useState<StreamEntry[]>(() => {
      try {
        const s = typeof window !== "undefined" ? sessionStorage.getItem(`task-stream-${taskId}`) : null;
        return s ? JSON.parse(s) : [];
      } catch { return []; }
    });

  // ── Live stream ───────────────────────────────────────────────────────────
  const isRecentlyRan = !isRunning && !!stableTask?.lastRunAt &&
    (Date.now() - new Date(stableTask.lastRunAt as string).getTime()) < 90_000;
  const streamEnabled = isRunning || (isRecentlyRan && persistedEntries.length === 0);
  const { entries, isDone } = useTaskLogStream(taskId, streamEnabled);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  // When stream finishes, refresh task status and logs list
  useEffect(() => {
    if (isDone) {
      void queryClient.invalidateQueries({ queryKey: getGetTaskQueryKey(taskId) });
      void queryClient.invalidateQueries({ queryKey: getListTaskLogsQueryKey(taskId) });
    }
  }, [isDone, queryClient, taskId]);

    useEffect(() => {
      if (entries.length > 0) {
        setPersistedEntries(entries);
        try { sessionStorage.setItem(persistedKey, JSON.stringify(entries)); } catch {}
      }
    }, [entries, persistedKey]);
    const displayEntries = entries.length > 0 ? entries : persistedEntries;

    // ── Timeline parsing ────────────────────────────────────────────────────────
    const timelineSteps = useMemo(() => {
      const steps = new Map<number, { index: number; type: string; status: "success" | "failed"; message: string; screenshotPath?: string }>();
      for (const entry of displayEntries) {
        if (entry.type === "progress") {
          const sm = entry.message.match(/^Step (\d+) \[(\w+)\]: (.+)/s);
          const fm = entry.message.match(/^Step (\d+) \[(\w+)\] FAILED: (.+)/s);
          const m = sm || fm;
          if (m) {
            const [, idxStr, type, msg] = m;
            steps.set(parseInt(idxStr, 10), { index: parseInt(idxStr, 10), type, status: fm ? "failed" : "success", message: msg.trim() });
          }
        } else if (entry.type === "screenshot") {
          if (entry.message === "Postcheck screenshot" || entry.message === "Precheck screenshot") continue;
          const sn = entry.message.match(/[Ss]tep\s*(\d+)/);
          const stepNum = sn ? parseInt(sn[1], 10) : (steps.size > 0 ? Math.max(...steps.keys()) : -1);
          if (stepNum > 0) {
            const ex = steps.get(stepNum);
            if (ex) steps.set(stepNum, { ...ex, screenshotPath: entry.screenshotPath });
            else steps.set(stepNum, { index: stepNum, type: "screenshot", status: "success", message: entry.message, screenshotPath: entry.screenshotPath });
          }
        }
      }
      const fromStream = Array.from(steps.values()).sort((a, b) => a.index - b.index);
        // When not running, always prefer DB stepLogs — sessionStorage may hold stale/partial
        // data from a previous live run, causing fromStream to be non-empty but incomplete.
        if (!isRunning) {
          type RawStep = { stepIndex: number; type: string; success: boolean; message: string; screenshotPath?: string | null };
          const lastLog = logs?.[0];
          const rawSteps: RawStep[] = Array.isArray((lastLog as any)?.stepLogs) ? (lastLog as any).stepLogs : [];
          if (rawSteps.length > 0) {
            return rawSteps
              .filter(s => s.type !== "precheck" && s.type !== "postcheck")
              .map(s => ({
              index: s.stepIndex + 1,
              type: s.type,
              status: (s.success ? "success" : "failed") as "success" | "failed",
              message: s.message,
              screenshotPath: s.screenshotPath ?? undefined,
            }));
          }
          // No stepLogs in DB (older runs) — fall back to stream/session data
          return fromStream;
        }
        return fromStream;
      }, [displayEntries, isRunning, logs]);

    const generalEntries = useMemo(() =>
      displayEntries.filter(e => e.type === "connected" || e.type === "done" || (e.type === "progress" && !/^Step \d+ \[/.test(e.message))),
    [displayEntries]);

      // ── Precheck: URL check 通过后由 runner emit，显示在 timeline 第一位 ──
      const precheckScreenshotEntry = useMemo(() => {
        const fromStream = displayEntries.find(e => e.type === "screenshot" && e.message.startsWith("Precheck:")) ?? null;
        if (fromStream) return fromStream;
        // Fallback: read precheck from DB stepLogs when not running (historical view)
        if (!isRunning) {
          type RawStep = { stepIndex: number; type: string; success: boolean; message: string; screenshotPath?: string | null };
          const lastLog = logs?.[0];
          const rawSteps: RawStep[] = Array.isArray((lastLog as any)?.stepLogs) ? (lastLog as any).stepLogs : [];
          const precheckStep = rawSteps.find(s => s.type === "precheck");
          if (precheckStep) {
            return { type: "screenshot" as const, message: `Precheck: ${precheckStep.message.replace(/^Precheck:\s*/, "")}`, screenshotPath: precheckStep.screenshotPath ?? undefined };
          }
        }
        return null;
      }, [displayEntries, isRunning, logs]);

      // ── Postcheck screenshot: 消息为 "Postcheck screenshot" 的截图事件，或历史日志顶层截图 ──
      const finalScreenshotEntry = useMemo(() => {
        const fromStream = displayEntries.find(
          e => e.type === "screenshot" && e.message === "Postcheck screenshot"
        );
        if (fromStream) return fromStream;
        if (!isRunning && (logs as any)?.[0]?.screenshotPath) {
          const sp: string = (logs as any)[0].screenshotPath;
          return { type: "screenshot" as const, message: "Postcheck screenshot", screenshotPath: sp };
        }
        return null;
      }, [displayEntries, isRunning, logs]);
  
    const showStream = isRunning || displayEntries.length > 0 || timelineSteps.length > 0;



    const deleteTask = useDeleteTask();
  const runTask = useRunTask();
  const [isDryRunning, setIsDryRunning] = useState(false);
    const [isStopping, setIsStopping] = useState(false);

    const handleStop = async () => {
      if (!taskId || isStopping) return;
      setIsStopping(true);
      try {
        const res = await fetch(`/api/tasks/${taskId}/stop`, { method: "POST" });
        if (res.ok) {
          toast({ title: t.stopRequested, description: t.stopRequestedDesc, variant: "success" });
        } else {
          const err = await res.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
          toast({ title: t.couldNotStop, description: err.error ?? "Unknown error", variant: "destructive" });
        }
      } catch {
        toast({ title: t.networkError, description: t.failedToReachServer, variant: "destructive" });
      } finally {
        setTimeout(() => setIsStopping(false), 3000);
      }
    };

  const handleDelete = () => {
    deleteTask.mutate({ id: taskId }, {
      onSuccess: () => {
        toast({ title: t.taskDeleted, description: "The automation job has been permanently removed.", variant: "success" });
        queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        setLocation("/");
      },
      onError: (err) => {
        toast({ title: t.failedToDelete, description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
      }
    });
  };

  const toggleEnabled = useToggleTaskEnabled();
    const handleToggleEnabled = async (enabled: boolean) => {
      // Cancel in-flight refetches before setting optimistic data — prevents the
      // polling interval from overwriting the optimistic state before mutation.
      await queryClient.cancelQueries({ queryKey: getGetTaskQueryKey(taskId) });
      queryClient.setQueryData(getGetTaskQueryKey(taskId), (old: typeof rawTask) =>
        old ? { ...old, enabled } : old
      );
      toggleEnabled.mutate({ id: taskId, enabled }, {
        onSuccess: () => {
          // Re-set cache with confirmed value BEFORE invalidating so the stale
          // → refetch transition doesn't briefly flash the old enabled state.
          queryClient.setQueryData(getGetTaskQueryKey(taskId), (old: typeof rawTask) =>
            old ? { ...old, enabled } : old
          );
          queryClient.invalidateQueries({ queryKey: getGetTaskQueryKey(taskId) });
        },
        onError: () => {
          queryClient.invalidateQueries({ queryKey: getGetTaskQueryKey(taskId) });
          toast({ title: t.failedToUpdate, variant: "destructive" });
        },
      });
    };

    const handleRun = () => {
      runTask.mutate({ id: taskId }, {
      onSuccess: () => {
        toast({ title: t.taskTriggered, description: t.taskTriggeredDesc, variant: "success" });
        setIsJustTriggered(true);
        queryClient.invalidateQueries({ queryKey: getGetTaskQueryKey(taskId) });
        queryClient.invalidateQueries({ queryKey: getListTaskLogsQueryKey(taskId) });
      },
      onError: (err) => {
        toast({ title: t.failedToTrigger, description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
      }
    });
  };

  const handleDryRun = async () => {
    setIsDryRunning(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/dry-run`, { method: "POST" });
      if (res.status === 409) {
        toast({ title: t.alreadyRunning, description: t.alreadyRunningDesc, variant: "destructive" });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        toast({ title: t.failedToTrigger, description: body.error ?? "Unknown error", variant: "destructive" });
        return;
      }
      toast({ title: t.taskTriggered, description: t.taskTriggeredDesc, variant: "success" });
      // Poll logs every 3s for up to 90s waiting for the dry run to finish
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        void queryClient.invalidateQueries({ queryKey: getListTaskLogsQueryKey(taskId) });
        if (attempts >= 30) {
          clearInterval(poll);
          setIsDryRunning(false);
        }
      }, 3000);
      // Stop the spinner once we see a new [DRY RUN] log appear
      const stopOnNewLog = setInterval(async () => {
        const cached = queryClient.getQueryData<Array<{ message: string }>>(getListTaskLogsQueryKey(taskId));
        if (cached?.some((l) => l.message.startsWith("[DRY RUN]"))) {
          clearInterval(stopOnNewLog);
          clearInterval(poll);
          setIsDryRunning(false);
        }
      }, 3000);
    } catch {
      toast({ title: t.networkError, description: t.failedToReachServer, variant: "destructive" });
      setIsDryRunning(false);
    }
  };


  const { data: runHistory = [] } = useQuery<Array<{ day: string; success: number; failed: number }>>({
    queryKey: ["task-run-history", taskId],
    queryFn: () => fetch(`/api/tasks/${taskId}/logs/history`).then((r) => r.json()),
    enabled: !!taskId,
    staleTime: 60_000,
  });

  const { data: scheduleInfo } = useQuery<{
    nextRunAt: string | null;
    windowRunsCount: number | null;
    runsPerWindow: number | null;
    windowEndsAt: string | null;
  }>({
    queryKey: ["task-schedule-info", taskId],
    queryFn: () => fetch(`/api/tasks/${taskId}/schedule-info`).then((r) => r.json()),
    enabled: !!taskId,
    refetchInterval: 30_000,
  });
  if (isLoadingTask) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4 mb-8">
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-8 w-64" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-96 w-full" />
          </div>
          <div className="space-y-6">
            <Skeleton className="h-48 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!stableTask) {
    return (
      <div className="text-center py-20">
        <h2 className="text-xl font-bold">{t.taskNotFound}</h2>
        <Link href="/">
          <Button variant="link" className="mt-4">Return to Dashboard</Button>
        </Link>
      </div>
    );
  }

    const task = stableTask;
  const needsAttention = task.status === "needs_attention";

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/">
            <Button variant="outline" size="icon" className="h-8 w-8 rounded-md bg-card">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">{task.name}</h1>
              <StatusBadge status={task.status} />
              <div className="flex items-center gap-1.5 ml-1">
                <Switch checked={task.enabled !== false} onCheckedChange={handleToggleEnabled} aria-label="Enable task" />
                <span className="text-xs text-muted-foreground font-mono">{task.enabled !== false ? "enabled" : "disabled"}</span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground font-mono mt-1">
              ID: {task.id} &bull; Created {formatDistanceToNow(new Date(task.createdAt))} ago
              {updatedAgo && (
                <span className="ml-2 text-xs text-muted-foreground/60">· t.updatedAgo {updatedAgo}</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="gap-2 font-semibold text-muted-foreground hover:text-foreground"
            onClick={() => void handleDryRun()}
            disabled={task.status === "running" || isDryRunning || runTask.isPending || task.enabled === false}
            title="Test run — executes the full workflow without updating the task status or last run time"
          >
            {isDryRunning ? (
              <><RefreshCw className="h-4 w-4 animate-spin" /> Testing…</>
            ) : (
              <><FlaskConical className="h-4 w-4" /> Test Run</>
            )}
          </Button>
          {isRunning ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  className="gap-2 font-semibold text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30"
                  disabled={isStopping}
                >
                  {isStopping ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Stopping…</>
                  ) : (
                    <><Square className="h-4 w-4 fill-destructive" /> Stop Task</>
                  )}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border-border">
                <AlertDialogHeader>
                  <AlertDialogTitle>Stop this task?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The task will finish its current step and then stop. You can re-run it manually at any time.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t.keepRunning}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void handleStop()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Stop Task
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button
              variant="default"
              className={`gap-2 shadow-sm font-semibold ${needsAttention ? "bg-amber-500 hover:bg-amber-600 text-white" : ""}`}
              onClick={handleRun}
              disabled={isDryRunning || runTask.isPending}
            >
              {needsAttention ? (
                <><RefreshCw className="h-4 w-4" /> Retry Mission</>
              ) : (
                <><Play className="h-4 w-4" /> Run Mission</>
              )}
            </Button>
          )}
          <Link href={`/tasks/${taskId}/edit`}>
            <Button variant="outline" className="gap-2">
              <Edit className="h-4 w-4" /> Edit
            </Button>
          </Link>
          
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive border-border">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="border-border">
              <AlertDialogHeader>
                <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone. This will permanently delete the automation job
                  and all of its execution logs.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Captcha Attention Banner */}
      {needsAttention && (() => {
        const latestScreenshotLog = logs?.find((l) => l.hasScreenshot);
        return (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/8 overflow-hidden">
            <div className="flex items-start gap-4 p-4">
              <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-amber-700 dark:text-amber-400 text-sm">Captcha Detected — Manual Action Required</p>
                <p className="text-sm text-amber-700/80 dark:text-amber-400/80 mt-1">
                  This task was paused because a captcha was encountered and no automatic solver is configured.
                  Open the target URL in a browser, complete the captcha manually, then click <strong>Retry Mission</strong> above.
                </p>
                <p className="text-xs text-amber-600/70 dark:text-amber-500/70 mt-2 font-mono">
                  Tip: Set the <code>TWO_CAPTCHA_API_KEY</code> environment variable to enable automatic captcha solving via 2captcha.
                </p>
              </div>
            </div>
            {latestScreenshotLog && (
              <div className="border-t border-amber-500/30 bg-zinc-900/60 p-3">
                <p className="text-xs font-mono text-amber-500/70 mb-2 flex items-center gap-1">
                  <ImageIcon className="h-3 w-3" /> captcha_screenshot.png
                  <span className="ml-auto text-amber-500/50">
                    <Link href={`/tasks/${taskId}/logs/${latestScreenshotLog.id}`} className="hover:text-amber-400 transition-colors">
                      View full log →
                    </Link>
                  </span>
                </p>
                <Dialog>
                  <DialogTrigger asChild>
                    <button type="button" aria-label="Expand captcha screenshot" className="relative group cursor-zoom-in w-full p-0 border-0 bg-transparent block">
                      <img
                        src={`/api/tasks/${taskId}/logs/${latestScreenshotLog.id}/screenshot`}
                        alt="Captcha screenshot"
                        className="w-full rounded border border-amber-500/20 shadow-sm object-contain max-h-80"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).insertAdjacentHTML("afterend", '<p class="text-sm text-zinc-500 font-mono text-center py-4">截图已过期</p>'); }}
                      />
                      <div className="absolute inset-0 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity bg-black/40">
                        <div className="bg-zinc-900/80 rounded-full p-2">
                          <Maximize2 className="h-5 w-5 text-amber-400" />
                        </div>
                      </div>
                    </button>
                  </DialogTrigger>
                  <DialogContent className="max-w-5xl w-full p-1 bg-zinc-950 border-zinc-800">
                    <img
                      src={`/api/tasks/${taskId}/logs/${latestScreenshotLog.id}/screenshot`}
                      alt="Captcha screenshot"
                      className="w-full h-auto object-contain max-h-[85vh]"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).insertAdjacentHTML("afterend", '<p class="text-sm text-zinc-500 font-mono text-center py-8">截图已过期</p>'); }}
                    />
                  </DialogContent>
                </Dialog>
              </div>
            )}
          </div>
        );
      })()}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Details & Configuration */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-border shadow-sm">
            <CardHeader className="bg-muted/20 border-b border-border pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-primary" /> Configuration Parameters
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                <div className="space-y-1">
                  <dt className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Target URL</dt>
                  <dd className="text-sm font-mono break-all flex items-center gap-2">
                    <LinkIcon className="h-3 w-3 text-muted-foreground" />
                    <a href={task.targetUrl} target="_blank" rel="noreferrer" className="hover:underline hover:text-primary">
                      {task.targetUrl}
                    </a>
                  </dd>
                </div>
                
                <div className="space-y-1">
                  <dt className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Login Strategy</dt>
                  <dd className="text-sm font-mono flex items-center gap-2">
                    <Shield className="h-3 w-3 text-muted-foreground" />
                    {task.loginType === "github" ? "GitHub OAuth" : "Standard Form"}
                  </dd>
                </div>

                <div className="space-y-1">
                  <dt className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t.schedule}</dt>
                  <dd className="text-sm font-mono flex items-center gap-2">
                    <Calendar className="h-3 w-3 text-muted-foreground" />
                    {task.cronExpression ? task.cronExpression : <span className="text-muted-foreground italic">{t.manualOnly}</span>}
                  </dd>
                </div>

                <div className="space-y-1">
                  <dt className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Last Execution</dt>
                  <dd className="text-sm font-mono flex items-center gap-2">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    {task.lastRunAt ? format(new Date(task.lastRunAt), "MMM d, yyyy HH:mm:ss") : "Never"}
                  </dd>
                </div>

                <div className="space-y-1">
                  <dt className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Next Run</dt>
                  <dd className="text-sm font-mono flex items-center gap-2">
                    <Calendar className="h-3 w-3 text-muted-foreground" />
                    {scheduleInfo?.nextRunAt
                      ? format(new Date(scheduleInfo.nextRunAt), "MMM d, yyyy HH:mm:ss")
                      : <span className="text-muted-foreground italic">无</span>}
                  </dd>
                </div>

                {scheduleInfo?.runsPerWindow != null && (
                  <div className="space-y-1 col-span-2">
                    <dt className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Window Progress</dt>
                    <dd className="text-sm font-mono flex items-center gap-2">
                      <Radio className="h-3 w-3 text-muted-foreground" />
                      <span>{scheduleInfo.windowRunsCount ?? 0}/{scheduleInfo.runsPerWindow} runs this window</span>
                      {scheduleInfo.windowEndsAt && (
                        <span className="text-xs text-muted-foreground">· resets {formatDistanceToNow(new Date(scheduleInfo.windowEndsAt), { addSuffix: true })}</span>
                      )}
                    </dd>
                  </div>
                )}
              </dl>

              {task.steps && task.steps.length > 0 && (
                <div className="mt-6 pt-4 border-t border-border">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                    Workflow Steps <span className="font-mono text-primary ml-1">{task.steps.length}</span>
                  </h4>
                  <div className="space-y-1.5">
                    {task.steps.map((step, i) => {
                      const s = step as { type: string; url?: string; selector?: string; selectorType?: string; value?: string; ms?: number; timeout?: number };
                      const icon =
                        s.type === "navigate"   ? <Navigation className="h-3 w-3 text-primary shrink-0" /> :
                        s.type === "click"      ? <MousePointer className="h-3 w-3 text-primary shrink-0" /> :
                        s.type === "fill"       ? <Keyboard className="h-3 w-3 text-primary shrink-0" /> :
                        s.type === "wait"       ? <Clock className="h-3 w-3 text-primary shrink-0" /> :
                        s.type === "waitFor"    ? <Eye className="h-3 w-3 text-primary shrink-0" /> :
                        s.type === "screenshot" ? <Camera className="h-3 w-3 text-primary shrink-0" /> :
                        <Terminal className="h-3 w-3 text-primary shrink-0" />;
                      const detail =
                        s.type === "navigate"   ? s.url :
                        s.type === "click"      ? `[${s.selectorType}] ${s.selector}` :
                        s.type === "fill"       ? `${s.selector} → "${s.value}"` :
                        s.type === "wait"       ? `${s.ms}ms` :
                        s.type === "waitFor"    ? `${s.selector}${s.timeout ? ` (${s.timeout}ms)` : ""}` :
                        s.type === "screenshot" ? "capture page" :
                        s.type;
                      return (
                        <div key={i} className="flex items-center gap-2 bg-muted/10 border border-border rounded px-3 py-2 text-xs font-mono">
                          <span className="text-muted-foreground w-5 text-right shrink-0">{i + 1}</span>
                          {icon}
                          <span className="text-muted-foreground capitalize shrink-0">{s.type}</span>
                          <span className="text-foreground truncate">{detail}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Live Step Timeline ──────────────────────────────────────────── */}
            {showStream && (
              <Card className="border-border shadow-sm overflow-hidden">
                <CardHeader className="bg-muted/20 border-b border-border pb-3 pt-3 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Radio className={`h-3.5 w-3.5 ${isRunning && !isDone ? "text-green-500 animate-pulse" : "text-muted-foreground"}`} />
                    Run Timeline
                    {((stableTask?.steps as Array<unknown> ?? []).length > 0 || timelineSteps.length > 0) && (
                      <span className="text-xs font-mono text-muted-foreground ml-1">
                        {timelineSteps.filter(s => s.status === "success" && s.type !== "precheck" && s.type !== "postcheck").length}/{(stableTask?.steps as Array<unknown> ?? timelineSteps.filter(s => s.type !== "precheck" && s.type !== "postcheck")).length} steps
                      </span>
                    )}
                  </CardTitle>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {isRunning && !isDone ? "live" : isDone ? (displayEntries.find(e => e.type === "done")?.success ? "✓ completed" : "✗ failed") : "last run"}
                  </span>
                </CardHeader>
                <CardContent className="p-0">
                  {/* Vertical Step Timeline */}
                    {(() => {
                      const taskConfigSteps = (stableTask?.steps as Array<{type: string}> ?? []);
                      const lastCompletedStep = timelineSteps.length > 0 ? Math.max(...timelineSteps.map(s => s.index)) : 0;
                      const currentRunningStep = (isRunning && !isDone) ? lastCompletedStep + 1 : -1;
                      const allSteps = taskConfigSteps.length > 0 ? taskConfigSteps : timelineSteps.map(s => ({ type: s.type }));

                      if (allSteps.length === 0) {
                        if (isRunning && !isDone) {
                          return (
                            <div className="flex items-center gap-2 px-4 py-8 text-xs text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Waiting for steps to begin…
                            </div>
                          );
                        }
                        return null;
                      }

                      return (
                        <div className="px-4 py-3">
                            {/* Precheck Screenshot — 真实 Step 编号之外的预检截图 */}
                            {precheckScreenshotEntry && (() => {
                              return (
                                <div className="flex gap-3 min-h-0">
                                  <div className="flex flex-col items-center" style={{ width: 20 }}>
                                    <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "rgb(168,85,247)", position: "relative", marginTop: 2 }} />
                                    <div style={{ width: 2, flex: 1, marginTop: 4, minHeight: 16, backgroundColor: "rgba(168,85,247,0.3)" }} />
                                  </div>
                                  <div className="flex-1 pb-3 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-purple-500/30 bg-purple-500/10 text-purple-500 font-medium">precheck</span>
                                      <span className="text-[10px] font-mono text-purple-400">{precheckScreenshotEntry.message.replace("Precheck: ", "")}</span>
                                      {stableTask?.targetUrl && <span className="text-[10px] font-mono text-purple-300/50 truncate max-w-[220px]" title={stableTask.targetUrl}>{stableTask.targetUrl}</span>}
                                      <CheckCircle2 className="h-3 w-3 text-purple-400 shrink-0" />
                                    </div>
                                  </div>
                                </div>
                              );
                            })()}
                          {allSteps.map((configStep, i) => {
                            const stepNumber = i + 1;
                            const executed = timelineSteps.find(s => s.index === stepNumber);
                            const isCurrentlyRunning = currentRunningStep === stepNumber;
                            const isPending = !executed && !isCurrentlyRunning;
                            const status = executed ? executed.status : isCurrentlyRunning ? "running" : "pending";
                            const isLastStep = i === allSteps.length - 1;
                            const fname = executed?.screenshotPath?.split("/").pop();
                            const src = fname ? `/api/tasks/${taskId}/step-screenshots/${fname}` : undefined;
                            const stepIcon =
                              configStep.type === "navigate"   ? <Navigation className="h-3 w-3 shrink-0" /> :
                              configStep.type === "click"      ? <MousePointer className="h-3 w-3 shrink-0" /> :
                              configStep.type === "fill"       ? <Keyboard className="h-3 w-3 shrink-0" /> :
                              configStep.type === "wait"       ? <Clock className="h-3 w-3 shrink-0" /> :
                              configStep.type === "waitFor"    ? <Eye className="h-3 w-3 shrink-0" /> :
                              configStep.type === "screenshot" ? <Camera className="h-3 w-3 shrink-0" /> :
                              configStep.type === "login"      ? <Shield className="h-3 w-3 shrink-0" /> :
                              <Zap className="h-3 w-3 shrink-0" />;
                            return (
                              <div key={i} className="flex gap-3 min-h-0">
                                {/* Left rail */}
                                <div className="flex flex-col items-center" style={{ width: 20 }}>
                                  <div className="relative mt-0.5 shrink-0" style={{ width: 12, height: 12 }}>
                                    {isCurrentlyRunning && (
                                      <div className="absolute inset-0 rounded-full bg-blue-500/40 animate-ping" style={{ margin: -3 }} />
                                    )}
                                    <div style={{
                                      width: 12, height: 12, borderRadius: "50%", position: "relative",
                                      backgroundColor:
                                        status === "success" ? "rgb(34,197,94)" :
                                        status === "failed"  ? "rgb(239,68,68)" :
                                        status === "running" ? "rgb(59,130,246)" : "transparent",
                                      border: status === "pending" ? "1.5px solid rgba(100,116,139,0.35)" : "none"
                                    }} />
                                  </div>
                                  {(!isLastStep || !!finalScreenshotEntry) && (
                                    <div style={{
                                      width: 2, flex: 1, marginTop: 4, minHeight: 16,
                                      backgroundColor:
                                        status === "success" ? "rgba(34,197,94,0.35)" :
                                        status === "failed"  ? "rgba(239,68,68,0.25)" :
                                        "rgba(100,116,139,0.15)"
                                    }} />
                                  )}
                                </div>
                                {/* Step content */}
                                <div className={`flex-1 pb-4 min-w-0 ${isPending ? "opacity-40" : ""}`}>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border font-medium ${
                                      status === "failed"  ? "border-destructive/30 bg-destructive/10 text-destructive" :
                                      status === "running" ? "border-blue-500/30 bg-blue-500/10 text-blue-500" :
                                      status === "success" ? "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400" :
                                      "border-muted-foreground/20 bg-muted/30 text-muted-foreground"
                                    }`}>
                                      {configStep.type}
                                    </span>
                                    <span className="text-muted-foreground/50">{stepIcon}</span>
                                    {status === "success" && <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />}
                                    {status === "failed"  && <XCircle className="h-3 w-3 text-destructive shrink-0" />}
                                    {status === "running" && <Loader2 className="h-3 w-3 text-blue-500 animate-spin shrink-0" />}
                                  </div>
                                  {executed && (
                                    <p className="text-xs text-muted-foreground mt-1 break-all leading-relaxed">{executed.message}</p>
                                  )}
                                  {src && (
                                    <Dialog>
                                      <DialogTrigger asChild>
                                        <button className="mt-2 cursor-zoom-in block" type="button">
                                          <img src={src} alt={`Step ${stepNumber} screenshot`} className="max-h-40 rounded border border-border hover:border-primary/50 transition-colors" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).insertAdjacentHTML("afterend", '<p class="text-xs text-zinc-500 font-mono py-1">截图已过期</p>'); }} />
                                        </button>
                                      </DialogTrigger>
                                      <DialogContent className="max-w-5xl bg-zinc-950 border-zinc-800 p-1">
                                        <img src={src} alt={`Step ${stepNumber} screenshot`} className="w-full h-auto object-contain max-h-[85vh]" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).insertAdjacentHTML("afterend", '<p class="text-sm text-zinc-500 font-mono text-center py-8">截图已过期</p>'); }} />
                                      </DialogContent>
                                    </Dialog>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                          {/* Extra steps from stream not in config (edge case) */}
                          {timelineSteps.filter(s => s.index > allSteps.length).map((step) => {
                            const efname = step.screenshotPath?.split("/").pop();
                            const esrc = efname ? `/api/tasks/${taskId}/step-screenshots/${efname}` : undefined;
                            return (
                              <div key={step.index} className="flex gap-3">
                                <div className="flex flex-col items-center" style={{ width: 20 }}>
                                  <div style={{ width: 12, height: 12, borderRadius: "50%", marginTop: 2, backgroundColor: step.status === "success" ? "rgb(34,197,94)" : "rgb(239,68,68)" }} />
                                </div>
                                <div className="flex-1 pb-4 min-w-0">
                                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${step.status === "success" ? "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400" : "border-destructive/30 bg-destructive/10 text-destructive"}`}>{step.type}</span>
                                  <p className="text-xs text-muted-foreground mt-1">{step.message}</p>
                                  {esrc && <img src={esrc} alt={`Step ${step.index}`} className="mt-2 max-h-40 rounded border border-border" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).insertAdjacentHTML("afterend", '<p class="text-xs text-zinc-500 font-mono py-1">截图已过期</p>'); }} />}
                                </div>
                              </div>
                            );
                          })}
                            {/* Final Screenshot — 真实 Step 编号之外的最终截图 */}
                            {finalScreenshotEntry && (() => {
                              const ffname = finalScreenshotEntry.screenshotPath?.split("/").pop();
                              const fsrc = ffname ? `/api/tasks/${taskId}/step-screenshots/${ffname}` : undefined;
                              return (
                                <div className="flex gap-3 min-h-0">
                                  <div className="flex flex-col items-center" style={{ width: 20 }}>
                                    <div style={{ width: 2, height: 16, backgroundColor: (() => { const lastStep = timelineSteps.length > 0 ? timelineSteps.reduce((a, b) => a.index > b.index ? a : b) : null; return lastStep?.status === "success" ? "rgba(34,197,94,0.35)" : lastStep?.status === "failed" ? "rgba(239,68,68,0.25)" : "rgba(100,116,139,0.15)"; })() }} />
                                    <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "rgb(59,130,246)", position: "relative" }} />
                                  </div>
                                  <div className="flex-1 pb-3 pt-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-blue-500/30 bg-blue-500/10 text-blue-500 font-medium">postcheck</span>
                                      <Camera className="h-3 w-3 text-blue-400 shrink-0" />
                                      {(() => { const u = finalScreenshotEntry.message.split("|")[1]; return u ? <span className="text-[10px] font-mono text-blue-300/50 truncate max-w-[220px]" title={u}>{u}</span> : null; })()}
                                      <CheckCircle2 className="h-3 w-3 text-blue-400 shrink-0" />
                                    </div>
                                    {fsrc && (
                                      <Dialog>
                                        <DialogTrigger asChild>
                                          <button className="mt-2 cursor-zoom-in block" type="button">
                                            <img src={fsrc} alt="Postcheck screenshot" className="max-h-40 rounded border border-border hover:opacity-80 transition-opacity" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).insertAdjacentHTML("afterend", '<p class="text-xs text-zinc-500 font-mono py-1">截图已过期</p>'); }} />
                                          </button>
                                        </DialogTrigger>
                                        <DialogContent className="max-w-5xl bg-zinc-950 border-zinc-800 p-1">
                                          <img src={fsrc} alt="Postcheck screenshot" className="w-full h-auto object-contain max-h-[85vh]" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).insertAdjacentHTML("afterend", '<p class="text-sm text-zinc-500 font-mono text-center py-8">截图已过期</p>'); }} />
                                        </DialogContent>
                                      </Dialog>
                                    )}
                                  </div>
                                </div>
                              );
                            })()}
                        </div>
                      );
                    })()}
                </CardContent>
              </Card>
            )}



                      {/* Execution Logs */}
              <Card className="border-border shadow-sm overflow-hidden">
                <CardHeader className="bg-muted/20 border-b border-border pb-4 shrink-0 flex flex-row items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-primary" /> Execution Logs
                  </CardTitle>
                  <Badge variant="secondary" className="font-mono">{logs?.length || 0} Records</Badge>
                </CardHeader>
                <div className="p-0">
                  {isLoadingLogs ? (
                    <div className="p-4 space-y-3">
                      {[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
                    </div>
                  ) : logs && logs.length > 0 ? (
                    <div>
                      <div className="divide-y divide-border">
                        {logs.slice(0, 3).map((log) => {
                          const isDryRunLog = log.message.startsWith("[DRY RUN]");
                          type StepLog = { stepIndex: number; type: string; success: boolean; message: string; screenshotPath?: string | null };
                          const stepLogs = ((log as any).stepLogs ?? []) as StepLog[];
                          return (
                            <Link key={log.id} href={"/tasks/" + taskId + "/logs/" + log.id}>
                              <div className="px-4 py-3 hover:bg-muted/40 transition-colors cursor-pointer">
                                {/* Row header */}
                                <div className="flex items-center justify-between gap-2 mb-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    {log.success
                                      ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
                                      : <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />}
                                    <span className="text-xs font-mono text-muted-foreground">
                                      {formatDistanceToNow(new Date(log.runAt))} ago
                                    </span>
                                    {log.durationMs != null && (
                                      <span className="text-xs font-mono text-muted-foreground/60">
                                        · {log.durationMs >= 60000 ? Math.round(log.durationMs / 60000) + "m" : (log.durationMs / 1000).toFixed(1) + "s"}
                                      </span>
                                    )}
                                    {isDryRunLog && (
                                      <span className="inline-flex items-center gap-1 rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-violet-500 font-mono">
                                        <FlaskConical className="h-2.5 w-2.5" /> DRY RUN
                                      </span>
                                    )}
                                  </div>
                                  <span className="text-[11px] text-muted-foreground shrink-0">View →</span>
                                </div>
                                {/* Horizontal step pills */}
                                {stepLogs.length > 0 ? (
                                  <div className="flex items-center gap-1 flex-wrap">
                                    {stepLogs.map((step, si) => {
                                      const isPrecheck = step.type === "precheck";
                                      const isPostcheck = step.type === "postcheck";
                                      const pillClass = isPrecheck
                                        ? "bg-purple-500/10 border-purple-500/30 text-purple-500"
                                        : isPostcheck
                                        ? "bg-blue-500/10 border-blue-500/30 text-blue-500"
                                        : step.success
                                        ? "bg-green-500/5 border-green-500/20 text-green-600"
                                        : "bg-destructive/10 border-destructive/30 text-destructive";
                                      return (
                                        <span key={si} className={"inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono border " + pillClass}>
                                          {step.success ? "✓" : "✗"} {step.type}
                                        </span>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <p className="text-xs font-mono text-muted-foreground truncate">
                                    {(isDryRunLog ? log.message.slice("[DRY RUN] ".length) : log.message).split("\n")[0]}
                                  </p>
                                )}
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                      {logs.length > 3 && (
                        <div className="border-t border-border px-4 py-3">
                          <Link href={"/logs?taskId=" + taskId}>
                            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer py-1">
                              <Terminal className="h-3 w-3" />
                              {t.runHistory}
                            </div>
                          </Link>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-8 text-center">
                      <p className="text-sm text-muted-foreground">Run this task to generate logs.</p>
                    </div>
                  )}
                </div>
              </Card>
        </div>

        {/* Right Column: Credentials Summary */}
        <div className="space-y-6">
          <Card className="border-border shadow-sm">
            <CardHeader className="bg-muted/20 border-b border-border pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="h-4 w-4 text-primary" /> {t.credentials}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {((task as any).loginCredentials?.length > 0) ? (
                <div className="space-y-4">
                  {((task as any).loginCredentials as Array<{ loginMethod: string; username: string; hasTotpSecret: boolean }>).map((cred, idx) => (
                    <div key={idx} className="space-y-2 p-3 border border-border rounded-md bg-card">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Login {((task as any).loginCredentials.length > 1) ? `#${idx + 1}` : ""} ({cred.loginMethod})</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">{t.username}</span>
                        <span className="text-sm font-mono font-semibold">{cred.username}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Password</span>
                        <span className="text-sm font-mono tracking-widest">••••••••</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">2FA (TOTP)</span>
                        <Badge variant={cred.hasTotpSecret ? "default" : "secondary"} className="font-mono text-[10px]">
                          {cred.hasTotpSecret ? "CONFIGURED" : "NONE"}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              ) : task.credentials?.username ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3 border border-border rounded-md bg-card">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{t.username}</span>
                    <span className="text-sm font-mono font-semibold">{task.credentials.username}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 border border-border rounded-md bg-card">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Password</span>
                    <span className="text-sm font-mono tracking-widest">••••••••</span>
                  </div>
                  <div className="flex items-center justify-between p-3 border border-border rounded-md bg-card">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">2FA (TOTP)</span>
                    <Badge variant={task.credentials.hasTotpSecret ? "default" : "secondary"} className="font-mono text-[10px]">
                      {task.credentials.hasTotpSecret ? "CONFIGURED" : "NONE"}
                    </Badge>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No credentials configured for this task.</p>
              )}
            </CardContent>
          </Card>


            {/* Run History Chart */}
            {runHistory.length > 0 && (
              <Card className="border-border shadow-sm">
                <CardHeader className="bg-muted/20 border-b border-border pb-4">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Radio className="h-4 w-4 text-primary" /> Run History (30d)
                  </CardTitle>
                  <CardDescription className="text-xs font-mono mt-1">
                    Success/failure per day
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-4 pb-2">
                  <TaskHistoryChart runHistory={runHistory} />
                  <div className="flex items-center justify-center gap-4 mt-1">
                    <div className="flex items-center gap-1.5">
                      <div className="h-2 w-2 rounded-sm" style={{ background: "hsl(142, 76%, 36%)" }} />
                      <span className="text-xs text-muted-foreground font-mono">{t.statusSuccess}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="h-2 w-2 rounded-sm" style={{ background: "hsl(0, 72%, 51%)" }} />
                      <span className="text-xs text-muted-foreground font-mono">{t.statusFailed}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

        </div>
      </div>
    </div>
  );
}
