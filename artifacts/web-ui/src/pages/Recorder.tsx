import { useState, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import {
  MousePointer2, Type, Navigation, Keyboard, ArrowDown, ArrowUp,
  Clock, Camera, Undo2, StopCircle, Play, Copy, CheckCheck,
  Loader2, AlertCircle, ChevronRight, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ─────────────────────────────────────────────────────────────────────

type WorkflowStep =
  | { type: "navigate"; url: string }
  | { type: "click"; selector: string; selectorType: "text" | "css" | "xpath" }
  | { type: "fill"; selector: string; value: string }
  | { type: "select"; selector: string; value: string }
  | { type: "scroll"; selector?: string; x?: number; y?: number }
  | { type: "hover"; selector: string; selectorType: "css" | "xpath" }
  | { type: "wait"; ms: number }
  | { type: "waitFor"; selector: string; timeout?: number }
  | { type: "screenshot" }
  | { type: "switchToNewPage"; timeout?: number }
  | { type: "keypress"; key: string };

interface SessionState {
  sessionId: string;
  screenshotBase64: string;
  currentUrl: string;
  pageTitle: string;
  steps: WorkflowStep[];
}

// ── Step description helpers ──────────────────────────────────────────────────

function stepIcon(step: WorkflowStep) {
  switch (step.type) {
    case "navigate":     return <Navigation className="h-3 w-3 flex-shrink-0" />;
    case "click":       return <MousePointer2 className="h-3 w-3 flex-shrink-0" />;
    case "fill":        return <Type className="h-3 w-3 flex-shrink-0" />;
    case "scroll":      return <ArrowDown className="h-3 w-3 flex-shrink-0" />;
    case "hover":       return <MousePointer2 className="h-3 w-3 flex-shrink-0 opacity-50" />;
    case "wait":        return <Clock className="h-3 w-3 flex-shrink-0" />;
    case "screenshot":  return <Camera className="h-3 w-3 flex-shrink-0" />;
    case "keypress":    return <Keyboard className="h-3 w-3 flex-shrink-0" />;
    default:            return <ChevronRight className="h-3 w-3 flex-shrink-0" />;
  }
}

function stepLabel(step: WorkflowStep): string {
  switch (step.type) {
    case "navigate":   return `Go to ${step.url}`;
    case "click":      return `Click ${step.selector}`;
    case "fill":       return `Type "${step.value}" into ${step.selector}`;
    case "scroll":     return `Scroll ${(step.y ?? 0) > 0 ? "down" : "up"} ${Math.abs(step.y ?? 0)}px`;
    case "hover":      return `Hover ${step.selector}`;
    case "wait":       return `Wait ${step.ms}ms`;
    case "screenshot": return "Take screenshot";
    case "keypress":   return `Press ${step.key}`;
    case "select":     return `Select "${step.value}" in ${step.selector}`;
    case "waitFor":    return `Wait for ${step.selector}`;
    case "switchToNewPage": return "Switch to new tab";
    default:           return (step as { type: string }).type;
  }
}

function stepBadgeVariant(step: WorkflowStep): "default" | "secondary" | "outline" {
  switch (step.type) {
    case "navigate": return "default";
    case "click":    return "secondary";
    case "fill":     return "secondary";
    default:         return "outline";
  }
}

// ── Recorder page ─────────────────────────────────────────────────────────────

export default function Recorder() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  // Start form
  const [startUrl, setStartUrl] = useState("https://");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Session
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);

  // Toolbar inputs
  const [typeText, setTypeText] = useState("");
  const [navUrl, setNavUrl] = useState("");
  const [waitMs, setWaitMs] = useState("1000");

  // Copy-to-clipboard state
  const [copied, setCopied] = useState(false);

  const imgRef = useRef<HTMLImageElement>(null);

  // ── API helpers ─────────────────────────────────────────────────────────────

  const startSession = async () => {
    if (!startUrl.trim() || startUrl === "https://") {
      setStartError("Please enter a valid URL");
      return;
    }
    setStartError(null);
    setStarting(true);
    try {
      const res = await fetch(`${BASE}/api/recorder/sessions`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startUrl: startUrl.trim() }),
      });
      const data = await res.json() as SessionState & { error?: string };
      if (!res.ok || data.error) {
        setStartError(data.error ?? "Failed to start browser session");
        return;
      }
      setSession(data);
      setStopped(false);
    } catch {
      setStartError("Network error — could not reach API server");
    } finally {
      setStarting(false);
    }
  };

  const sendAction = useCallback(async (action: Record<string, unknown>) => {
    if (!session || busy || stopped) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`${BASE}/api/recorder/sessions/${session.sessionId}/actions`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      });
      const data = await res.json() as SessionState & { ok: boolean; error?: string };
      if (data.error && !data.ok) setActionError(data.error);
      if (data.screenshotBase64) {
        setSession((s) => s ? { ...s, ...data } : s);
      }
    } catch {
      setActionError("Network error");
    } finally {
      setBusy(false);
    }
  }, [session, busy, stopped]);

  const stopSession = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await fetch(`${BASE}/api/recorder/sessions/${session.sessionId}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      setStopped(true);
    } catch {
      setStopped(true);
    } finally {
      setBusy(false);
    }
  };

  // ── Screenshot click → click action ────────────────────────────────────────

  const handleScreenshotClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (busy || stopped || !session) return;
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    // Browser viewport is always 1280×800
    const scaleX = 1280 / rect.width;
    const scaleY = 800 / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    sendAction({ type: "click", x, y });
  };

  // ── Copy steps to clipboard ─────────────────────────────────────────────────

  const copySteps = async () => {
    if (!session) return;
    const json = JSON.stringify(session.steps, null, 2);
    await navigator.clipboard.writeText(json).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: "Steps copied to clipboard", variant: "success" });
  };

  // ── Use steps in task form ──────────────────────────────────────────────────

  const useSteps = () => {
    if (!session?.steps.length) return;
    sessionStorage.setItem("recorder_steps", JSON.stringify(session.steps));
    navigate("/tasks/new");
    toast({ title: "Steps loaded into task form", variant: "success" });
  };

  // ── Render: Start form ──────────────────────────────────────────────────────

  if (!session) {
    return (
      <div className="space-y-8 animate-in fade-in duration-500 max-w-2xl">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Step Recorder</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">
            Navigate a live browser and capture your actions as workflow steps automatically.
          </p>
        </div>

        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base">Start Recording</CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="startUrl">Starting URL</Label>
              <Input
                id="startUrl"
                type="url"
                value={startUrl}
                onChange={(e) => { setStartUrl(e.target.value); setStartError(null); }}
                onKeyDown={(e) => e.key === "Enter" && startSession()}
                placeholder="https://example.com/login"
                className="font-mono text-sm"
                disabled={starting}
              />
              <p className="text-xs text-muted-foreground">
                The browser will open at this URL. Then interact with the screenshot to record steps.
              </p>
            </div>

            {startError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                {startError}
              </div>
            )}

            <Button onClick={startSession} disabled={starting}>
              {starting ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Opening browser…</>
              ) : (
                <><Play className="mr-2 h-4 w-4" />Start Recording</>
              )}
            </Button>
          </CardContent>
        </Card>

        <div className="rounded-md border border-border bg-muted/20 p-4 space-y-2">
          <p className="text-sm font-medium">How it works</p>
          <ul className="text-xs text-muted-foreground space-y-1.5 list-none">
            <li className="flex items-start gap-2"><MousePointer2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-primary" /><span>Click anywhere on the screenshot to generate a <code className="font-mono bg-muted px-1 rounded">click</code> step</span></li>
            <li className="flex items-start gap-2"><Type className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-primary" /><span>Click a field first, then use the Type toolbar to generate a <code className="font-mono bg-muted px-1 rounded">fill</code> step</span></li>
            <li className="flex items-start gap-2"><Navigation className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-primary" /><span>Use Navigate to jump to any URL mid-recording</span></li>
            <li className="flex items-start gap-2"><StopCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-primary" /><span>Stop recording to export the step list to a new task</span></li>
          </ul>
        </div>
      </div>
    );
  }

  // ── Render: Recording UI ────────────────────────────────────────────────────

  const isActive = !stopped;
  const steps = session.steps;

  return (
    <div className="animate-in fade-in duration-300 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Step Recorder
            {isActive && (
              <span className="ml-3 inline-flex items-center gap-1.5 text-sm font-normal text-red-500">
                <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                Recording
              </span>
            )}
            {stopped && (
              <span className="ml-3 inline-flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
                <span className="h-2 w-2 rounded-full bg-muted-foreground" />
                Stopped
              </span>
            )}
          </h1>
          <p className="text-xs font-mono text-muted-foreground mt-0.5 truncate max-w-xl">
            {session.pageTitle || session.currentUrl}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isActive && (
            <Button
              variant="destructive"
              size="sm"
              onClick={stopSession}
              disabled={busy}
            >
              <StopCircle className="mr-1.5 h-4 w-4" />
              Stop
            </Button>
          )}
          {stopped && (
            <>
              <Button variant="outline" size="sm" onClick={copySteps}>
                {copied
                  ? <><CheckCheck className="mr-1.5 h-4 w-4" />Copied!</>
                  : <><Copy className="mr-1.5 h-4 w-4" />Copy JSON</>
                }
              </Button>
              <Button size="sm" onClick={useSteps}>
                Use these steps
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setSession(null); setStopped(false); }}
              >
                New recording
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Main split layout */}
      <div className="flex gap-4" style={{ minHeight: "560px" }}>
        {/* Left: Steps list */}
        <div className="w-72 flex-shrink-0 flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Steps ({steps.length})
            </span>
            {isActive && steps.length > 1 && (
              <button
                onClick={() => sendAction({ type: "undo" })}
                disabled={busy}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
              >
                <Undo2 className="h-3 w-3" />
                Undo
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto space-y-1 border border-border rounded-md bg-card p-2">
            {steps.map((step, i) => (
              <div
                key={i}
                className="flex items-start gap-2 px-2 py-1.5 rounded text-xs bg-muted/30 hover:bg-muted/60 transition-colors"
              >
                <span className="text-muted-foreground mt-0.5 font-mono text-[10px] w-4 text-right flex-shrink-0">
                  {i + 1}
                </span>
                <span className="text-muted-foreground mt-0.5 flex-shrink-0">
                  {stepIcon(step)}
                </span>
                <div className="min-w-0 flex-1">
                  <Badge variant={stepBadgeVariant(step)} className="text-[9px] px-1 py-0 h-4 font-mono mb-0.5">
                    {step.type}
                  </Badge>
                  <p className="text-[10px] text-muted-foreground break-all leading-snug">
                    {stepLabel(step)}
                  </p>
                </div>
              </div>
            ))}
            {steps.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">No steps yet</p>
            )}
          </div>

          {/* Stopped: JSON preview */}
          {stopped && (
            <div className="mt-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-1">JSON</p>
              <pre className="text-[9px] font-mono bg-muted/50 border border-border rounded-md p-2 overflow-auto max-h-48 leading-relaxed">
                {JSON.stringify(steps, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Right: Screenshot + toolbar */}
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          {/* URL bar */}
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5">
            <span className="h-2 w-2 rounded-full bg-green-500 flex-shrink-0" />
            <span className="text-xs font-mono text-muted-foreground truncate flex-1">
              {session.currentUrl}
            </span>
            {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground flex-shrink-0" />}
          </div>

          {/* Screenshot */}
          <div className={`relative flex-1 border border-border rounded-md overflow-hidden bg-muted/20 ${isActive ? "cursor-crosshair" : "cursor-default"}`}>
            {session.screenshotBase64 ? (
              <>
                <img
                  ref={imgRef}
                  src={`data:image/png;base64,${session.screenshotBase64}`}
                  alt="Browser screenshot"
                  className="w-full h-full object-contain select-none"
                  onClick={isActive ? handleScreenshotClick : undefined}
                  draggable={false}
                />
                {busy && (
                  <div className="absolute inset-0 bg-background/40 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  </div>
                )}
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            )}
          </div>

          {/* Action error */}
          {actionError && (
            <div className="flex items-center gap-2 text-xs text-destructive border border-destructive/30 bg-destructive/5 rounded px-3 py-2">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              {actionError}
            </div>
          )}

          {/* Toolbar — only shown when active */}
          {isActive && (
            <div className="border border-border rounded-md bg-card p-3 space-y-3">
              {/* Row 1: Type + Navigate */}
              <div className="flex gap-3 flex-wrap">
                {/* Type text */}
                <div className="flex items-center gap-2 flex-1 min-w-[180px]">
                  <Type className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <Input
                    value={typeText}
                    onChange={(e) => setTypeText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && typeText.trim()) {
                        sendAction({ type: "type", text: typeText.trim() });
                        setTypeText("");
                      }
                    }}
                    placeholder="Type text then Enter…"
                    className="h-7 text-xs font-mono"
                    disabled={busy}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={busy || !typeText.trim()}
                    onClick={() => { sendAction({ type: "type", text: typeText.trim() }); setTypeText(""); }}
                  >
                    Type
                  </Button>
                </div>

                {/* Navigate */}
                <div className="flex items-center gap-2 flex-1 min-w-[180px]">
                  <Navigation className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <Input
                    value={navUrl}
                    onChange={(e) => setNavUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && navUrl.trim()) {
                        sendAction({ type: "navigate", url: navUrl.trim() });
                        setNavUrl("");
                      }
                    }}
                    placeholder="https://… then Enter"
                    className="h-7 text-xs font-mono"
                    disabled={busy}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={busy || !navUrl.trim()}
                    onClick={() => { sendAction({ type: "navigate", url: navUrl.trim() }); setNavUrl(""); }}
                  >
                    Go
                  </Button>
                </div>
              </div>

              {/* Row 2: Quick actions */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold w-full sm:w-auto">Quick:</span>
                {[
                  { label: "Enter", icon: <Keyboard className="h-3 w-3" />, action: { type: "keypress", key: "Enter" } },
                  { label: "Tab", icon: <Keyboard className="h-3 w-3" />, action: { type: "keypress", key: "Tab" } },
                  { label: "Escape", icon: <Keyboard className="h-3 w-3" />, action: { type: "keypress", key: "Escape" } },
                  { label: "↓ Scroll", icon: <ArrowDown className="h-3 w-3" />, action: { type: "scroll", deltaY: 300 } },
                  { label: "↑ Scroll", icon: <ArrowUp className="h-3 w-3" />, action: { type: "scroll", deltaY: -300 } },
                  { label: "Screenshot", icon: <Camera className="h-3 w-3" />, action: { type: "screenshot" } },
                ].map(({ label, icon, action }) => (
                  <Button
                    key={label}
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs gap-1.5"
                    disabled={busy}
                    onClick={() => sendAction(action)}
                  >
                    {icon}
                    {label}
                  </Button>
                ))}

                {/* Wait */}
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs gap-1.5"
                    disabled={busy}
                    onClick={() => sendAction({ type: "wait", ms: parseInt(waitMs, 10) || 1000 })}
                  >
                    <Clock className="h-3 w-3" />
                    Wait
                  </Button>
                  <Input
                    value={waitMs}
                    onChange={(e) => setWaitMs(e.target.value)}
                    className="h-7 w-16 text-xs font-mono px-2"
                    disabled={busy}
                  />
                  <span className="text-xs text-muted-foreground">ms</span>
                </div>

                {/* Clear all steps */}
                {steps.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-destructive ml-auto"
                    disabled={busy}
                    onClick={() => {
                      setSession((s) => s ? { ...s, steps: [s.steps[0]] } : s);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
