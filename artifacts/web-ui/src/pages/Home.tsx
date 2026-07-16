import { useState, useEffect, useRef, useMemo } from "react";
import { useListTasks, useGetTasksSummary, useRunTask, useGetTasksHistory, useToggleTaskEnabled, getListTasksQueryKey, getGetTasksSummaryQueryKey, getGetTasksHistoryQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Plus, Play, Clock, CheckCircle2, XCircle, Activity, Loader2, ArrowRight, AlertTriangle, X, BarChart2, CalendarClock, Timer, Copy, Archive, Download, Upload, Search } from "lucide-react";
import { FaWindows, FaApple, FaLinux, FaAndroid } from "react-icons/fa";
import type { IconType } from "react-icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow, format } from "date-fns";
import { usePollingInterval } from "@/hooks/use-polling-interval";
  import { Switch } from "@/components/ui/switch";
import { usePollPaused } from "@/contexts/poll-paused-context";
import { useLang } from "@/contexts/lang-context";
import { useSearch, useLocation } from "wouter";
import { StatusBadge, StatusIcon } from "@/components/StatusBadge";

import HomeRunChart from "@/components/HomeRunChart";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");


  // ── Snake Metro Map ──────────────────────────────────────────────────────────
  const METRO_DOTS_PER_ROW = 20;

  interface MetroDot {
    stepIndex: number;
    status: "success" | "failed" | "running" | "pending";
    type?: string;
    message?: string;
  }

  function SnakeMetroMap({ totalSteps, dots }: { totalSteps: number; dots: MetroDot[] }) {
    const dotMap = new Map(dots.map(d => [d.stepIndex, d]));
    const rows: number[][] = [];
    for (let i = 0; i < totalSteps; i += METRO_DOTS_PER_ROW) {
      rows.push(Array.from({ length: Math.min(METRO_DOTS_PER_ROW, totalSteps - i) }, (_, j) => i + j));
    }
    const ROW_GAP = 20;
    const DOT_SIZE = 8;

    return (
      <TooltipProvider delayDuration={150}>
        <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
          {rows.map((row, rowIdx) => {
            const isReversed = rowIdx % 2 === 1;
            const displayRow = isReversed ? [...row].reverse() : row;
            const isLastRow = rowIdx === rows.length - 1;
            const lastLogicalStep = row[row.length - 1];
            const lastDot = dotMap.get(lastLogicalStep);
            const connectorDone = lastDot?.status === "success" || lastDot?.status === "failed";
            const connectorColor = connectorDone ? "rgba(34,197,94,0.6)" : "rgba(100,116,139,0.2)";
            return (
              <div key={rowIdx} style={{ position: "relative" }}>
                <div style={{ display: "flex", alignItems: "center" }}>
                  {displayRow.map((stepIdx, dotIdx) => {
                    const dot = dotMap.get(stepIdx);
                    const status = dot?.status ?? "pending";
                    const isLastDotInRow = dotIdx === displayRow.length - 1;
                    const lineActive = status === "success" || status === "failed";
                    const lineColor = lineActive ? "rgba(34,197,94,0.4)" : "rgba(100,116,139,0.15)";
                    const tooltipLabel = dot?.type ? ("Step " + (stepIdx + 1) + " · " + dot.type) : ("Step " + (stepIdx + 1));
                    return (
                      <div key={stepIdx} style={{ display: "flex", alignItems: "center", flex: isLastDotInRow ? "0 0 auto" : 1, minWidth: isLastDotInRow ? "auto" : 10 }}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div style={{ position: "relative", width: DOT_SIZE, height: DOT_SIZE, flexShrink: 0, cursor: "default" }}>
                              {status === "running" && (
                                <div className="animate-ping" style={{ position: "absolute", inset: -3, borderRadius: "50%", backgroundColor: "rgba(59,130,246,0.35)" }} />
                              )}
                              <div style={{
                                width: DOT_SIZE, height: DOT_SIZE, borderRadius: "50%", position: "relative",
                                backgroundColor: status === "success" ? "rgb(34,197,94)" : status === "failed" ? "rgb(239,68,68)" : status === "running" ? "rgb(59,130,246)" : "transparent",
                                border: status === "pending" ? "1.5px solid rgba(100,116,139,0.3)" : "none"
                              }} />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-xs">
                            <p className="text-xs font-mono font-semibold">{tooltipLabel}</p>
                            {dot?.message && <p className="text-xs text-muted-foreground mt-0.5 break-all">{dot.message.slice(0, 120)}</p>}
                            {!dot && <p className="text-xs text-muted-foreground italic">Pending</p>}
                            {status === "running" && <p className="text-xs text-blue-400 font-semibold">Running</p>}
                          </TooltipContent>
                        </Tooltip>
                        {!isLastDotInRow && (
                          <div style={{ flex: 1, height: 2, backgroundColor: lineColor, minWidth: 6 }} />
                        )}
                      </div>
                    );
                  })}
                </div>
                {!isLastRow && (() => {
                  const side = isReversed ? "left" : "right";
                  const borderSide = isReversed ? "borderLeft" : "borderRight";
                  const borderVal = "2px solid " + connectorColor;
                  const style: React.CSSProperties = {
                    position: "absolute",
                    top: DOT_SIZE / 2 - 1,
                    width: 10,
                    height: ROW_GAP + DOT_SIZE / 2 + 2,
                    borderTop: 0,
                    borderBottom: borderVal,
                    borderRadius: isReversed ? "6px 0 0 6px" : "0 6px 6px 0",
                  };
                  if (isReversed) { style.left = -1; style.borderLeft = borderVal; style.borderRight = "none"; }
                  else { style.right = -1; style.borderRight = borderVal; style.borderLeft = "none"; }
                  return <div style={style} />;
                })()}
              </div>
            );
          })}
        </div>
      </TooltipProvider>
    );
  }
  // ────────────────────────────────────────────────────────────────────────────

  // ── Exit-IP flag + fingerprint OS badge (task list) ──────────────────────────

  // fingerprint OS → real brand logo (react-icons). Empty/unknown defaults to Linux
  // (the default fingerprint), so every task shows a proper platform icon.
  function osMeta(os?: string | null): { Icon: IconType; label: string } {
    const v = (os ?? "").toLowerCase();
    if (v.includes("win")) return { Icon: FaWindows, label: "Windows" };
    if (v.includes("mac") || v.includes("darwin") || v.includes("apple") || v.includes("ios") || v.includes("iphone")) return { Icon: FaApple, label: "macOS / iOS" };
    if (v.includes("android")) return { Icon: FaAndroid, label: "Android" };
    return { Icon: FaLinux, label: v ? "Linux" : "Linux (default)" };
  }

  type TaskGeo = { direct?: boolean; ok?: boolean; exitIp?: string; country?: string; countryCode?: string; city?: string; region?: string };

  interface RecentRun { success: boolean; runAt: string; durationMs: number | null }

  /**
   * Uptime-style outcome squares for a task's last runs (oldest→newest).
   *
   * The row only ever showed the LATEST run, so "9 passes and 1 failure" looked
   * identical to "10 passes". These make a one-off failure obvious without opening
   * the task; hover gives the timestamp and duration.
   */
  function RunSquares({ runs }: { runs: RecentRun[] }) {
    if (!runs.length) return null;
    const failed = runs.filter((r) => !r.success).length;
    return (
      <TooltipProvider delayDuration={100}>
        <span className="flex items-center gap-[3px]" title={`最近 ${runs.length} 次：${runs.length - failed} 成功 / ${failed} 失败`}>
          {runs.map((r, i) => (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <span
                  className={`inline-block h-3 w-[6px] rounded-[1px] ${r.success ? "bg-green-500/70" : "bg-destructive"}`}
                />
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs font-mono">
                  {r.success ? "✓ 成功" : "✗ 失败"} · {format(new Date(r.runAt), "MM-dd HH:mm")}
                  {r.durationMs != null && ` · ${(r.durationMs / 1000).toFixed(1)}s`}
                </p>
              </TooltipContent>
            </Tooltip>
          ))}
        </span>
      </TooltipProvider>
    );
  }

  // Country-flag badge for a task row, read from the task's CACHED exit_geo
  // (resolved in the background on create/update). No live query on render.
  // Rendered as an <img> (flagcdn) rather than a flag emoji — Windows browsers
  // don't render regional-indicator flag emoji, they show the letters instead.
  function TaskExitFlag({ geo }: { geo?: TaskGeo | null }) {
    const cc = geo?.countryCode?.toLowerCase();
    if (!geo?.ok || !cc || cc.length !== 2) return null;
    const loc = [geo.city, geo.region, geo.country].filter(Boolean).join(", ");
    return (
      <span className="flex items-center border-l border-border pl-3" title={`${geo.direct ? "Host exit IP" : "Proxy exit IP"}: ${geo.exitIp ?? ""}${loc ? " · " + loc : ""}`}>
        <img
          src={`https://flagcdn.com/20x15/${cc}.png`}
          srcSet={`https://flagcdn.com/40x30/${cc}.png 2x`}
          width={20}
          height={15}
          alt={geo.countryCode}
          loading="lazy"
          className="rounded-[1px]"
        />
      </span>
    );
  }
  // ────────────────────────────────────────────────────────────────────────────

  // ── Next-run countdown ────────────────────────────────────────────────────────

