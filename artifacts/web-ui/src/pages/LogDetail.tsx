import { useRoute, Link } from "wouter";
import { ArrowLeft, Clock, Calendar, CheckCircle2, XCircle, Terminal, ImageIcon, Maximize2 } from "lucide-react";
import { format } from "date-fns";

import { useGetTaskLog, getGetTaskLogQueryKey, useGetTask, getGetTaskQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useTimeSince } from "@/hooks/use-time-since";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
import { usePollingInterval } from "@/hooks/use-polling-interval";
import { usePollPaused } from "@/contexts/poll-paused-context";

// ── Per-step log viewer ───────────────────────────────────────────────────────

type LineKind = "header" | "step-ok" | "step-fail" | "warning" | "normal";

function classifyLine(line: string): LineKind {
  if (line === "Workflow steps:") return "header";
  if (/^Step \d+ \[.+\] FAILED:/i.test(line)) return "step-fail";
  if (/^Step \d+ \[.+\]:/i.test(line)) return "step-ok";
  if (/timed out|timeout|captcha detected/i.test(line)) return "warning";
  return "normal";
}

function LineView({ line, kind }: { line: string; kind: LineKind }) {
  const base = "px-4 py-0.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all";
  if (kind === "header") {
    return (
      <p className={`${base} mt-3 mb-0.5 text-[10px] uppercase tracking-widest text-zinc-500 font-semibold`}>
        {line}
      </p>
    );
  }
  if (kind === "step-ok") {
    return (
      <p className={`${base} text-green-400 flex items-start gap-2`}>
        <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0 text-green-500" />
        <span>{line}</span>
      </p>
    );
  }
  if (kind === "step-fail") {
    return (
      <p className={`${base} text-red-400 flex items-start gap-2`}>
        <XCircle className="h-3 w-3 mt-0.5 shrink-0 text-red-500" />
        <span>{line}</span>
      </p>
    );
  }
  if (kind === "warning") {
    return <p className={`${base} text-amber-400`}>{line}</p>;
  }
  return <p className={`${base} text-zinc-300`}>{line}</p>;
}

