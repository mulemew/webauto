import { useState, useEffect, useRef, FormEvent } from "react";
import {
  RefreshCw, KeyRound, Loader2, CheckCircle2, AlertTriangle, Archive,
  Globe, Wifi, WifiOff, ShieldCheck, Timer, Info, Server,
  Database, Cpu,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { usePollingInterval, POLLING_OPTIONS, type PollingIntervalMs } from "@/hooks/use-polling-interval";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");


  // ── Retention / Cleanup Settings ─────────────────────────────────────────────

  interface RetentionConfig {
    logRetentionDays: number;
    maxScreenshotsMb: number;
  }

  function RetentionSection() {
    const [config, setConfig] = useState<RetentionConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [cleaning, setCleaning] = useState(false);
    const [logDays, setLogDays] = useState("");
    const [maxMb, setMaxMb] = useState("");
    const { toast } = useToast();

    useEffect(() => {
      fetch(`${BASE}/api/settings/retention`, { credentials: "same-origin" })
        .then((r) => r.ok ? r.json() as Promise<RetentionConfig> : null)
        .then((d) => {
          if (d) {
            setConfig(d);
            setLogDays(String(d.logRetentionDays));
            setMaxMb(String(d.maxScreenshotsMb));
          }
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }, []);

    const handleSave = async (e: FormEvent) => {
      e.preventDefault();
      setSaving(true);
      try {
        const res = await fetch(`${BASE}/api/settings/retention`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            logRetentionDays: parseInt(logDays, 10) || 0,
            maxScreenshotsMb: parseInt(maxMb, 10) || 0,
          }),
        });
        if (res.ok) {
          toast({ title: "Retention settings saved", variant: "success" });
        } else {
          toast({ title: "Save failed", variant: "destructive" });
        }
      } catch {
        toast({ title: "Network error", variant: "destructive" });
      } finally {
        setSaving(false);
      }
    };

    const handleCleanupNow = async () => {
      setCleaning(true);
      try {
        const res = await fetch(`${BASE}/api/settings/retention/cleanup`, {
          method: "POST",
          credentials: "same-origin",
        });
        if (res.ok) {
          toast({ title: "Cleanup complete", description: "Old logs and screenshots have been removed.", variant: "success" });
        } else {
          toast({ title: "Cleanup failed", variant: "destructive" });
        }
      } catch {
        toast({ title: "Network error", variant: "destructive" });
      } finally {
        setCleaning(false);
      }
    };

    return (
      <div className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="logDays">Log retention (days)</Label>
                <Input
                  id="logDays"
                  type="number"
                  min="0"
                  value={logDays}
                  onChange={(e) => setLogDays(e.target.value)}
                  placeholder="7"
                />
                <p className="text-xs text-muted-foreground">Logs older than this are deleted each night at 03:30. Set 0 to keep forever.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxMb">Max screenshot storage (MB)</Label>
                <Input
                  id="maxMb"
                  type="number"
                  min="0"
                  value={maxMb}
                  onChange={(e) => setMaxMb(e.target.value)}
                  placeholder="1024"
                />
                <p className="text-xs text-muted-foreground">Oldest screenshots are removed when disk usage exceeds this. Set 0 for no limit.</p>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button type="submit" disabled={saving} size="sm">
                {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save"}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={cleaning} onClick={handleCleanupNow}>
                {cleaning ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Running…</> : "Run cleanup now"}
              </Button>
            </div>
          </form>
        )}
      </div>
    );
  }

  // ── About / System Info ───────────────────────────────────────────────────────

