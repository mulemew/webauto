import { useState } from "react";
  import { Link, useSearch } from "wouter";
  import { Search, CheckCircle2, XCircle, AlertTriangle, Clock, ChevronLeft, ChevronRight, Filter } from "lucide-react";
  import { format } from "date-fns";

  import { Button } from "@/components/ui/button";
  import { Badge } from "@/components/ui/badge";
  import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
  import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
  import { Skeleton } from "@/components/ui/skeleton";
  import { useQuery } from "@tanstack/react-query";
  import { useListTasks } from "@workspace/api-client-react";

  interface LogEntry {
    id: number;
    taskId: number;
    taskName: string;
    runAt: string;
    success: boolean;
    message: string;
    screenshotPath: string | null;
    durationMs: number | null;
    triggeredBy: string | null;
  }

  interface LogsResponse {
    logs: LogEntry[];
    total: number;
    limit: number;
    offset: number;
  }

  const PAGE_SIZE = 50;

  function TriggeredByBadge({ value }: { value: string | null }) {
    if (!value) return null;
    if (value === "cron") return <Badge variant="outline" className="text-xs font-mono gap-1">⏱ Scheduled</Badge>;
    if (value === "dry_run") return <Badge variant="secondary" className="text-xs font-mono">Dry Run</Badge>;
    return <Badge variant="outline" className="text-xs font-mono">▶ Manual</Badge>;
  }

  export default function LogsExplorer() {
    const search = useSearch();
    const initialTaskId = new URLSearchParams(search).get("taskId") ?? "all";
    const [taskFilter, setTaskFilter] = useState<string>(initialTaskId);
    const [statusFilter, setStatusFilter] = useState<string>("all");
    const [triggeredByFilter, setTriggeredByFilter] = useState<string>("all");
    const [page, setPage] = useState(0);

    const { data: tasksData } = useListTasks();
    const tasks = tasksData ?? [];

    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (taskFilter !== "all") params.set("taskId", taskFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (triggeredByFilter !== "all") params.set("triggeredBy", triggeredByFilter);

    const { data, isLoading } = useQuery<LogsResponse>({
      queryKey: ["logs-explorer", taskFilter, statusFilter, triggeredByFilter, page],
      queryFn: () => fetch(`/api/tasks/logs?${params.toString()}`).then(r => r.json()) as Promise<LogsResponse>,
      staleTime: 30_000,
      refetchInterval: 30_000,
    });

    const logs = data?.logs ?? [];
    const total = data?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const resetPage = () => setPage(0);

    return (
      <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
        <div className="flex items-center gap-3">
          <Search className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Logs Explorer</h1>
            <p className="text-sm text-muted-foreground">Browse and filter execution logs across all tasks</p>
          </div>
        </div>

        {/* Filters */}
        <Card className="border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Filter className="h-4 w-4" /> Filters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground font-medium">Task</label>
                <Select value={taskFilter} onValueChange={(v) => { setTaskFilter(v); resetPage(); }}>
                  <SelectTrigger className="w-48 h-8 text-sm">
                    <SelectValue placeholder="All tasks" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All tasks</SelectItem>
                    {tasks.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground font-medium">Status</label>
                <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); resetPage(); }}>
                  <SelectTrigger className="w-36 h-8 text-sm">
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="success">Success</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground font-medium">Trigger</label>
                <Select value={triggeredByFilter} onValueChange={(v) => { setTriggeredByFilter(v); resetPage(); }}>
                  <SelectTrigger className="w-36 h-8 text-sm">
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="cron">Scheduled</SelectItem>
                    <SelectItem value="dry_run">Dry Run</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Results */}
        <Card className="border-border">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm">
              {isLoading ? "Loading…" : `${total.toLocaleString()} result${total !== 1 ? "s" : ""}`}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground">Page {page + 1} / {totalPages}</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                <AlertTriangle className="h-8 w-8 opacity-40" />
                <p className="text-sm">No logs found for the selected filters</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {logs.map((log) => (
                  <Link key={log.id} href={`/tasks/${log.taskId}/logs/${log.id}`}>
                    <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 active:bg-muted/60 transition-colors cursor-pointer">
                      <span className="shrink-0">
                        {log.success
                          ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                          : <XCircle className="h-4 w-4 text-destructive" />}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium truncate">{log.taskName}</span>
                          <TriggeredByBadge value={log.triggeredBy} />
                        </div>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{log.message.split("\n")[0]}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xs text-muted-foreground">{format(new Date(log.runAt), "MMM d, HH:mm")}</p>
                        {log.durationMs != null && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
                            <Clock className="h-3 w-3" />{(log.durationMs / 1000).toFixed(1)}s
                          </p>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }
  