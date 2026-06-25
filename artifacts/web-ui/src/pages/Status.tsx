import { useEffect, useState } from "react";
  import { CheckCircle2, XCircle, Loader2, Server, Database, Cpu } from "lucide-react";
  import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
  import { useLang } from "@/contexts/lang-context";

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  interface ServiceStatus {
    name: string;
    status: "ok" | "error" | "loading";
    message?: string;
  }

  export default function Status() {
    const { t } = useLang();
    const [services, setServices] = useState<ServiceStatus[]>([
      { name: t.taskScheduler, status: "loading" },
      { name: t.browserService, status: "loading" },
      { name: "Database", status: "loading" },
    ]);

    useEffect(() => {
      fetch(`${BASE}/api/status`, { credentials: "same-origin" })
        .then((r) => r.json())
        .then((data: { scheduler?: string; browser?: string; db?: string; dbError?: string; schedulerError?: string; browserError?: string }) => {
          setServices([
            {
              name: t.taskScheduler,
              status: data.scheduler === "ok" ? "ok" : "error",
              message: data.schedulerError,
            },
            {
              name: t.browserService,
              status: data.browser === "ok" ? "ok" : "error",
              message: data.browserError,
            },
            {
              name: "Database",
              status: data.db === "ok" ? "ok" : "error",
              message: data.dbError,
            },
          ]);
        })
        .catch(() => {
          setServices([
            { name: t.taskScheduler, status: "error", message: "Could not reach the scheduler" },
            { name: t.browserService, status: "error", message: "Could not reach the API server" },
            { name: "Database", status: "error", message: "Database query failed" },
          ]);
        });
    }, [t]);

    const allOk = services.every((s) => s.status === "ok");
    const anyLoading = services.some((s) => s.status === "loading");

    const icons: Record<string, React.ReactNode> = {
      [t.taskScheduler]: <Cpu className="h-5 w-5" />,
      [t.browserService]: <Server className="h-5 w-5" />,
      Database: <Database className="h-5 w-5" />,
    };

    return (
      <div className="max-w-2xl mx-auto space-y-6 p-4">
        <div>
          <h1 className="text-2xl font-bold">{t.systemStatus}</h1>
          {!anyLoading && (
            <p className={`mt-1 text-sm ${allOk ? "text-green-600" : "text-destructive"}`}>
              {allOk ? t.allSystemsOk : t.systemsDegraded}
            </p>
          )}
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t.aboutSystem}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {services.map((svc) => (
              <div key={svc.name} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  {icons[svc.name]}
                  <span>{svc.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  {svc.status === "loading" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  {svc.status === "ok" && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                  {svc.status === "error" && (
                    <div className="flex items-center gap-1.5">
                      <XCircle className="h-4 w-4 text-destructive" />
                      {svc.message && <span className="text-xs text-destructive font-mono">{svc.message}</span>}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }
  