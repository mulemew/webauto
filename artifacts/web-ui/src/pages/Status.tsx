import { useState, useEffect, useCallback } from "react";
import { CheckCircle2, XCircle, Loader2, RefreshCw, Database, Globe, CalendarClock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBrowserHealthCheck } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type CheckStatus = "loading" | "ok" | "error" | "warn";

interface ServiceCard {
  label: string;
  description: string;
  status: CheckStatus;
  detail: string;
  icon: React.ReactNode;
}

interface DbHealth {
  status: "ok" | "error";
  latencyMs?: number;
  message?: string;
}

interface SchedulerHealth {
  status: "ok";
  scheduledJobs: number;
}

function StatusDot({ status }: { status: CheckStatus }) {
  const cls =
    status === "loading"
      ? "bg-muted-foreground/30 animate-pulse"
      : status === "ok"
        ? "bg-green-500 animate-pulse"
        : status === "warn"
          ? "bg-amber-400"
          : "bg-red-500";
  return <span className={`inline-flex h-2.5 w-2.5 rounded-full flex-shrink-0 ${cls}`} />;
}

function StatusBadge({ status }: { status: CheckStatus }) {
  if (status === "loading") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
      </span>
    );
  }
  if (status === "ok") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400 font-mono font-semibold">
        <CheckCircle2 className="h-3.5 w-3.5" /> Healthy
      </span>
    );
  }
  if (status === "warn") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 font-mono font-semibold">
        <CheckCircle2 className="h-3.5 w-3.5" /> Degraded
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 font-mono font-semibold">
      <XCircle className="h-3.5 w-3.5" /> Unreachable
    </span>
  );
}

export default function Status() {
  const [dbStatus, setDbStatus] = useState<CheckStatus>("loading");
  const [dbDetail, setDbDetail] = useState("");
  const [schedulerStatus, setSchedulerStatus] = useState<CheckStatus>("loading");
  const [schedulerDetail, setSchedulerDetail] = useState("");
  const [checking, setChecking] = useState(false);

  const { data: browserHealth, isLoading: browserLoading, refetch: refetchBrowser } = useBrowserHealthCheck({
    query: { staleTime: 0 } as never,
  });

  const browserStatus: CheckStatus = browserLoading
    ? "loading"
    : browserHealth?.status === "connected"
      ? "ok"
      : browserHealth?.status === "unconfigured"
        ? "warn"
        : "error";

  const browserDetail =
    browserHealth?.status === "connected"
      ? `Connected — ${browserHealth.url ?? ""}`
      : browserHealth?.status === "unconfigured"
        ? "No WebSocket endpoint configured. Go to Settings to set one up."
        : browserHealth?.url
          ? `Unreachable — ${browserHealth.url}`
          : "Checking…";

  const checkDb = useCallback(async () => {
    setDbStatus("loading");
    setDbDetail("");
    try {
      const res = await fetch(`${BASE}/api/healthz/db`, { credentials: "same-origin" });
      const data = await res.json() as DbHealth;
      if (data.status === "ok") {
        setDbStatus("ok");
        setDbDetail(`Query latency: ${data.latencyMs ?? "?"}ms`);
      } else {
        setDbStatus("error");
        setDbDetail(data.message ?? "Database query failed");
      }
    } catch {
      setDbStatus("error");
      setDbDetail("Could not reach the API server");
    }
  }, []);

  const checkScheduler = useCallback(async () => {
    setSchedulerStatus("loading");
    setSchedulerDetail("");
    try {
      const res = await fetch(`${BASE}/api/healthz/scheduler`, { credentials: "same-origin" });
      const data = await res.json() as SchedulerHealth;
      setSchedulerStatus("ok");
      setSchedulerDetail(`${data.scheduledJobs} cron job${data.scheduledJobs !== 1 ? "s" : ""} active`);
    } catch {
      setSchedulerStatus("error");
      setSchedulerDetail("Could not reach the scheduler");
    }
  }, []);

  const runAllChecks = useCallback(async () => {
    setChecking(true);
    await Promise.all([checkDb(), checkScheduler(), refetchBrowser()]);
    setChecking(false);
  }, [checkDb, checkScheduler, refetchBrowser]);

  useEffect(() => {
    void runAllChecks();
  }, [runAllChecks]);

  const cards: ServiceCard[] = [
    {
      label: "Database",
      description: "PostgreSQL — stores tasks, logs, settings, and sessions",
      status: dbStatus,
      detail: dbDetail,
      icon: <Database className="h-5 w-5 text-primary" />,
    },
    {
      label: "Browser Service",
      description: "Headless browser via CDP WebSocket (Browserless / remote)",
      status: browserStatus,
      detail: browserDetail,
      icon: <Globe className="h-5 w-5 text-primary" />,
    },
    {
      label: "Task Scheduler",
      description: "Cron-based scheduler for automated task runs",
      status: schedulerStatus,
      detail: schedulerDetail,
      icon: <CalendarClock className="h-5 w-5 text-primary" />,
    },
  ];

  const overallOk = cards.every((c) => c.status === "ok");
  const overallLoading = cards.some((c) => c.status === "loading");

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-2xl">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">System Status</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">Health checks for all platform services</p>
        </div>
        <Button variant="outline" size="sm" onClick={runAllChecks} disabled={checking || overallLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${checking ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Overall banner */}
      <div className={`flex items-center gap-3 px-4 py-3 rounded-md border text-sm font-medium ${
        overallLoading
          ? "border-border bg-muted/30 text-muted-foreground"
          : overallOk
            ? "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
            : "border-destructive/30 bg-destructive/5 text-destructive"
      }`}>
        {overallLoading ? (
          <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
        ) : overallOk ? (
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
        ) : (
          <XCircle className="h-4 w-4 flex-shrink-0" />
        )}
        {overallLoading ? "Running health checks…" : overallOk ? "All systems operational" : "One or more services are degraded"}
      </div>

      {/* Service cards */}
      <div className="space-y-4">
        {cards.map(({ label, description, status, detail, icon }) => (
          <Card key={label} className="border-border shadow-sm">
            <CardHeader className="bg-muted/20 border-b border-border pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                {icon}
                {label}
              </CardTitle>
              <CardDescription className="text-xs mt-1">{description}</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StatusDot status={status} />
                  <StatusBadge status={status} />
                </div>
                {detail && (
                  <span className="text-xs font-mono text-muted-foreground max-w-xs text-right truncate">
                    {detail}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