interface NextRun { taskId: number; nextRunAt: string | null }

function formatCountdown(targetIso: string): string {
  const diff = Math.floor((new Date(targetIso).getTime() - Date.now()) / 1000);
  if (diff <= 0) return "imminently";
  if (diff < 60) return `${diff}s`;
  const m = Math.floor(diff / 60) % 60;
  const h = Math.floor(diff / 3600) % 24;
  const d = Math.floor(diff / 86400);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${diff % 60}s`;
}

function NextRunBadge({ nextRunAt }: { nextRunAt: string | null }) {
  const [label, setLabel] = useState<string>("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!nextRunAt) { setLabel(""); return; }
    setLabel(formatCountdown(nextRunAt));
    timerRef.current = setInterval(() => setLabel(formatCountdown(nextRunAt)), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [nextRunAt]);

  if (!nextRunAt || !label) return null;
  return (
    <span className="flex items-center gap-1 border-l border-border pl-3 text-primary/80">
      <CalendarClock className="h-3 w-3" />
      <span>in {label}</span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────


  // ── Last-run badge ────────────────────────────────────────────────────────────
  interface LastRun { taskId: number; success: boolean; runAt: string; durationMs: number | null }

  function LastRunBadge({ lastRun }: { lastRun: LastRun | undefined }) {
    const { t: tLR } = useLang();
    if (!lastRun) {
      return <span className="text-xs font-mono text-muted-foreground/50 italic">{tLR.neverRun}</span>;
    }
    const ago = formatDistanceToNow(new Date(lastRun.runAt), { addSuffix: true });
    const dur = lastRun.durationMs != null
      ? lastRun.durationMs >= 60000
        ? `${Math.round(lastRun.durationMs / 60000)}m`
        : `${(lastRun.durationMs / 1000).toFixed(1)}s`
      : null;
    return lastRun.success ? (
      <span className="flex items-center gap-1 text-xs font-mono text-green-600 dark:text-green-400">
        <CheckCircle2 className="h-3 w-3" />
        <span>{ago}</span>
        {dur && <span className="text-muted-foreground/60">· {dur}</span>}
      </span>
    ) : (
      <span className="flex items-center gap-1 text-xs font-mono text-destructive">
        <XCircle className="h-3 w-3" />
        <span>{ago}</span>
        {dur && <span className="text-muted-foreground/60">· {dur}</span>}
      </span>
    );
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const VALID_FILTERS = ["running", "queued", "success", "failed", "needs_attention"] as const;
type FilterValue = typeof VALID_FILTERS[number];

export default function Home() {
  const { t } = useLang();
  const [pollingInterval] = usePollingInterval();
  const { paused } = usePollPaused();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const rawFilter = params.get("filter");
  const activeFilter: FilterValue | null = VALID_FILTERS.includes(rawFilter as FilterValue) ? (rawFilter as FilterValue) : null;

  const { data: nextRuns = [] } = useQuery<NextRun[]>({
    queryKey: ["task-next-runs"],
    queryFn: () => fetch(`${BASE}/api/tasks/next-runs`).then((r) => r.ok ? r.json() : []),
    staleTime: 0,
    refetchInterval: 5_000,
  });
    const [runningTaskIds, setRunningTaskIds] = useState<Set<number>>(new Set());
    const [fastPollUntil, setFastPollUntil] = useState<number>(0);
  const [pendingEnabled, setPendingEnabled] = useState<Map<number, boolean>>(new Map());

    // ── Step progress tracking types & state (SSE) ──────────────────────────
    interface TaskStepProgress {
      completedSteps: Map<number, { type: string; message: string; status: "success" | "failed" }>;
      totalSteps: number;
    }
    const [stepProgressMap, setStepProgressMap] = useState<Map<number, TaskStepProgress>>(new Map());
    const sseRefsMap = useRef<Map<number, EventSource>>(new Map());

  const nextRunMap = new Map(nextRuns.map((r) => [r.taskId, r.nextRunAt]));

  const { data: lastRuns } = useQuery<LastRun[]>({
    queryKey: ["task-last-runs"],
    queryFn: () => fetch(`${BASE}/api/tasks/last-runs`).then((r) => r.json()),
    staleTime: 0,
    refetchInterval: 5_000,
  });

  // Recent outcomes for the uptime squares. Polled less often than last-runs — it's a
  // trend strip, not a live indicator.
  const { data: recentRuns } = useQuery<Array<{ taskId: number; runs: RecentRun[] }>>({
    queryKey: ["task-recent-runs"],
    queryFn: () => fetch(`${BASE}/api/tasks/recent-runs?limit=12`).then((r) => r.json()),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
  const recentRunMap = new Map((recentRuns ?? []).map((r) => [r.taskId, r.runs]));

  const setActiveFilter = (filter: FilterValue | null) => {
    const next = new URLSearchParams(search);
    if (filter) {
      next.set("filter", filter);
    } else {
      next.delete("filter");
    }
    const qs = next.toString();
    setLocation(qs ? `/?${qs}` : "/", { replace: true });
  };

  const { data: tasks, isLoading: isLoadingTasks } = useListTasks({
    query: {
      queryKey: getListTasksQueryKey(),
      refetchInterval: (query) => {
        const now = Date.now();
        if (!paused && now < fastPollUntil) return 500;
        if (!paused && query.state.data?.some((t) => t.status === "running")) return pollingInterval;
        return paused ? false : 30_000; // background poll so cron-triggered tasks are detected
      },
    },
  });

  const hasRunning = !paused && ((tasks?.some((t) => t.status === "running") ?? false) || runningTaskIds.size > 0);
  const lastRunMap = new Map((lastRuns ?? []).map((r) => [r.taskId, r]));

    // ── Step progress tracking for running tasks (SSE) ──────────────────────────
    const runningTaskSet = useMemo(() =>
      new Set((tasks ?? []).filter(t => t.status === "running" || runningTaskIds.has(t.id)).map(t => t.id)),
      [tasks, runningTaskIds]
    );

    useEffect(() => {
      // Close SSE for tasks no longer running
      for (const [id, es] of sseRefsMap.current) {
        if (!runningTaskSet.has(id)) {
          es.close();
          sseRefsMap.current.delete(id);
          setStepProgressMap(prev => { const n = new Map(prev); n.delete(id); return n; });
        }
      }
      // Open SSE for newly running tasks
      for (const task of (tasks ?? [])) {
        if ((!runningTaskSet.has(task.id)) || sseRefsMap.current.has(task.id)) continue;
        const totalSteps = Array.isArray(task.steps) ? (task.steps as unknown[]).length : 0;
        if (totalSteps === 0) continue;
        const id = task.id;
        const es = new EventSource(`${BASE}/api/tasks/${id}/logs/stream`, { withCredentials: true });
        sseRefsMap.current.set(id, es);
        es.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data as string) as { type: string; message: string };
            if (data.type === "progress") {
              const sm = data.message.match(/^Step (\d+) \[(\w+)\]: (.+)/s);
              const fm = data.message.match(/^Step (\d+) \[(\w+)\] FAILED: (.+)/s);
              const m = sm ?? fm;
              if (m) {
                const stepNum = parseInt(m[1], 10);
                const stepType = m[2];
                const msg = m[3].trim().slice(0, 120);
                const failed = !!fm;
                setStepProgressMap(prev => {
                  const next = new Map(prev);
                  const cur = next.get(id) ?? { completedSteps: new Map(), totalSteps };
                  const newCompleted = new Map(cur.completedSteps);
                  newCompleted.set(stepNum, { type: stepType, message: msg, status: failed ? "failed" : "success" });
                  next.set(id, { completedSteps: newCompleted, totalSteps });
                  return next;
                });
              }
            } else if (data.type === "done") {
              es.close();
              sseRefsMap.current.delete(id);
              queryClient.invalidateQueries({ queryKey: ["task-next-runs"] });
              queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
              queryClient.invalidateQueries({ queryKey: getGetTasksSummaryQueryKey() });
            }
          } catch { /* ignore parse errors */ }
        };
        es.onerror = () => { es.close(); sseRefsMap.current.delete(id); };
      }
    }, [runningTaskSet, tasks]);

    useEffect(() => {
      return () => { for (const es of sseRefsMap.current.values()) es.close(); };
    }, []);
    // ────────────────────────────────────────────────────────────────────────────

    // Clear optimistic running state once backend confirms the new status
    useEffect(() => {
      if (!tasks || runningTaskIds.size === 0) return;
      setRunningTaskIds((prev) => {
        const next = new Set(prev);
        for (const id of prev) {
          const t = tasks.find((t) => t.id === id);
          if (t && t.status !== "idle") next.delete(id);
        }
        return next;
      });
    }, [tasks]);
  const statusFiltered = activeFilter
    ? (tasks ?? []).filter((t) => {
        if (activeFilter === "failed") return t.status === "failed" || t.status === "needs_attention";
        return t.status === activeFilter;
      })
    : (tasks ?? []);
  // Search matches the name AND the target URL — with many tasks on the same panel,
  // the URL is often what you actually remember.
  const [searchQuery, setSearchQuery] = useState("");
  const q = searchQuery.trim().toLowerCase();
  const displayedTasks = q
    ? statusFiltered.filter(
        (t) =>
          t.name.toLowerCase().includes(q) || (t.targetUrl ?? "").toLowerCase().includes(q),
      )
    : statusFiltered;

  const toggleFilter = (status: FilterValue) => {
    setActiveFilter(activeFilter === status ? null : status);
  };

  const { data: summary, isLoading: isLoadingSummary } = useGetTasksSummary({
    query: {
      queryKey: getGetTasksSummaryQueryKey(),
      refetchInterval: hasRunning ? pollingInterval : (paused ? false : 30_000),
    },
  });

  const { data: history, isLoading: isLoadingHistory } = useGetTasksHistory({
    query: {
      queryKey: getGetTasksHistoryQueryKey(),
      staleTime: 5 * 60 * 1000,
    },
  });

  const runTask = useRunTask();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const toggleEnabled = useToggleTaskEnabled();

  const handleToggleEnabled = (id: number, enabled: boolean) => {
    setPendingEnabled(prev => new Map(prev).set(id, enabled));
    toggleEnabled.mutate({ id, data: { enabled } }, {
      onSuccess: async () => {
        // Keep pendingEnabled set during refetch so the switch doesn't flash back
        await queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        setPendingEnabled(prev => { const m = new Map(prev); m.delete(id); return m; });
        toast({ title: enabled ? t.taskEnabled : t.taskDisabled, description: enabled ? t.taskEnabledDesc : t.taskDisabledDesc, variant: enabled ? "success" : "default" });
      },
      onError: () => {
        setPendingEnabled(prev => { const m = new Map(prev); m.delete(id); return m; });
        toast({ title: t.failedToUpdate, variant: "destructive" });
      },
    });
  };

  const handleStop = (id: number) => {
      fetch(`${BASE}/api/tasks/${id}/stop`, { method: "POST" })
        .then((r) => r.ok ? r.json() : Promise.reject(r))
        .then(() => {
          toast({ title: t.cancelRequested, description: t.cancelRequestedDesc, variant: "success" });
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetTasksSummaryQueryKey() });
        })
        .catch(() => toast({ title: t.failedToCancel, variant: "destructive" }));
    };

  /** Hidden <input type=file> driven by the Import menu item. */
  const importInputRef = useRef<HTMLInputElement>(null);

  /** Download a JSON backup (or a value-stripped template) of every task. */
  const handleExport = (template: boolean) => {
    const a = document.createElement("a");
    a.href = `${BASE}/api/tasks/backup/export${template ? "?template=1" : ""}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  /** Import an export file. Additive — imported tasks arrive disabled, nothing is overwritten. */
  const handleImportFile = (file: File) => {
    file
      .text()
      .then((txt) => JSON.parse(txt) as unknown)
      .then((data) =>
        fetch(`${BASE}/api/tasks/backup/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error))))),
      )
      .then((res: { created: number; skipped: string[] }) => {
        toast({
          title: t.tasksImported,
          description: `${res.created} 个任务已导入（已停用，请检查后再启用）${res.skipped.length ? `；${res.skipped.length} 个跳过` : ""}`,
          variant: "success",
        });
        queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTasksSummaryQueryKey() });
      })
      .catch((err) =>
        toast({
          title: t.failedToImport,
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
      );
  };

  /** Duplicate a task. The clone lands disabled so it can be reviewed before it runs. */
  const handleClone = (id: number) => {
    fetch(`${BASE}/api/tasks/${id}/clone`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(() => {
        toast({ title: t.taskCloned, description: t.taskClonedDesc, variant: "success" });
        queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTasksSummaryQueryKey() });
      })
      .catch(() => toast({ title: t.failedToClone, variant: "destructive" }));
  };

    const handleRun = (id: number) => {
    setRunningTaskIds((prev) => new Set([...prev, id]));
    setFastPollUntil(Date.now() + 30_000);
    runTask.mutate({ id }, {
      onSuccess: () => {
        toast({ title: t.taskTriggered, description: t.taskTriggeredDesc, variant: "success" });
        queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTasksSummaryQueryKey() });
      },
      onError: (err) => {
        toast({ title: t.failedToTrigger, description: err instanceof Error ? err.message : t.failedToTrigger, variant: "destructive" });
      }
    });
  };

  const chartData = history?.map((d) => ({
    date: format(new Date(d.date), "MMM d"),
    Success: d.success,
    Failed: d.failed,
  }));

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{t.dashboard}</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">{t.dashboardSubtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.searchTasks}
              className="h-9 w-44 sm:w-60 rounded-md border border-input bg-background pl-8 pr-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="shadow-sm gap-2">
                <Archive className="h-4 w-4" /> {t.backup}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => handleExport(false)}>
                <Download className="h-4 w-4 mr-2" /> {t.exportTasks}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport(true)}>
                <Download className="h-4 w-4 mr-2" /> {t.exportTemplates}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => importInputRef.current?.click()}>
                <Upload className="h-4 w-4 mr-2" /> {t.importTasks}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Hidden picker driven by the menu item above. */}
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImportFile(f);
              e.target.value = ""; // allow re-importing the same file
            }}
          />
          <Link href="/tasks/new">
            <Button className="shadow-sm font-semibold tracking-wide">
              <Plus className="mr-2 h-4 w-4" /> {t.newMission}
            </Button>
          </Link>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <StatCard title={t.totalJobs} value={summary?.total} icon={<Activity className="h-4 w-4 text-primary" />} isLoading={isLoadingSummary} active={activeFilter === null} activeRing="ring-primary/60" onClick={() => setActiveFilter(null)} />
        <StatCard title={t.runningNow} value={summary?.running} icon={<Loader2 className="h-4 w-4 text-blue-500 animate-spin" />} isLoading={isLoadingSummary} active={activeFilter === "running"} activeRing="ring-blue-500/60" onClick={() => toggleFilter("running")} />
        <StatCard title={t.inQueue} value={summary?.queued} icon={<Timer className="h-4 w-4 text-purple-500" />} isLoading={isLoadingSummary} active={activeFilter === "queued"} activeRing="ring-purple-500/60" onClick={() => toggleFilter("queued")} />
        <StatCard title={t.successLast24h} value={summary?.successLast24h} icon={<CheckCircle2 className="h-4 w-4 text-green-500" />} isLoading={isLoadingSummary} active={activeFilter === "success"} activeRing="ring-green-500/60" onClick={() => toggleFilter("success")} />
        <StatCard title={t.failedLast24h} value={summary?.failedLast24h} icon={<XCircle className="h-4 w-4 text-destructive" />} isLoading={isLoadingSummary} active={activeFilter === "failed"} activeRing="ring-destructive/60" onClick={() => toggleFilter("failed")} />
        <StatCard title={t.needsAttention} value={summary?.needsAttention} icon={<AlertTriangle className="h-4 w-4 text-amber-500" />} isLoading={isLoadingSummary} highlight={!!summary?.needsAttention} active={activeFilter === "needs_attention"} activeRing="ring-amber-500/60" onClick={() => toggleFilter("needs_attention")} />
      </div>

      {/* 7-Day History Chart */}
      <Card className="border-border shadow-sm">
        <CardHeader className="bg-muted/20 border-b border-border pb-4 flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-primary" /> {t.sevenDayHistory}
          </CardTitle>
          <span className="text-xs font-mono text-muted-foreground">{t.successVsFailure}</span>
        </CardHeader>
        <CardContent className="pt-4 pb-2">
          {isLoadingHistory ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <HomeRunChart chartData={chartData ?? []} />
          )}
        </CardContent>
      </Card>

      {/* Tasks List */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <TerminalIcon /> {t.activeConfigurations}
          </h2>
          {activeFilter && (
            <div className={`flex items-center gap-2 text-sm font-mono ${
              activeFilter === "needs_attention" ? "text-amber-600 dark:text-amber-400" :
              activeFilter === "running" ? "text-blue-600 dark:text-blue-400" :
              activeFilter === "queued" ? "text-purple-600 dark:text-purple-400" :
              activeFilter === "success" ? "text-green-600 dark:text-green-400" :
              "text-destructive"
            }`}>
              {activeFilter === "needs_attention" && <AlertTriangle className="h-4 w-4" />}
              {activeFilter === "running" && <Loader2 className="h-4 w-4 animate-spin" />}
              {activeFilter === "queued" && <Timer className="h-4 w-4" />}
              {activeFilter === "success" && <CheckCircle2 className="h-4 w-4" />}
              {activeFilter === "failed" && <XCircle className="h-4 w-4" />}
              <span>
                Showing {displayedTasks.length} {activeFilter === "needs_attention" ? "blocked" : activeFilter === "queued" ? "queued" : activeFilter} task{displayedTasks.length !== 1 ? "s" : ""}
              </span>
              <Button variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs" onClick={() => setActiveFilter(null)}>
                <X className="h-3 w-3" /> {t.reset}
              </Button>
            </div>
          )}
        </div>
        
        {isLoadingTasks ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-md" />)}
          </div>
        ) : displayedTasks.length > 0 ? (
          <div className="grid grid-cols-1 gap-3">
            {displayedTasks.map((task) => {
                const stepProg = stepProgressMap.get(task.id);
                const totalMetroSteps = stepProg?.totalSteps ?? (Array.isArray(task.steps) ? (task.steps as unknown[]).length : 0);
                const completedMetroSteps = stepProg?.completedSteps ?? new Map<number, { type: string; message: string; status: "success" | "failed" }>();
                const lastCompletedNum = completedMetroSteps.size > 0 ? Math.max(...completedMetroSteps.keys()) : 0;
                const isCardRunning = task.status === "running" || runningTaskIds.has(task.id);
                const currentRunningNum = isCardRunning ? lastCompletedNum + 1 : -1;
                const metroDots: MetroDot[] = Array.from({ length: totalMetroSteps }, (_, i) => {
                  const stepNum = i + 1;
                  const done = completedMetroSteps.get(stepNum);
                  const isRunningStep = currentRunningNum === stepNum;
                  const configType = Array.isArray(task.steps) ? (task.steps as Array<{type:string}>)[i]?.type : undefined;
                  return { stepIndex: i, status: done ? done.status : isRunningStep ? "running" : "pending", type: done?.type ?? configType, message: done?.message };
                });
                const showMetro = totalMetroSteps > 0 && isCardRunning;
                return (
              <div
                key={task.id}
                className={`group flex flex-col border rounded-md shadow-sm transition-all duration-200 ${
                  task.status === "needs_attention"
                    ? "bg-amber-500/5 hover:bg-amber-500/10 border-amber-500/30"
                    : "bg-card hover:bg-accent/30 border-border"
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4">
                <div className="flex items-center gap-4">
                  <div className={`h-10 w-10 rounded-sm flex items-center justify-center border ${
                    task.status === "needs_attention"
                      ? "bg-amber-500/10 border-amber-500/30"
                      : "bg-muted border-border"
                  }`}>
                    <StatusIcon status={task.status} />
                  </div>
                  <div>
                    <Link href={`/tasks/${task.id}`} className="font-semibold text-foreground hover:text-primary transition-colors flex items-center gap-2">
                      {task.name}
                    </Link>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground font-mono">
                      <span className="flex items-center gap-1">
                        <TerminalIcon className="h-3 w-3" />
                        {(() => {
                            // A task only logs in if it HAS a login step. `task.loginType`
                            // is a legacy column that defaults to 'form' on old rows, so
                            // falling back to it labelled step-less tasks "Form Login".
                            const steps = (task.steps ?? []) as Array<{ type?: string; loginMethod?: string }>;
                            const loginStep = steps.find((s) => s.type === 'login');
                            if (!loginStep) return 'No login';
                            const method = loginStep.loginMethod ?? task.loginType;
                            return { form: 'Form Login', github: 'GitHub OAuth', google: 'Google OAuth' }[method as string] ?? method ?? 'No login';
                          })()}
                      </span>
                      {(() => {
                        const { Icon, label } = osMeta((task as unknown as { browserConfig?: { fingerprint?: { os?: string | null } | null } }).browserConfig?.fingerprint?.os);
                        return (
                          <span className="flex items-center border-l border-border pl-3" title={`Fingerprint: ${label}`}>
                            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                          </span>
                        );
                      })()}
                      <TaskExitFlag geo={(task as unknown as { exitGeo?: TaskGeo | null }).exitGeo} />
                      <span className="flex items-center gap-1 border-l border-border pl-3">
                        <LastRunBadge lastRun={lastRunMap.get(task.id)} />
                      </span>
                      {(() => {
                        const runs = recentRunMap.get(task.id);
                        return runs?.length ? (
                          <span className="flex items-center border-l border-border pl-3">
                            <RunSquares runs={runs} />
                          </span>
                        ) : null;
                      })()}
                      {task.cronExpression && task.enabled && (
                        <NextRunBadge nextRunAt={nextRunMap.get(task.id) ?? null} />
                      )}
                    </div>
                  </div>
                </div>
                
                <div className="mt-4 sm:mt-0 flex items-center gap-3">
                  <StatusBadge status={runningTaskIds.has(task.id) ? "running" : task.status} />
                  <div className="h-8 w-[1px] bg-border mx-2 hidden sm:block"></div>
                  <div className="flex items-center gap-1.5 mr-1">
                    <Switch
                      checked={pendingEnabled.has(task.id) ? pendingEnabled.get(task.id)! : task.enabled !== false}
                      onCheckedChange={(v) => handleToggleEnabled(task.id, v)}
                      aria-label="Enable task"
                    />
                    <span className="text-xs text-muted-foreground font-mono">{(pendingEnabled.has(task.id) ? pendingEnabled.get(task.id)! : task.enabled !== false) ? "on" : "off"}</span>
                  </div>
                  {(task.status === "running" || runningTaskIds.has(task.id)) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2 text-xs font-medium text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => handleStop(task.id)}
                      >
                        <X className="h-3 w-3" /> Cancel
                      </Button>
                    ) : (
                      <Button 
                        variant={task.status === "needs_attention" ? "default" : "outline"}
                        size="sm" 
                        className={`gap-2 text-xs font-medium ${task.status === "needs_attention" ? "bg-amber-500 hover:bg-amber-600 text-white border-amber-500" : ""}`}
                        onClick={() => handleRun(task.id)}
                        disabled={runTask.isPending || task.enabled === false}
                      >
                        <Play className="h-3 w-3" />
                        {task.status === "needs_attention" ? "Retry" : "Run"}
                      </Button>
                    )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    title={t.cloneTask}
                    onClick={() => handleClone(task.id)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Link href={`/tasks/${task.id}`}>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground group-hover:text-foreground">
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  </Link>
                </div>
                </div>
                {showMetro && (
                  <div className="px-4 pb-4 pt-2 border-t border-border/40">
                    <SnakeMetroMap totalSteps={totalMetroSteps} dots={metroDots} />
                  </div>
                )}
              </div>
                );
              })}
          </div>
        ) : activeFilter ? (
          <div className={`flex flex-col items-center justify-center py-16 text-center border border-dashed rounded-md ${
            activeFilter === "needs_attention" ? "border-amber-500/30 bg-amber-500/5" :
            activeFilter === "running" ? "border-blue-500/30 bg-blue-500/5" :
            activeFilter === "success" ? "border-green-500/30 bg-green-500/5" :
            "border-destructive/30 bg-destructive/5"
          }`}>
            {activeFilter === "needs_attention" && <AlertTriangle className="h-10 w-10 text-amber-500 mb-4 opacity-50" />}
            {activeFilter === "running" && <Loader2 className="h-10 w-10 text-blue-500 mb-4 opacity-50" />}
            {activeFilter === "success" && <CheckCircle2 className="h-10 w-10 text-green-500 mb-4 opacity-50" />}
            {activeFilter === "failed" && <XCircle className="h-10 w-10 text-destructive mb-4 opacity-50" />}
            <h3 className="text-lg font-semibold text-foreground">
              No {activeFilter === "needs_attention" ? "blocked" : activeFilter} tasks
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm mt-1 mb-6">
              {activeFilter === "needs_attention" && t.filterEmptyNeedsAttention}
              {activeFilter === "running" && t.filterEmptyRunning}
              {activeFilter === "success" && t.filterEmptySuccess}
              {activeFilter === "failed" && t.filterEmptyFailed}
            </p>
            <Button variant="outline" onClick={() => setActiveFilter(null)}><X className="h-4 w-4 mr-2" /> {t.showAllTasks}</Button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed border-border rounded-md bg-muted/20">
            <Activity className="h-10 w-10 text-muted-foreground mb-4 opacity-50" />
            <h3 className="text-lg font-semibold text-foreground">No tasks configured</h3>
            <p className="text-sm text-muted-foreground max-w-sm mt-1 mb-6">Create an automation job to start orchestrating headless browser sessions.</p>
            <Link href="/tasks/new">
              <Button><Plus className="h-4 w-4 mr-2" /> Create First Task</Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ title, value, icon, isLoading, highlight, active, activeRing, onClick }: { title: string, value?: number, icon: React.ReactNode, isLoading: boolean, highlight?: boolean, active?: boolean, activeRing?: string, onClick?: () => void }) {
  const { t } = useLang();
  return (
    <Card
      className={`shadow-sm transition-all duration-150 ${highlight ? "border-amber-500/40 bg-amber-500/5" : "border-border"} ${onClick ? "cursor-pointer select-none" : ""} ${active ? `ring-2 ${activeRing ?? "ring-amber-500/60"}` : ""}`}
      onClick={onClick}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className={`text-sm font-medium ${highlight ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <div className={`text-2xl font-bold tracking-tight font-mono ${highlight ? "text-amber-600 dark:text-amber-400" : ""}`}>{value || 0}</div>
        )}
        {onClick && <p className="text-[10px] text-muted-foreground mt-1 font-mono">{active ? t.clickToReset : t.clickToFilter}</p>}
      </CardContent>
    </Card>
  );
}


function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className || "h-4 w-4"}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}
