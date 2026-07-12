import { Link } from "wouter";
import { Sun, Moon, Languages } from "lucide-react";
import { useTheme } from "@/contexts/theme-context";
import { useLang } from "@/contexts/lang-context";
  import { Terminal, Settings, LayoutDashboard, Search, LogOut, RefreshCw, PauseCircle, HeartPulse, Crosshair, KeyRound } from "lucide-react";
  import { useAuth } from "@/hooks/use-auth";
  import { Button } from "@/components/ui/button";
  import { usePollingInterval } from "@/hooks/use-polling-interval";
  import { usePollPaused } from "@/contexts/poll-paused-context";
  import { useListTasks, getListTasksQueryKey, useBrowserHealthCheck, getBrowserHealthCheckQueryKey } from "@workspace/api-client-react";
  import { useTimeSince } from "@/hooks/use-time-since";
  import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

  export function Layout({ children }: { children: React.ReactNode }) {
    const { logout } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const { lang, setLang, t } = useLang();
    const [pollingInterval] = usePollingInterval();
    const { paused, toggle } = usePollPaused();
    const { data: tasks, dataUpdatedAt } = useListTasks({
      query: {
        queryKey: getListTasksQueryKey(),
        refetchInterval: (query) =>
          !paused && query.state.data?.some((t) => t.status === "running") ? pollingInterval : false,
      },
    });
    const { data: browserStatus } = useBrowserHealthCheck({
      query: {
        queryKey: getBrowserHealthCheckQueryKey(),
        refetchInterval: 30_000,
        staleTime: 20_000,
      },
    });

    const isPollingActive = !paused && (tasks?.some((t) => t.status === "running") ?? false);
    const intervalSeconds = pollingInterval / 1000;
    const updatedAgo = useTimeSince(dataUpdatedAt || undefined);

    const browserConnected = browserStatus?.status === "connected";
    const browserUnconfigured = browserStatus?.status === "unconfigured";
    const browserLabel = browserUnconfigured
      ? "Browser: not configured"
      : browserConnected
        ? "Browser: connected"
        : browserStatus
          ? "Browser: unreachable"
          : "Browser: checking…";
    const browserDotClass = browserUnconfigured
      ? "bg-amber-400"
      : browserConnected
        ? "bg-green-500 animate-pulse"
        : browserStatus
          ? "bg-red-500"
          : "bg-muted-foreground/30";

    return (
      <div className="flex h-full w-full bg-background overflow-hidden selection:bg-primary/20">
        {/* Sidebar */}
        <div className="w-64 flex flex-col border-r border-border bg-card shadow-sm z-10 flex-shrink-0">
          <div className="h-16 flex items-center px-6 border-b border-border">
            <div className="flex items-center gap-2 text-primary">
              <Terminal className="h-6 w-6 stroke-[2.5px]" />
              <span className="font-bold tracking-tight text-lg uppercase">AutoOps</span>
            </div>
          </div>

          <div className="p-4 flex-1 flex flex-col gap-1 overflow-y-auto">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 mt-4 px-2">
              {t.controlPanel}
            </div>
            <Link href="/" className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground">
              <LayoutDashboard className="h-4 w-4" />
              {t.dashboard}
            </Link>
            <Link href="/logs" className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground">
              <Search className="h-4 w-4" />
              {t.logsExplorer}
            </Link>
            <Link href="/recorder" className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground">
              <Crosshair className="h-4 w-4" />
              {t.stepRecorder}
            </Link>
            <Link href="/credentials" className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground">
              <KeyRound className="h-4 w-4" />
              {t.credentials}
            </Link>
            <Link href="/status" className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground">
              <HeartPulse className="h-4 w-4" />
              {t.systemStatus}
            </Link>
            <Link href="/settings" className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground">
              <Settings className="h-4 w-4" />
              {t.settings}
            </Link>
          </div>

          <div className="p-4 border-t border-border space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center text-primary font-semibold text-xs border border-primary/20">
                OP
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium leading-none">Operator</span>
                <span className="text-xs text-muted-foreground">Admin</span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
              onClick={logout}
            >
              <LogOut className="h-4 w-4" />
              {t.signOut}
            </Button>
          </div>
        </div>

        {/* Main Content */}
        <main className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">
          <div className="h-16 shrink-0 border-b border-border flex items-center justify-between px-8 bg-card/50 backdrop-blur sticky top-0 z-10">
            <div className="flex items-center gap-4">
              {/* System online indicator */}
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
                <span className="text-xs font-medium text-muted-foreground tracking-widest uppercase">{t.systemOnline}</span>
              </div>

              {/* Browser status indicator */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 cursor-default">
                    <span className={`flex h-2 w-2 rounded-full ${browserDotClass}`}></span>
                    <span className={`text-xs font-medium tracking-widest uppercase ${
                      browserConnected
                        ? "text-muted-foreground"
                        : browserUnconfigured
                          ? "text-amber-500"
                          : browserStatus
                            ? "text-red-500"
                            : "text-muted-foreground/40"
                    }`}>
                      {t.browser}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {browserLabel}
                  {browserStatus?.url && (
                    <span className="block text-muted-foreground font-mono mt-0.5">{browserStatus.url}</span>
                  )}
                </TooltipContent>
              </Tooltip>

              {/* Poll status pill */}
              <button
                onClick={toggle}
                title={paused ? "Click to resume auto-refresh" : "Click to pause auto-refresh"}
                className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono font-semibold tracking-wide transition-colors cursor-pointer select-none ${
                  paused
                    ? "text-amber-500 bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20"
                    : isPollingActive
                      ? "text-blue-500 bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20"
                      : "text-muted-foreground/40 border border-border/50 hover:border-border"
                }`}
              >
                {paused
                  ? <PauseCircle className="h-3 w-3" />
                  : <RefreshCw className={`h-3 w-3 ${isPollingActive ? "animate-spin" : ""}`} />
                }
                {paused ? t.paused : isPollingActive ? t.live : t.idle} · {intervalSeconds}s
                {updatedAgo && (
                  <span className="ml-1 opacity-60 font-normal normal-case tracking-normal">
                    · {updatedAgo}
                  </span>
                )}
              </button>
            </div>
            <div className="flex items-center gap-1">
                <button onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")} title="Toggle dark/light theme" className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                  {resolvedTheme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                </button>
                <button onClick={() => setLang(lang === "zh" ? "en" : "zh")} title="Switch language" className="px-2 py-1 rounded text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                  {lang === "zh" ? "EN" : "中"}
                </button>
                <span className="text-xs text-muted-foreground font-mono border-l border-border pl-2 ml-1">{new Date().toISOString().split('T')[0]}</span>
              </div>
          </div>
          <div className="flex-1 overflow-auto">
            <div className="p-8 max-w-7xl mx-auto w-full">
              {children}
            </div>
          </div>
        </main>
      </div>
    );
  }
  