function MessageViewer({ message }: { message: string }) {
  const lines = message.split("\n");
  return (
    <div className="py-3 select-text">
      {lines.map((line, i) => {
        if (line.trim() === "") {
          return <div key={i} className="h-2" />;
        }
        const kind = classifyLine(line.trim());
        return <LineView key={i} line={line} kind={kind} />;
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function LogDetail() {
  const [match, params] = useRoute("/tasks/:id/logs/:logId");
  const taskId = match && params?.id ? parseInt(params.id, 10) : 0;
  const logId = match && params?.logId ? parseInt(params.logId, 10) : 0;

  const [pollingInterval] = usePollingInterval();
  const { paused } = usePollPaused();

  const { data: task } = useGetTask(taskId, {
    query: {
      enabled: !!taskId,
      queryKey: getGetTaskQueryKey(taskId),
      refetchInterval: (query) =>
        !paused && query.state.data?.status === "running" ? pollingInterval : false,
    },
  });

  const isRunning = !paused && task?.status === "running";

  const { data: log, isLoading, dataUpdatedAt } = useGetTaskLog(taskId, logId, {
    query: {
      enabled: !!(taskId && logId),
      queryKey: getGetTaskLogQueryKey(taskId, logId),
      refetchInterval: isRunning ? pollingInterval : false,
    }
  });

  const updatedAgo = useTimeSince(dataUpdatedAt || undefined);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (!log) {
    return (
      <div className="text-center py-20">
        <h2 className="text-xl font-bold">Log not found</h2>
        <Link href={`/tasks/${taskId}`}>
          <Button variant="link" className="mt-4">Return to Task</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center gap-4">
        <Link href={`/tasks/${taskId}`}>
          <Button variant="outline" size="icon" className="h-8 w-8 rounded-md bg-card">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Execution Log</h1>
            {log.success ? (
              <Badge className="bg-green-500/10 text-green-600 hover:bg-green-500/20 border-green-500/20 font-mono">SUCCESS</Badge>
            ) : (
              <Badge className="bg-destructive/10 text-destructive hover:bg-destructive/20 border-destructive/20 font-mono">FAILED</Badge>
              )}
              {(log as unknown as { triggeredBy?: string }).triggeredBy && (
                <Badge variant="outline" className="text-xs font-mono ml-1">
                  {(log as unknown as { triggeredBy?: string }).triggeredBy === "dry_run" ? "Dry Run"
                    : (log as unknown as { triggeredBy?: string }).triggeredBy === "cron" ? "⏱ Sched"
                    : "▶ Manual"}
                </Badge>
              )}
          </div>
          <p className="text-sm text-muted-foreground font-mono mt-1">
            Log ID: {log.id}
            {updatedAgo && (
              <span className="ml-2 text-xs text-muted-foreground/60">· Updated {updatedAgo}</span>
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border-border shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              <Calendar className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Timestamp</p>
              <p className="text-sm font-mono font-medium">{format(new Date(log.runAt), "MMM d, yyyy HH:mm:ss")}</p>
            </div>
          </CardContent>
        </Card>
        
        <Card className="border-border shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              <Clock className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Duration</p>
              <p className="text-sm font-mono font-medium">{log.durationMs ? `${log.durationMs}ms` : "Unknown"}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className={`h-10 w-10 rounded-full flex items-center justify-center ${log.success ? 'bg-green-500/10 text-green-500' : 'bg-destructive/10 text-destructive'}`}>
              {log.success ? <CheckCircle2 className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Result</p>
              <p className="text-sm font-mono font-medium">{log.success ? "Completed without errors" : "Execution aborted"}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border shadow-sm overflow-hidden">
          <CardHeader className="bg-muted/20 border-b border-border pb-3 py-3 px-4 flex flex-row items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Terminal className="h-4 w-4 text-primary" /> Run Timeline
            </CardTitle>
            {log.hasScreenshot && (() => {
              const stepLogs = ((log as any).stepLogs ?? []) as Array<{ type: string; screenshotPath?: string }>;
              const hasPostcheckShot = stepLogs.some(s => s.type === "postcheck" && s.screenshotPath);
              if (hasPostcheckShot) return null;
              return (
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-6 text-xs gap-1.5 text-muted-foreground hover:text-foreground">
                    <ImageIcon className="h-3 w-3" /> Final Screenshot
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-5xl w-full p-1 bg-zinc-950 border-zinc-800">
                  <DialogTitle className="sr-only">Execution Screenshot</DialogTitle>
                  <img src={`${BASE}/api/tasks/${taskId}/logs/${logId}/screenshot`} alt="Execution screenshot" className="w-full h-auto object-contain max-h-[85vh]" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).insertAdjacentHTML("afterend", '<p class="text-sm text-muted-foreground font-mono text-center py-8">截图已过期</p>'); }} />
                </DialogContent>
              </Dialog>
              );
            })()}
          </CardHeader>
          <CardContent className="p-4">
            {(() => {
              type StepLog = { stepIndex: number; type: string; success: boolean; message: string; screenshotPath?: string; durationMs?: number };
              const stepLogs = ((log as any).stepLogs ?? []) as StepLog[];
              if (stepLogs.length === 0) {
                return (
                  <div className="py-2 space-y-0.5">
                    {log.message.split("\n").filter(l => l.trim()).map((line, i) => {
                      const isFail = /FAILED:/i.test(line);
                      return (
                        <p key={i} className={"text-xs font-mono " + (isFail ? "text-red-500" : "text-muted-foreground")}>
                          {line}
                        </p>
                      );
                    })}
                  </div>
                );
              }
              return (
                <div>
                  {stepLogs.map((step, i) => {
                    const isPrecheck = step.type === "precheck";
                    const isPostcheck = step.type === "postcheck";
                    const isLast = i === stepLogs.length - 1 && !log.hasScreenshot;
                    const fname = step.screenshotPath?.split("/").pop();
                    const shotSrc = fname ? `${BASE}/api/tasks/${taskId}/step-screenshots/${fname}` : undefined;
                    const STEP_ICON: Record<string, string> = {
                      navigate: "→", click: "↖", fill: "✎", wait: "⏱", waitFor: "👁",
                      screenshot: "📷", login: "🔐", keypress: "⌨", hover: "◈", scroll: "↕",
                      select: "▾", switchToNewPage: "⧉", condition: "⑂",
                      precheck: "⚡", postcheck: "📋"
                    };
                    const dotColor = isPrecheck
                      ? "rgb(168,85,247)"
                      : isPostcheck
                      ? "rgb(59,130,246)"
                      : step.success ? "rgb(34,197,94)" : "rgb(239,68,68)";
                    const lineColor = isPrecheck
                      ? "rgba(168,85,247,0.3)"
                      : isPostcheck
                      ? "rgba(59,130,246,0.25)"
                      : step.success ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.2)";
                    const pillClass = isPrecheck
                      ? "border-purple-500/30 bg-purple-500/10 text-purple-500"
                      : isPostcheck
                      ? "border-blue-500/30 bg-blue-500/10 text-blue-500"
                      : step.success
                      ? "border-green-500/20 bg-green-500/5 text-green-600"
                      : "border-destructive/30 bg-destructive/10 text-destructive";
                    return (
                      <div key={i} className="flex gap-3">
                        <div className="flex flex-col items-center" style={{ width: 20 }}>
                          <div className="mt-1 shrink-0" style={{
                            width: 12, height: 12, borderRadius: "50%",
                            backgroundColor: dotColor
                          }} />
                          {!isLast && <div style={{ width: 2, flex: 1, marginTop: 4, minHeight: 20, backgroundColor: lineColor }} />}
                        </div>
                        <div className="flex-1 pb-4 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-0.5">
                            <span className={"text-[10px] font-mono px-1.5 py-0.5 rounded border font-medium " + pillClass}>
                              {step.type}
                            </span>
                            {!isPrecheck && !isPostcheck && <span className="text-[10px] font-mono text-muted-foreground/60">#{step.stepIndex + 1}</span>}
                            {step.durationMs != null && (
                              <span className="text-[10px] font-mono text-muted-foreground/40 ml-auto">
                                {step.durationMs < 1000 ? `${step.durationMs}ms` : `${(step.durationMs / 1000).toFixed(1)}s`}
                              </span>
                            )}
                          </div>
                          <p className={"text-xs font-mono " + (step.success ? "text-muted-foreground" : "text-red-400")}>
                            {step.message.replace(/^Step d+ [.+?](?:s*FAILED)?:s*/i, "")}
                          </p>
                          {shotSrc && (
                            <Dialog>
                              <DialogTrigger asChild>
                                <button type="button" className="mt-2 rounded overflow-hidden border border-border hover:border-primary/50 transition-colors cursor-zoom-in block">
                                  <img src={shotSrc} alt={"Step " + (step.stepIndex + 1) + " screenshot"} className="h-24 w-auto max-w-[180px] object-cover object-top" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).parentElement!.innerHTML = '<span class="text-xs text-muted-foreground/60 font-mono px-2 py-1">截图已过期</span>'; }} />
                                </button>
                              </DialogTrigger>
                              <DialogContent className="max-w-5xl bg-zinc-950 border-zinc-800 p-1">
                                <DialogTitle className="sr-only">Step Screenshot</DialogTitle>
                                <img src={shotSrc} alt={"Step " + (step.stepIndex + 1) + " screenshot"} className="w-full h-auto object-contain max-h-[85vh]" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).insertAdjacentHTML("afterend", '<p class="text-sm text-muted-foreground font-mono text-center py-8">截图已过期</p>'); }} />
                              </DialogContent>
                            </Dialog>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {log.hasScreenshot && !stepLogs.some(s => s.type === "postcheck" && s.screenshotPath) && (
                    <div className="flex gap-3">
                      <div className="flex flex-col items-center" style={{ width: 20 }}>
                        <div className="mt-1 shrink-0" style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: log.success ? "rgb(34,197,94)" : "rgb(239,68,68)", opacity: 0.5 }} />
                      </div>
                      <div className="flex-1 pb-2 min-w-0">
                        <p className="text-[10px] font-mono text-muted-foreground/60 mb-1">final screenshot</p>
                        <Dialog>
                          <DialogTrigger asChild>
                            <button type="button" className="rounded overflow-hidden border border-amber-500/30 hover:border-amber-500/60 transition-colors cursor-zoom-in block">
                              <img src={`${BASE}/api/tasks/${taskId}/logs/${logId}/screenshot`} alt="Final screenshot" className="h-24 w-auto max-w-[180px] object-cover object-top" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).parentElement!.innerHTML = '<span class="text-xs text-muted-foreground/60 font-mono px-2 py-1">截图已过期</span>'; }} />
                            </button>
                          </DialogTrigger>
                          <DialogContent className="max-w-5xl bg-zinc-950 border-zinc-800 p-1">
                            <DialogTitle className="sr-only">Final Screenshot</DialogTitle>
                            <img src={`${BASE}/api/tasks/${taskId}/logs/${logId}/screenshot`} alt="Final screenshot" className="w-full h-auto object-contain max-h-[85vh]" />
                          </DialogContent>
                        </Dialog>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      </div>
    );
  }