interface SystemInfo {
  version: string;
  nodeVersion: string;
  platform: string;
  uptimeSeconds: number;
  dbStatus: "connected" | "error";
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function AboutSection() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BASE}/api/settings/system-info`, { credentials: "same-origin" })
      .then((r) => r.ok ? r.json() : null)
      .then((d: SystemInfo | null) => { setInfo(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const rows: Array<{ icon: React.ReactNode; label: string; value: React.ReactNode }> = info
    ? [
        {
          icon: <Info className="h-4 w-4 text-muted-foreground" />,
          label: "Version",
          value: <span className="font-mono text-sm">{info.version}</span>,
        },
        {
          icon: <Cpu className="h-4 w-4 text-muted-foreground" />,
          label: "Node.js",
          value: <span className="font-mono text-sm">{info.nodeVersion}</span>,
        },
        {
          icon: <Server className="h-4 w-4 text-muted-foreground" />,
          label: "Platform",
          value: <span className="font-mono text-sm">{info.platform}</span>,
        },
        {
          icon: <RefreshCw className="h-4 w-4 text-muted-foreground" />,
          label: "Uptime",
          value: <span className="font-mono text-sm">{formatUptime(info.uptimeSeconds)}</span>,
        },
        {
          icon: <Database className="h-4 w-4 text-muted-foreground" />,
          label: "Database",
          value: info.dbStatus === "connected" ? (
            <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-mono text-sm">
              <Wifi className="h-3 w-3" /> connected
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-destructive font-mono text-sm">
              <WifiOff className="h-3 w-3" /> error
            </span>
          ),
        },
      ]
    : [];

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-0">
            <div className="h-4 w-24 bg-muted rounded animate-pulse" />
            <div className="h-4 w-32 bg-muted rounded animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  if (!info) {
    return <p className="text-sm text-muted-foreground">Unable to load system information.</p>;
  }

  return (
    <dl className="space-y-0 divide-y divide-border">
      {rows.map(({ icon, label, value }) => (
        <div key={label} className="flex items-center justify-between py-3">
          <dt className="flex items-center gap-2 text-sm text-muted-foreground">
            {icon}
            {label}
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const INTERVAL_LABELS: Record<PollingIntervalMs, string> = {
  1000: "1 second — fastest, higher server load",
  2000: "2 seconds — balanced (default)",
  5000: "5 seconds — slower, reduced network usage",
};

type BrowserProviderType = "playwright" | "puppeteer" | "local" | "seleniumbase";

interface BrowserConfig {
    provider: BrowserProviderType;
    wsEndpoint: string;
    testUrl?: string;
    sessionTimeoutMs?: number;
    stealth?: boolean;
    blockAds?: boolean;
    proxyUrl?: string;
    ignoreHTTPS?: boolean;
    viewportWidth?: number;
    viewportHeight?: number;
  }

interface TestResult {
  ok: boolean;
  message: string;
  screenshotBase64?: string;
  finalUrl?: string;
  elapsedMs?: number;
}

const PROVIDER_OPTIONS: Array<{
  value: BrowserProviderType;
  label: string;
  tag: string;
  description: string;
  placeholder: string;
  hint: string;
}> = [
  {
    value: "playwright",
    label: "Playwright (CDP)",
    tag: "default",
    description: "CDP via Playwright (connectOverCDP). Works with any CDP-compatible service: browserless, self-hosted Chrome, BrightData, Steel.dev, cloud providers, etc. Stealth anti-detection is handled client-side.",
    placeholder: "ws://browserless:3000",
    hint: "Docker Compose default: ws://browserless:3000 — replace with your actual host if running externally.",
  },
  {
    value: "puppeteer",
    label: "Puppeteer (CDP)",
    tag: "alternative",
    description: "CDP via Puppeteer (browserWSEndpoint). Same compatibility as Playwright CDP — use if your service works better with the Puppeteer library.",
    placeholder: "ws://browserless:3000",
    hint: "Docker Compose default: ws://browserless:3000 — replace with your actual host if running externally.",
  },
  {
    value: "local",
    label: "Local Chrome",
    tag: "local",
    description: "Launches Playwright\'s bundled Chromium directly on this host. No remote browser service needed — ideal for single-machine deployments. Requires Chromium installed (npx playwright install chromium).",
    placeholder: "",
    hint: "No WebSocket endpoint needed — Chromium is launched locally on the server.",
  },
  {
    value: "seleniumbase",
    label: "SeleniumBase UC (cf-proxy)",
    tag: "cloudflare",
    description: "Cloudflare bypass via SeleniumBase Undetected-Chrome. Connects to the bundled cf-proxy service. Best for sites with Cloudflare JS challenge or Turnstile. Enter the cf-proxy HTTP endpoint, not a WebSocket URL.",
    placeholder: "http://cf-proxy:7317",
    hint: "Docker Compose default: http://cf-proxy:7317 — cf-proxy starts automatically with docker compose up -d --build. No extra flags needed.",
  },
];

// ── Task Timeout Section ──────────────────────────────────────────────────────

const TIMEOUT_OPTIONS: Array<{ minutes: number; label: string; sublabel: string }> = [
  { minutes: 0,  label: "Disabled", sublabel: "Tasks run until they finish or crash" },
  { minutes: 5,  label: "5 min",    sublabel: "Short tasks / quick logins" },
  { minutes: 10, label: "10 min",   sublabel: "Recommended for most workflows" },
  { minutes: 30, label: "30 min",   sublabel: "Default — long-running workflows" },
  { minutes: 60, label: "60 min",   sublabel: "Very slow sites or complex pipelines" },
];

function TaskTimeoutSection() {
  const { toast } = useToast();
  const [timeoutMinutes, setTimeoutMinutes] = useState<number>(30);
  const [custom, setCustom] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/settings/task-timeout`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data: { timeoutMinutes: number }) => {
        setTimeoutMinutes(data.timeoutMinutes);
        const isPreset = TIMEOUT_OPTIONS.some((o) => o.minutes === data.timeoutMinutes);
        if (!isPreset) setCustom(String(data.timeoutMinutes));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const isCustomSelected = !TIMEOUT_OPTIONS.some((o) => o.minutes === timeoutMinutes);

  const handleSave = async () => {
    const value = isCustomSelected ? Number(custom) : timeoutMinutes;
    if (!Number.isFinite(value) || value < 0) {
      toast({ title: "Invalid value", description: "Enter a positive number of minutes, or 0 to disable.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/settings/task-timeout`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeoutMinutes: Math.floor(value) }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        toast({ title: "Save failed", description: data.error, variant: "destructive" });
        return;
      }
      setTimeoutMinutes(Math.floor(value));
      toast({ title: "Task timeout saved", variant: "success" });
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {TIMEOUT_OPTIONS.map(({ minutes, label, sublabel }) => {
        const selected = !isCustomSelected && timeoutMinutes === minutes;
        return (
          <button
            key={minutes}
            type="button"
            onClick={() => { setTimeoutMinutes(minutes); setCustom(""); }}
            className={`w-full flex items-center justify-between p-3 rounded-md border text-left transition-all duration-150 ${
              selected
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            <div className="flex items-center gap-3">
              <div className={`flex-shrink-0 h-3 w-3 rounded-full border-2 ${
                selected ? "border-primary bg-primary" : "border-muted-foreground"
              }`} />
              <span className="font-mono font-semibold text-sm">{label}</span>
            </div>
            <span className="text-xs font-mono opacity-70">{sublabel}</span>
          </button>
        );
      })}

      {/* Custom value */}
      <div
        className={`flex items-center gap-3 p-3 rounded-md border transition-all duration-150 ${
          isCustomSelected
            ? "border-primary bg-primary/5"
            : "border-border bg-card hover:bg-accent/40"
        }`}
      >
        <div className={`flex-shrink-0 h-3 w-3 rounded-full border-2 ${
          isCustomSelected ? "border-primary bg-primary" : "border-muted-foreground"
        }`} />
        <span className="font-mono font-semibold text-sm shrink-0">Custom</span>
        <Input
          type="number"
          min={1}
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value && Number.isFinite(n)) setTimeoutMinutes(n);
          }}
          placeholder="e.g. 45"
          className="h-7 w-24 font-mono text-sm px-2"
          onClick={(e) => e.stopPropagation()}
        />
        <span className="text-xs text-muted-foreground">minutes</span>
      </div>

      <Button onClick={handleSave} disabled={saving} className="mt-1">
        {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save"}
      </Button>
    </div>
  );
}

// ── Captcha Section ───────────────────────────────────────────────────────────

type CaptchaProviderType = "none" | "2captcha" | "capsolver" | "anticaptcha";

interface CaptchaConfig {
  provider: CaptchaProviderType;
  twoCaptchaApiKey: string;
  capsolverApiKey: string;
  anticaptchaApiKey: string;
  twoCaptchaKeySet?: boolean;
  capsolverKeySet?: boolean;
  anticaptchaKeySet?: boolean;
}

const CAPTCHA_PROVIDER_OPTIONS: Array<{
  value: CaptchaProviderType;
  label: string;
  description: string;
  keyField: keyof CaptchaConfig;
  keyLabel: string;
  placeholder: string;
  docsUrl: string;
}> = [
  {
    value: "2captcha",
    label: "2Captcha",
    description: "Human-powered solving. Supports reCAPTCHA, hCaptcha, Turnstile, and image captchas.",
    keyField: "twoCaptchaApiKey",
    keyLabel: "2Captcha API Key",
    placeholder: "Paste your 2captcha.com API key",
    docsUrl: "https://2captcha.com/enterpage",
  },
  {
    value: "capsolver",
    label: "Capsolver",
    description: "AI-powered solver. Fast and cost-effective for reCAPTCHA and hCaptcha.",
    keyField: "capsolverApiKey",
    keyLabel: "Capsolver API Key",
    placeholder: "Paste your capsolver.com API key",
    docsUrl: "https://capsolver.com",
  },
  {
    value: "anticaptcha",
    label: "Anti-Captcha",
    description: "Human-powered solving. Supports reCAPTCHA v2/v3, hCaptcha, Turnstile, and image captchas.",
    keyField: "anticaptchaApiKey",
    keyLabel: "Anti-Captcha API Key",
    placeholder: "Paste your anti-captcha.com API key",
    docsUrl: "https://anti-captcha.com",
  },
];

function CaptchaSection() {
  const { toast } = useToast();
  const [config, setConfig] = useState<CaptchaConfig>({
    provider: "none",
    twoCaptchaApiKey: "",
    capsolverApiKey: "",
    anticaptchaApiKey: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/settings/captcha`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data: CaptchaConfig) => setConfig(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/settings/captcha`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        toast({ title: "Save failed", description: data.error, variant: "destructive" });
        return;
      }
      toast({ title: "Captcha settings saved", variant: "success" });
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const activeOption = CAPTCHA_PROVIDER_OPTIONS.find((o) => o.value === config.provider);
  const activeKeyIsSet =
    config.provider === "2captcha" ? config.twoCaptchaKeySet :
    config.provider === "capsolver" ? config.capsolverKeySet :
    config.provider === "anticaptcha" ? config.anticaptchaKeySet : false;

  return (
    <div className="space-y-5">
      {/* Provider selection */}
      <div className="space-y-2">
        <Label>Provider</Label>
        <div className="space-y-2">
          {/* None option */}
          <button
            type="button"
            onClick={() => setConfig((c) => ({ ...c, provider: "none" }))}
            className={`w-full flex items-center gap-3 p-3 rounded-md border text-left transition-all duration-150 ${
              config.provider === "none"
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            <div className={`flex-shrink-0 h-3 w-3 rounded-full border-2 ${
              config.provider === "none" ? "border-primary bg-primary" : "border-muted-foreground"
            }`} />
            <div>
              <p className="font-mono font-semibold text-sm">Disabled</p>
              <p className="text-xs mt-0.5 opacity-70">No captcha solving. Tasks that hit a captcha will pause and require manual intervention.</p>
            </div>
          </button>

          {CAPTCHA_PROVIDER_OPTIONS.map(({ value, label, description }) => {
            const selected = config.provider === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setConfig((c) => ({ ...c, provider: value }))}
                className={`w-full flex items-center gap-3 p-3 rounded-md border text-left transition-all duration-150 ${
                  selected
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"
                }`}
              >
                <div className={`flex-shrink-0 h-3 w-3 rounded-full border-2 ${
                  selected ? "border-primary bg-primary" : "border-muted-foreground"
                }`} />
                <div className="min-w-0">
                  <p className="font-mono font-semibold text-sm">{label}</p>
                  <p className="text-xs mt-0.5 opacity-70">{description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* API Key input — only shown when a provider is selected */}
      {activeOption && (
        <div className="space-y-2">
          <Label htmlFor="captchaApiKey">{activeOption.keyLabel}</Label>
          <Input
            id="captchaApiKey"
            type="text"
            value={(config[activeOption.keyField] as string) ?? ""}
            onChange={(e) =>
              setConfig((c) => ({ ...c, [activeOption.keyField]: e.target.value }))
            }
            placeholder={activeKeyIsSet ? "Key saved — paste to replace" : activeOption.placeholder}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Get your key at{" "}
            <a href={activeOption.docsUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {activeOption.docsUrl.replace("https://", "")}
            </a>
            {activeKeyIsSet && (
              <span className="ml-2 text-green-600 dark:text-green-400 font-medium">✓ Key saved</span>
            )}
          </p>
        </div>
      )}

      <Button onClick={handleSave} disabled={saving}>
        {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save"}
      </Button>
    </div>
  );
}

// ── Concurrency Section ─────────────────────────────────────────────────────────

interface ConcurrencyState {
  maxConcurrent: number;
  maxQueueDepth: number;
  queueTimeoutSecs: number;
  running: number;
  queued: number;
}

function ConcurrencySection() {
  const { toast } = useToast();
  const [config, setConfig] = useState<ConcurrencyState>({ maxConcurrent: 3, maxQueueDepth: 10, queueTimeoutSecs: 300, running: 0, queued: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isDirty = useRef(false);

  const load = () =>
    fetch(`${BASE}/api/settings/concurrency`, { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d: ConcurrencyState) => {
        if (isDirty.current) {
          setConfig((c) => ({ ...c, running: d.running, queued: d.queued }));
        } else {
          setConfig(d);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => { load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/settings/concurrency`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrent: config.maxConcurrent, maxQueueDepth: config.maxQueueDepth, queueTimeoutSecs: config.queueTimeoutSecs }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) { toast({ title: 'Save failed', description: data.error, variant: 'destructive' }); return; }
      isDirty.current = false; toast({ title: 'Concurrency settings saved', variant: 'success' });
    } catch { toast({ title: 'Network error', variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  if (loading) return <div className='flex items-center gap-2 py-6 text-muted-foreground text-sm'><Loader2 className='h-4 w-4 animate-spin' /> Loading…</div>;

  return (
    <div className='space-y-5'>
      {/* Live status badge */}
      <div className='flex items-center gap-3 flex-wrap'>
        <div className='flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm'>
          <span className='text-muted-foreground text-xs'>Running</span>
          <span className={`font-mono font-bold text-base ${config.running > 0 ? 'text-primary' : 'text-foreground'}`}>{config.running}</span>
          <span className='text-muted-foreground text-xs'>/ {config.maxConcurrent}</span>
        </div>
        <div className='flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm'>
          <span className='text-muted-foreground text-xs'>Queued</span>
          <span className={`font-mono font-bold text-base ${config.queued > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>{config.queued}</span>
          {config.maxQueueDepth > 0 && <span className='text-muted-foreground text-xs'>/ {config.maxQueueDepth}</span>}
        </div>
        <p className='text-xs text-muted-foreground'>Updates every 3s</p>
      </div>

      {/* Max concurrent */}
      <div className='space-y-2'>
        <Label htmlFor='maxConcurrent'>Max concurrent sessions</Label>
        <div className='flex items-center gap-3'>
          <Input id='maxConcurrent' type='number' min={1} max={50}
            value={config.maxConcurrent}
            onChange={(e) => { isDirty.current = true; const n = Math.max(1, parseInt(e.target.value, 10) || 1); setConfig((c) => ({ ...c, maxConcurrent: n })); }}
            className='h-9 w-24 font-mono text-sm' />
          <span className='text-xs text-muted-foreground'>sessions</span>
        </div>
        <p className='text-xs text-muted-foreground'>
          How many tasks may run simultaneously. Set this to match your browserless{' '}
          <code className='font-mono'>MAX_CONCURRENT_SESSIONS</code> env var
          (check your Docker Compose or container config). Default: 3.
        </p>
      </div>

      {/* Max queue depth */}
      <div className='space-y-2'>
        <Label htmlFor='maxQueueDepth'>Max queue depth</Label>
        <div className='flex items-center gap-3'>
          <Input id='maxQueueDepth' type='number' min={0} max={200}
            value={config.maxQueueDepth}
            onChange={(e) => { isDirty.current = true; const n = Math.max(0, parseInt(e.target.value, 10) || 0); setConfig((c) => ({ ...c, maxQueueDepth: n })); }}
            className='h-9 w-24 font-mono text-sm' />
          <span className='text-xs text-muted-foreground'>tasks (0 = unlimited)</span>
        </div>
        <p className='text-xs text-muted-foreground'>
          When all slots are busy, new triggers wait in queue. If the queue reaches this limit,
          further triggers are rejected immediately with an error. Default: 10.
        </p>
      </div>

      {/* Queue timeout */}
      <div className='space-y-2'>
        <Label htmlFor='queueTimeout'>Queue wait timeout</Label>
        <div className='flex items-center gap-3'>
          <Input id='queueTimeout' type='number' min={0}
            value={config.queueTimeoutSecs}
            onChange={(e) => { isDirty.current = true; const n = Math.max(0, parseInt(e.target.value, 10) || 0); setConfig((c) => ({ ...c, queueTimeoutSecs: n })); }}
            className='h-9 w-24 font-mono text-sm' />
          <span className='text-xs text-muted-foreground'>seconds (0 = wait forever)</span>
        </div>
        <p className='text-xs text-muted-foreground'>
          If a queued task waits longer than this, it is dropped automatically.
          Prevents stale triggers from running long after they were queued. Default: 300 (5 min).
        </p>
      </div>

      <Button onClick={handleSave} disabled={saving}>
        {saving ? <><Loader2 className='mr-2 h-4 w-4 animate-spin' />Saving…</> : 'Save'}
      </Button>
    </div>
  );
}

// ── Browser Connection Section ────────────────────────────────────────────────

function BrowserProviderSection() {
  const { toast } = useToast();
  const [config, setConfig] = useState<BrowserConfig>({
      provider: "playwright",
      wsEndpoint: "",
      sessionTimeoutMs: 1_800_000,
      stealth: true,
      blockAds: false,
      proxyUrl: "",
      ignoreHTTPS: false,
      viewportWidth: undefined,
      viewportHeight: undefined,
    });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testUrl, setTestUrl] = useState("https://example.com");

  useEffect(() => {
    fetch(`${BASE}/api/settings/browser`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data: Partial<BrowserConfig>) => {
        const validProviders: BrowserProviderType[] = ["playwright", "puppeteer", "local", "seleniumbase"];
        setConfig({
            provider: validProviders.includes(data.provider as BrowserProviderType)
              ? (data.provider as BrowserProviderType)
              : "playwright",
            wsEndpoint: data.wsEndpoint ?? "ws://browserless:3000",
            sessionTimeoutMs: data.sessionTimeoutMs ?? 1_800_000,
            stealth: data.stealth ?? false,
            blockAds: data.blockAds ?? false,
            proxyUrl: data.proxyUrl ?? "",
            ignoreHTTPS: data.ignoreHTTPS ?? false,
            viewportWidth: data.viewportWidth ?? undefined,
            viewportHeight: data.viewportHeight ?? undefined,
          });
          setTestUrl(data.testUrl || "https://example.com");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (config.provider !== "seleniumbase" && config.provider !== "local" && !config.wsEndpoint.trim()) {
      toast({ title: "WebSocket URL required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/settings/browser`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, testUrl: testUrl.trim() }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        toast({ title: "Save failed", description: data.error, variant: "destructive" });
        return;
      }
      toast({ title: "Browser connection saved", variant: "success" });
      setTestResult(null);
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!config.wsEndpoint.trim()) {
      toast({ title: "WebSocket URL required before testing", variant: "destructive" });
      return;
    }
    if (!testUrl.trim()) {
      toast({ title: "Test URL is required", variant: "destructive" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${BASE}/api/settings/browser/test`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, testUrl: testUrl.trim() }),
      });
      const data = await res.json() as TestResult;
      setTestResult(data);
    } catch {
      setTestResult({ ok: false, message: "Network error — could not reach the API server" });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Provider selection */}
      <div className="space-y-2">
        <Label>Library</Label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PROVIDER_OPTIONS.map(({ value, label, tag, description }) => {
            const selected = config.provider === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setConfig((c) => {
                    const prevOpt = PROVIDER_OPTIONS.find((o) => o.value === c.provider);
                    const isDefault = !c.wsEndpoint || c.wsEndpoint === (prevOpt?.placeholder ?? "");
                    const nextOpt = PROVIDER_OPTIONS.find((o) => o.value === value);
                    return {
                      ...c,
                      provider: value,
                      wsEndpoint: isDefault ? (nextOpt?.placeholder ?? "") : c.wsEndpoint,
                    };
                  });
                  setTestResult(null);
                }}
                className={`flex items-start gap-3 p-3 rounded-md border text-left transition-all duration-150 ${
                  selected
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"
                }`}
              >
                <div className={`mt-1 flex-shrink-0 h-3 w-3 rounded-full border-2 ${
                  selected ? "border-primary bg-primary" : "border-muted-foreground"
                }`} />
                <div className="min-w-0">
                  <p className="font-mono font-semibold text-sm">
                    {label}
                    <span className={`ml-2 text-[10px] font-sans font-normal px-1.5 py-0.5 rounded ${
                      tag === "default"
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {tag}
                    </span>
                  </p>
                  <p className="text-xs mt-0.5 opacity-70">{description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* WS endpoint — hidden for local provider */}
      {config.provider !== "local" && (
      <div className="space-y-2">
        <Label htmlFor="wsEndpoint">{config.provider === "seleniumbase" ? "HTTP Endpoint URL" : "WebSocket Endpoint URL"}</Label>
        <Input
          id="wsEndpoint"
          type="text"
          value={config.wsEndpoint}
          onChange={(e) => {
            setConfig((c) => ({ ...c, wsEndpoint: e.target.value }));
            setTestResult(null);
          }}
          placeholder={PROVIDER_OPTIONS.find((o) => o.value === config.provider)?.placeholder ?? "ws://browserless:3000"}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {PROVIDER_OPTIONS.find((o) => o.value === config.provider)?.hint}{" "}
          — or replace with any external service (browserless.io cloud, BrightData, etc.).
        </p>
      </div>
      )}

      {/* Advanced browser options */}
      <div className="space-y-4 rounded-md border border-border bg-muted/10 p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Advanced Options</p>

        {/* Session timeout */}
        <div className="space-y-2">
          <Label htmlFor="sessionTimeout" className="text-sm">
            Session timeout
            <span className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300">service-side</span>
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="sessionTimeout"
              type="number"
              min={1}
              max={480}
              value={Math.round((config.sessionTimeoutMs ?? 1_800_000) / 60_000)}
              onChange={(e) => {
                const mins = Number(e.target.value);
                if (Number.isFinite(mins) && mins > 0) {
                  setConfig((c) => ({ ...c, sessionTimeoutMs: Math.round(mins) * 60_000 }));
                  setTestResult(null);
                }
              }}
              className="h-8 w-24 font-mono text-sm"
            />
            <span className="text-xs text-muted-foreground">minutes</span>
          </div>
          <p className="text-xs text-muted-foreground">
            How long the remote browser session may stay alive. Injected as{" "}
            <code className="font-mono">?timeout=</code> on the WS URL. Prevents browserless from recycling the browser mid-task. Default: 30 min.
          </p>
        </div>

        {/* Stealth mode */}
        <button
          type="button"
          onClick={() => { setConfig((c) => ({ ...c, stealth: !c.stealth })); setTestResult(null); }}
          className={`w-full flex items-center gap-3 p-3 rounded-md border text-left transition-all duration-150 ${config.stealth ? "border-primary bg-primary/5 text-foreground" : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"}`}
        >
          <div className={`flex-shrink-0 h-4 w-7 rounded-full border-2 relative transition-colors ${config.stealth ? "border-primary bg-primary" : "border-muted-foreground bg-muted"}`}>
            <div className={`absolute top-0.5 h-2 w-2 rounded-full bg-white transition-transform ${config.stealth ? "translate-x-3" : "translate-x-0.5"}`} />
          </div>
          <div>
            <p className="text-sm font-medium leading-none">
              Stealth mode
              <span className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">client-side</span>
            </p>
            <p className="text-xs mt-1 opacity-70">Injects comprehensive anti-detection scripts into every page (navigator.webdriver, plugins, WebGL, media codecs, etc.). For best results, also add --disable-blink-features=AutomationControlled to DEFAULT_LAUNCH_ARGS in docker-compose.</p>
          </div>
        </button>

        {/* Block ads */}
        <button
          type="button"
          onClick={() => { setConfig((c) => ({ ...c, blockAds: !c.blockAds })); setTestResult(null); }}
          className={`w-full flex items-center gap-3 p-3 rounded-md border text-left transition-all duration-150 ${config.blockAds ? "border-primary bg-primary/5 text-foreground" : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"}`}
        >
          <div className={`flex-shrink-0 h-4 w-7 rounded-full border-2 relative transition-colors ${config.blockAds ? "border-primary bg-primary" : "border-muted-foreground bg-muted"}`}>
            <div className={`absolute top-0.5 h-2 w-2 rounded-full bg-white transition-transform ${config.blockAds ? "translate-x-3" : "translate-x-0.5"}`} />
          </div>
          <div>
            <p className="text-sm font-medium leading-none">
              Block ads
              <span className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">universal</span>
            </p>
            <p className="text-xs mt-1 opacity-70">Filters major ad networks and trackers. Playwright blocks requests client-side via a built-in domain list; Puppeteer uses the browserless blockAds service-side feature. Speeds up page loads and reduces noise in screenshots.</p>
          </div>
        </button>

        {/* Proxy URL */}
        <div className="space-y-2">
          <Label htmlFor="proxyUrl" className="text-sm">
            Proxy URL
            <span className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">universal</span>
          </Label>
          <Input
            id="proxyUrl"
            type="text"
            value={config.proxyUrl ?? ""}
            onChange={(e) => { setConfig((c) => ({ ...c, proxyUrl: e.target.value })); setTestResult(null); }}
            placeholder="http://user:pass@host:port  or  socks5://host:port"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Routes all browser traffic through a proxy. Playwright applies this via context options (universal). Puppeteer injects it as a Chrome flag in the WS URL.
          </p>
        </div>

        {/* Ignore HTTPS errors */}
        <button
          type="button"
          onClick={() => { setConfig((c) => ({ ...c, ignoreHTTPS: !c.ignoreHTTPS })); setTestResult(null); }}
          className={`w-full flex items-center gap-3 p-3 rounded-md border text-left transition-all duration-150 ${config.ignoreHTTPS ? "border-primary bg-primary/5 text-foreground" : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"}`}
        >
          <div className={`flex-shrink-0 h-4 w-7 rounded-full border-2 relative transition-colors ${config.ignoreHTTPS ? "border-primary bg-primary" : "border-muted-foreground bg-muted"}`}>
            <div className={`absolute top-0.5 h-2 w-2 rounded-full bg-white transition-transform ${config.ignoreHTTPS ? "translate-x-3" : "translate-x-0.5"}`} />
          </div>
          <div>
            <p className="text-sm font-medium leading-none">
              Ignore HTTPS errors
              <span className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">universal</span>
            </p>
            <p className="text-xs mt-1 opacity-70">Accept self-signed, expired, or mismatched TLS certificates. Useful for internal or staging environments.</p>
          </div>
        </button>

        {/* Viewport */}
        <div className="space-y-2">
          <Label className="text-sm">
            Viewport size
            <span className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">universal</span>
          </Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={320}
              max={3840}
              value={config.viewportWidth ?? ""}
              onChange={(e) => {
                const v = e.target.value ? Number(e.target.value) : undefined;
                setConfig((c) => ({ ...c, viewportWidth: v && Number.isFinite(v) ? v : undefined }));
                setTestResult(null);
              }}
              placeholder="auto"
              className="h-8 w-24 font-mono text-sm"
            />
            <span className="text-xs text-muted-foreground">&times;</span>
            <Input
              type="number"
              min={240}
              max={2160}
              value={config.viewportHeight ?? ""}
              onChange={(e) => {
                const v = e.target.value ? Number(e.target.value) : undefined;
                setConfig((c) => ({ ...c, viewportHeight: v && Number.isFinite(v) ? v : undefined }));
                setTestResult(null);
              }}
              placeholder="auto"
              className="h-8 w-24 font-mono text-sm"
            />
            <span className="text-xs text-muted-foreground">px</span>
            {(config.viewportWidth || config.viewportHeight) && (
              <button
                type="button"
                onClick={() => { setConfig((c) => ({ ...c, viewportWidth: undefined, viewportHeight: undefined })); setTestResult(null); }}
                className="text-xs text-muted-foreground hover:text-foreground underline"
              >
                reset
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Leave empty for random rotation (1920&times;1080, 1536&times;864, 1440&times;900, 1366&times;768, 1280&times;800, 1280&times;720) — better for anti-fingerprinting. Set specific dimensions if your target site requires a particular resolution.
          </p>
        </div>
      </div>

            {/* Test URL */}
      <div className="space-y-2">
        <Label htmlFor="testUrl">Test URL</Label>
        <Input
          id="testUrl"
          type="text"
          value={testUrl}
          onChange={(e) => {
            setTestUrl(e.target.value);
            setTestResult(null);
          }}
          placeholder="https://example.com"
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          The browser will navigate to this URL when you click "Test connection". Use a URL
          from your actual target site to confirm end-to-end internet reachability.
        </p>
      </div>

      {/* Actions */}
      <div className="flex gap-3 flex-wrap">
        <Button onClick={handleSave} disabled={saving || testing}>
          {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save"}
        </Button>
        <Button variant="outline" onClick={handleTest} disabled={saving || testing}>
          {testing ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Testing connection…</>
          ) : (
            <><Wifi className="mr-2 h-4 w-4" />Test connection</>
          )}
        </Button>
      </div>

      {/* Test result */}
      {testResult && (
        <div className={`rounded-md border p-4 space-y-3 ${
          testResult.ok
            ? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950"
            : "border-destructive/30 bg-destructive/5"
        }`}>
          <div className="flex items-start gap-3">
            {testResult.ok ? (
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
            ) : (
              <WifiOff className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
            )}
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-medium ${testResult.ok ? "text-green-800 dark:text-green-200" : "text-destructive"}`}>
                {testResult.ok ? "Connection successful" : "Connection failed"}
              </p>
              <p className={`text-xs mt-0.5 font-mono break-all ${testResult.ok ? "text-green-700 dark:text-green-300" : "text-destructive/80"}`}>
                {testResult.message}
              </p>
              {testResult.ok && testResult.finalUrl && (
                <p className="text-xs mt-1 font-mono break-all text-green-700 dark:text-green-300 opacity-75">
                  Final URL: {testResult.finalUrl}
                </p>
              )}
              {testResult.ok && testResult.elapsedMs !== undefined && (
                <p className="text-xs mt-0.5 text-green-700 dark:text-green-300 opacity-75">
                  Navigation time: {testResult.elapsedMs}ms
                </p>
              )}
            </div>
          </div>
          {testResult.screenshotBase64 && (
            <img
              src={`data:image/png;base64,${testResult.screenshotBase64}`}
              alt="Test screenshot"
              className="rounded border border-green-200 dark:border-green-800 w-full max-w-sm object-contain"
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────────

export default function Settings() {
  const [pollingInterval, setPollingInterval] = usePollingInterval();
  const { toast } = useToast();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const handleSelect = (ms: PollingIntervalMs) => {
    setPollingInterval(ms);
    toast({
      title: "Setting saved",
      description: `Live polling interval set to ${ms / 1000}s.`,
      variant: "success",
    });
  };

  const handlePasswordSubmit = (e: FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters");
      return;
    }

    setShowConfirmDialog(true);
  };

  const submitPasswordChange = async () => {
    setShowConfirmDialog(false);
    setPasswordLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/password`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setPasswordError(data.error ?? "Failed to change password");
        return;
      }
      setPasswordSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setPasswordError("Network error. Please try again.");
    } finally {
      setPasswordLoading(false);
    }
  };

  return (
    <>
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Sign out of all sessions?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                Changing your password will immediately sign out <strong>all other active sessions</strong> (other tabs and devices). This session will remain active.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={submitPasswordChange}>
              Yes, change password
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="space-y-8 animate-in fade-in duration-500 max-w-2xl">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Settings</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">Platform configuration and preferences</p>
        </div>

        {/* ── Concurrency ── */}
          <Card className="border-border shadow-sm">
            <CardHeader className="bg-muted/20 border-b border-border pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Cpu className="h-4 w-4 text-primary" /> Concurrency
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                Control how many browser automation tasks run simultaneously. Set{" "}
                <code className="font-mono">Max concurrent sessions</code> to match the{" "}
                <code className="font-mono">MAX_CONCURRENT_SESSIONS</code> value in your
                local browserless Docker image so the platform queue and the browser backend
                stay in sync.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <ConcurrencySection />
            </CardContent>
          </Card>

          {/* ── Browser Connection ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" /> Browser Connection
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Configure the headless browser backend. Both providers connect via CDP
              (Chrome DevTools Protocol). Default Docker Compose endpoint:{" "}
              <code className="font-mono">ws://browserless:3000</code>.
              For standalone deployments, replace <code className="font-mono">browserless</code>{" "}
              with your actual host address. Stealth anti-detection is handled client-side.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <BrowserProviderSection />
          </CardContent>
        </Card>

        {/* ── Task Timeout ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <Timer className="h-4 w-4 text-primary" /> Task Timeout
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Maximum time a task may run before it is automatically killed and marked as failed.
              Applies to every task run, including scheduled ones. If a task legitimately takes
              longer, increase the limit or disable it entirely.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <TaskTimeoutSection />
          </CardContent>
        </Card>

        {/* ── Captcha ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" /> Captcha Solving
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Configure a captcha solving service. When a task encounters a captcha, the solver
              is called automatically. If disabled, tasks that hit a captcha will pause and log
              a screenshot for manual review.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <CaptchaSection />
          </CardContent>
        </Card>

        {/* ── Live Polling Interval ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-primary" /> Live Polling Interval
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              How often the dashboard and task detail page refresh while a task is running.
              Polling pauses automatically when no tasks are active.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6 space-y-3">
            {POLLING_OPTIONS.map((ms) => (
              <button
                key={ms}
                onClick={() => handleSelect(ms)}
                className={`w-full flex items-center justify-between p-4 rounded-md border text-left transition-all duration-150 ${
                  pollingInterval === ms
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`h-3 w-3 rounded-full border-2 flex-shrink-0 ${
                    pollingInterval === ms
                      ? "border-primary bg-primary"
                      : "border-muted-foreground"
                  }`} />
                  <span className="font-mono font-semibold text-sm">{ms / 1000}s</span>
                </div>
                <span className="text-xs font-mono">{INTERVAL_LABELS[ms]}</span>
              </button>
            ))}
          </CardContent>
        </Card>

        {/* ── Change Password ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" /> Change Password
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Update your dashboard login password. The new password will take effect immediately.
              Other active sessions will be signed out; this tab stays logged in.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            {passwordSuccess ? (
              <div className="flex items-center gap-3 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
                <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium">Password changed successfully</p>
                  <p className="text-xs mt-0.5 opacity-80">You are still logged in. Other active sessions have been signed out.</p>
                </div>
              </div>
            ) : (
              <form onSubmit={handlePasswordSubmit} className="space-y-4 max-w-sm">
                <div className="space-y-2">
                  <Label htmlFor="currentPassword">Current Password</Label>
                  <Input
                    id="currentPassword"
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                    disabled={passwordLoading}
                    required
                    autoComplete="current-password"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="newPassword">New Password</Label>
                  <Input
                    id="newPassword"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    disabled={passwordLoading}
                    required
                    autoComplete="new-password"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm New Password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    disabled={passwordLoading}
                    required
                    autoComplete="new-password"
                  />
                </div>

                {passwordError && (
                  <p className="text-sm text-destructive">{passwordError}</p>
                )}

                <Button
                  type="submit"
                  disabled={passwordLoading || !currentPassword || !newPassword || !confirmPassword}
                >
                  {passwordLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Updating…
                    </>
                  ) : (
                    "Update password"
                  )}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        {/* ── Retention / Cleanup ── */}
          <Card className="border-border shadow-sm">
            <CardHeader className="bg-muted/20 border-b border-border pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Archive className="h-4 w-4 text-primary" /> Data Retention
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                How long logs and screenshots are kept. Cleanup runs automatically at 03:30 each night.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <RetentionSection />
            </CardContent>
          </Card>

          {/* ── About / System Info ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <Info className="h-4 w-4 text-primary" /> About
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Runtime environment details for this AutoOps instance.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <AboutSection />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
