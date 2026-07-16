import { useEffect, useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  ArrowLeft,
  Save,
  Plus,
  Crosshair,
  X,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  StepEditor,
  type WorkflowStep,
  type SavedCredentialOption,
  type ConditionType,
  type ThenActionType,
  type ConditionalAction,
} from "@/components/StepEditor";

import {
  useCreateTask,
  useUpdateTask,
  useGetTask,
  getGetTaskQueryKey,
  getListTasksQueryKey,
  getGetTasksSummaryQueryKey,
} from "@workspace/api-client-react";
import { useLang } from "@/contexts/lang-context";
import type { WorkflowStep as ApiWorkflowStep } from "@workspace/api-client-react";

const thenActionSchema = z
  .object({
    type: z.enum([
      "click",
      "fill",
      "navigate",
      "wait",
      "keypress",
      "screenshot",
      "scroll",
      "continue",
      "exitSuccess",
      "exitFailure",
    ]),
    selector: z.string().optional(),
    selectorType: z.enum(["text", "css", "xpath"]).optional(),
    url: z.string().optional(),
    value: z.string().optional(),
    ms: z.number().optional(),
    key: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    message: z.string().optional(),
  })
  .optional();

const stepSchema = z.object({
  type: z.enum([
    "navigate",
    "click",
    "fill",
    "wait",
    "waitFor",
    "screenshot",
    "scroll",
    "hover",
    "keypress",
    "select",
    "switchToNewPage",
    "login",
    "condition",
    "dismissPopups",
    "cfVerify",
  ]),
  url: z.string().optional(),
  selector: z.string().optional(),
  selectorType: z.enum(["text", "css", "xpath"]).optional(),
  value: z.string().optional(),
  ms: z.number().optional(),
  timeout: z.number().optional(),
  key: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  loginMethod: z.enum(["form", "github", "google", "cookie"]).optional(),
  loginUrl: z.string().optional(),
  credentialId: z.number().optional(),
  credentialSource: z.enum(["saved", "inline"]).optional(),
  inlineUsername: z.string().optional(),
  inlinePassword: z.string().optional(),
  inlineTotp: z.string().optional(),
  successSelector: z.string().optional(),
  successText: z.string().optional(),
  cookieMode: z.boolean().optional(),
  sessionKey: z.string().optional(),
  cookies: z.string().optional(),
  conditionType: z
    .enum([
      "text_contains",
      "text_not_contains",
      "element_visible",
      "element_not_visible",
      "url_contains",
    ])
    .optional(),
  conditionValue: z.string().optional(),
  conditionSelector: z.string().optional(),
  maxReloads: z.number().optional(),
  thenAction: thenActionSchema,
  elseAction: thenActionSchema,
});

const formSchema = z.object({
  name: z.string().min(1, "任务名称不能为空"),
  targetUrl: z.string().url("请输入有效的 URL").min(1, "目标 URL 不能为空"),
  cronExpression: z.string().optional(),
  // Kept as strings so the inputs can be cleared while editing; parsed on submit.
  retryCount: z.string().optional(),
  retryIntervalMinutes: z.string().optional(),
  steps: z.array(stepSchema).default([]),
});

type FormValues = z.infer<typeof formSchema>;

type BrowserProvider = "playwright" | "puppeteer" | "local" | "seleniumbase";

type ProxyType =
  | "http"
  | "socks5"
  | "warp"
  | "vless"
  | "vmess"
  | "trojan"
  | "hy2"
  | "tuic"
  | "ss";

interface BrowserConfigState {
  enabled: boolean;
  provider: BrowserProvider;
  wsEndpoint: string;
  proxyUrl: string;
  proxyType: ProxyType;
  /** WARP only — how many fresh WARP identities (exit IPs) to try when reCAPTCHA blocks the audio challenge. */
  warpRotations: string;
  headed: boolean;
  stealth: boolean;
  blockAds: boolean;
  ignoreHTTPS: boolean;
  sessionTimeoutMs: string;
  // Fingerprint spoofing (cf-proxy / SeleniumBase only)
  fpOs: "" | "windows" | "mac";
  fpTimezone: string;
  fpLocale: string;
  fpAutoGeo: boolean;
}

const defaultBrowserConfig: BrowserConfigState = {
  enabled: false,
  provider: "playwright",
  wsEndpoint: "",
  proxyUrl: "",
  proxyType: "http",
  warpRotations: "",
  headed: false,
  stealth: false,
  blockAds: false,
  ignoreHTTPS: false,
  sessionTimeoutMs: "",
  fpOs: "",
  fpTimezone: "",
  fpLocale: "",
  fpAutoGeo: true,
};

const PROVIDER_LABELS: Record<BrowserProvider, string> = {
  playwright: "Playwright (默认)",
  puppeteer: "Puppeteer",
  local: "Local Chrome",
  seleniumbase: "SeleniumBase (CF Bypass)",
};

/**
 * A small numeric field for one unit of a duration (day / hour / minute).
 * Fixes the old input's UX bugs: it accepts an empty value while editing,
 * supports pasting/replacing without a sticky leading "1", and only clamps
 * to a valid number on blur.
 */
function DurationField({
  label,
  value,
  onChange,
  max = 999,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") {
            onChange("0");
            return;
          }
          const n = parseInt(raw, 10);
          onChange(String(isNaN(n) ? 0 : Math.min(max, Math.max(0, n))));
        }}
        className="w-16 h-9 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring font-mono"
      />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

export default function TaskForm() {
  const { t } = useLang();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [matchEdit, paramsEdit] = useRoute("/tasks/:id/edit");
  const isEditMode = matchEdit && paramsEdit?.id !== undefined;
  const taskId = isEditMode ? parseInt(paramsEdit.id, 10) : undefined;

  const { data: task, isLoading: isLoadingTask } = useGetTask(
    taskId as number,
    {
      query: {
        enabled: isEditMode && !!taskId,
        queryKey: getGetTaskQueryKey(taskId as number),
      },
    },
  );

  const [savedCredentials, setSavedCredentials] = useState<
    Array<{ id: number; name: string; username: string }>
  >([]);
  const [browserConfig, setBrowserConfig] =
    useState<BrowserConfigState>(defaultBrowserConfig);
  const [browserConfigExpanded, setBrowserConfigExpanded] = useState(false);

  useEffect(() => {
    fetch("/api/saved-credentials")
      .then((r) => r.json())
      .then(setSavedCredentials)
      .catch(() => {});
  }, []);

  const createTask = useCreateTask();
  const updateTask = useUpdateTask();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      targetUrl: "",
      cronExpression: "",
      retryCount: "",
      retryIntervalMinutes: "",
      steps: [],
    },
  });

  const targetUrl = form.watch("targetUrl");
  const steps = form.watch("steps");
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [scheduleType, setScheduleType] = useState<
    "none" | "cron" | "random" | "after_completion"
  >("none");
  // Delay-after-completion, expressed as a free combination of days / hours /
  // minutes. Stored as raw strings so the inputs can be cleared, pasted into,
  // and edited freely (no forced "1" on every keystroke). Clamped only when the
  // cron value is built in onSubmit.
  const [acDays, setAcDays] = useState("0");
  const [acHours, setAcHours] = useState("0");
  const [acMinutes, setAcMinutes] = useState("60");
  // Random-interval window, also a free d/h/m combination.
  const [rwDays, setRwDays] = useState("1");
  const [rwHours, setRwHours] = useState("0");
  const [rwMinutes, setRwMinutes] = useState("0");
  const [randomCount, setRandomCount] = useState("1");

  // Load steps recorded by the Step Recorder (only in create mode)
  useEffect(() => {
    if (isEditMode) return;
    const stored = sessionStorage.getItem("recorder_steps");
    if (!stored) return;
    sessionStorage.removeItem("recorder_steps");
    try {
      const parsed = JSON.parse(stored) as WorkflowStep[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        form.setValue("steps", parsed as never, { shouldDirty: true });
        setImportedCount(parsed.length);
      }
    } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isEditMode && task) {
      const cron = task.cronExpression || "";
      const splitDHM = (totalMinutes: number) => ({
        d: Math.floor(totalMinutes / 1440),
        h: Math.floor((totalMinutes % 1440) / 60),
        m: totalMinutes % 60,
      });
      if (cron.startsWith("@random:")) {
        const parts = cron.split(":");
        setScheduleType("random");
        const windowMinutes = parseInt(parts[1] ?? "1440", 10) || 1440;
        const { d, h, m } = splitDHM(windowMinutes);
        setRwDays(String(d));
        setRwHours(String(h));
        setRwMinutes(String(m));
        setRandomCount(parts[2] ?? "1");
      } else if (cron.startsWith("@after_completion:")) {
        setScheduleType("after_completion");
        const total = parseInt(cron.split(":")[1] ?? "60", 10) || 60;
        const { d, h, m } = splitDHM(total);
        setAcDays(String(d));
        setAcHours(String(h));
        setAcMinutes(String(m));
      } else if (cron) {
        setScheduleType("cron");
      } else {
        setScheduleType("none");
      }
      form.reset({
        name: task.name,
        targetUrl: task.targetUrl,
        cronExpression: cron.startsWith("@random:") ? "" : cron,
        retryCount: task.retryCount != null ? String(task.retryCount) : "",
        retryIntervalMinutes:
          task.retryIntervalMinutes != null ? String(task.retryIntervalMinutes) : "",
        steps: (task.steps as WorkflowStep[] | null | undefined) ?? [],
      });

      // Load browserConfig from task
      const bc = task.browserConfig as
        | Record<string, unknown>
        | null
        | undefined;
      if (bc && typeof bc === "object") {
        setBrowserConfig({
          enabled: true,
          provider: (bc.provider as BrowserProvider) || "playwright",
          wsEndpoint: (bc.wsEndpoint as string) || "",
          proxyUrl: (bc.proxyUrl as string) || "",
          proxyType: (bc.proxyType as ProxyType) || "http",
          warpRotations:
            bc.warpRotations === null || bc.warpRotations === undefined ? "" : String(bc.warpRotations),
          headed: (bc.headed as boolean) || false,
          stealth: (bc.stealth as boolean) || false,
          blockAds: (bc.blockAds as boolean) || false,
          ignoreHTTPS: (bc.ignoreHTTPS as boolean) || false,
          sessionTimeoutMs: bc.sessionTimeoutMs
            ? String(bc.sessionTimeoutMs)
            : "",
          fpOs: ((bc.fingerprint as Record<string, unknown> | undefined)?.os as
            | ""
            | "windows"
            | "mac") || "",
          fpTimezone:
            ((bc.fingerprint as Record<string, unknown> | undefined)?.timezone as string) || "",
          fpLocale:
            ((bc.fingerprint as Record<string, unknown> | undefined)?.locale as string) || "",
          fpAutoGeo:
            ((bc.fingerprint as Record<string, unknown> | undefined)?.autoGeo as boolean) ?? true,
        });
        setBrowserConfigExpanded(true);
      }
    }
  }, [isEditMode, task, form]);

  const buildBrowserConfigPayload = () => {
    if (!browserConfig.enabled) return null;
    const proxyUrl = browserConfig.proxyUrl.trim();
    return {
      provider: browserConfig.provider,
      wsEndpoint: browserConfig.wsEndpoint || null,
      proxyUrl: proxyUrl || null,
      proxyType: proxyUrl || browserConfig.proxyType === "warp" ? browserConfig.proxyType : null,
      // WARP-only knob; blank means "use the RECAPTCHA_MAX_IP_ROTATIONS default".
      warpRotations:
        browserConfig.proxyType === "warp" && browserConfig.warpRotations.trim() !== ""
          ? Number(browserConfig.warpRotations)
          : null,
      headed: browserConfig.headed || null,
      stealth: browserConfig.stealth || null,
      blockAds: browserConfig.blockAds || null,
      ignoreHTTPS: browserConfig.ignoreHTTPS || null,
      sessionTimeoutMs: browserConfig.sessionTimeoutMs
        ? parseInt(browserConfig.sessionTimeoutMs, 10)
        : null,
      fingerprint: browserConfig.fpOs
        ? {
            os: browserConfig.fpOs,
            timezone: browserConfig.fpTimezone.trim(),
            locale: browserConfig.fpLocale.trim(),
            autoGeo: browserConfig.fpAutoGeo,
          }
        : null,
    };
  };

  const onSubmit = (values: FormValues) => {
    const toMinutes = (d: string, h: string, m: string) =>
      (parseInt(d || "0", 10) || 0) * 1440 +
      (parseInt(h || "0", 10) || 0) * 60 +
      (parseInt(m || "0", 10) || 0);

    const randomWindowMinutes = Math.max(1, toMinutes(rwDays, rwHours, rwMinutes));
    const afterCompletionMinutes = Math.max(1, toMinutes(acDays, acHours, acMinutes));
    const randomCountN = Math.max(1, parseInt(randomCount || "1", 10) || 1);

    const cronValue =
      scheduleType === "random"
        ? `@random:${randomWindowMinutes}:${randomCountN}`
        : scheduleType === "after_completion"
          ? `@after_completion:${afterCompletionMinutes}`
          : scheduleType === "cron"
            ? values.cronExpression || null
            : null;
    // Blank / 0 / junk all mean "no auto-retry" — send null so the column is cleared.
    const _n = (s?: string): number | null => {
      const v = parseInt((s ?? "").trim(), 10);
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const retryCountValue = _n(values.retryCount);
    // Interval only matters when retries are on; default 5m if left blank.
    const retryIntervalValue = retryCountValue ? (_n(values.retryIntervalMinutes) ?? 5) : null;
    const stepsPayload =
      values.steps.length > 0 ? (values.steps as ApiWorkflowStep[]) : null;
    const browserConfigPayload = buildBrowserConfigPayload();

    if (isEditMode && taskId) {
      updateTask.mutate(
        {
          id: taskId,
          data: {
            name: values.name,
            targetUrl: values.targetUrl,
            cronExpression: cronValue,
            retryCount: retryCountValue,
            retryIntervalMinutes: retryIntervalValue,
            steps: stepsPayload,
            browserConfig: browserConfigPayload,
          },
        },
        {
          onSuccess: () => {
            toast({
              title: t.taskUpdated,
              description: "The automation job has been updated.",
              variant: "success",
            });
            queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
            queryClient.invalidateQueries({
              queryKey: getGetTaskQueryKey(taskId),
            });
            setLocation(`/tasks/${taskId}`);
          },
          onError: (err) => {
            toast({
              title: t.failedToSave,
              description: err instanceof Error ? err.message : t.networkError,
              variant: "destructive",
            });
          },
        },
      );
    } else {
      createTask.mutate(
        {
          data: {
            name: values.name,
            targetUrl: values.targetUrl,
            cronExpression: cronValue,
            retryCount: retryCountValue,
            retryIntervalMinutes: retryIntervalValue,
            steps: stepsPayload,
            browserConfig: browserConfigPayload,
          },
        },
        {
          onSuccess: (newTask) => {
            toast({
              title: t.taskCreated,
              description: "The automation job has been configured.",
              variant: "success",
            });
            queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
            queryClient.invalidateQueries({
              queryKey: getGetTasksSummaryQueryKey(),
            });
            setLocation(`/tasks/${newTask.id}`);
          },
          onError: (err) => {
            toast({
              title: t.failedToSave,
              description: err instanceof Error ? err.message : "Unknown error",
              variant: "destructive",
            });
          },
        },
      );
    }
  };

  if (isEditMode && isLoadingTask) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full max-w-2xl" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center gap-4">
        <Link href={isEditMode ? `/tasks/${taskId}` : "/"}>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {isEditMode ? "Edit Configuration" : "New Mission"}
          </h1>
          <p className="text-sm text-muted-foreground font-mono">
            {isEditMode
              ? `Task ID: ${taskId}`
              : "Setup a new headless browser automation job"}
          </p>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* General Settings */}
          <Card className="border-border shadow-sm">
            <CardHeader className="border-b border-border pb-4 bg-muted/20">
              <CardTitle className="text-base font-semibold">
                General Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-6">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Task Name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. Daily Check-in"
                        {...field}
                        className="font-mono text-sm"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="targetUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Starting URL</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="https://example.com"
                          {...field}
                          className="font-mono text-sm"
                        />
                      </FormControl>
                      <FormDescription className="text-xs">
                        Used as the default login URL for Login steps
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {/* ── Schedule ─────────────────────────────────────────── */}
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium leading-none mb-2">
                      Schedule{" "}
                      <span className="text-muted-foreground font-normal">
                        (Optional)
                      </span>
                    </p>
                    <div className="flex gap-1 p-1 bg-muted rounded-md w-fit">
                      {(
                        ["none", "cron", "random", "after_completion"] as const
                      ).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setScheduleType(mode)}
                          className={`px-3 py-1 text-xs rounded font-medium transition-colors ${scheduleType === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                        >
                          {mode === "none"
                            ? t.noSchedule
                            : mode === "cron"
                              ? t.cronExpression
                              : mode === "random"
                                ? "Random interval"
                                : t.afterCompletion}
                        </button>
                      ))}
                    </div>
                  </div>

                  {scheduleType === "after_completion" && (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-muted-foreground">
                          Delay after run finishes
                        </p>
                        <div className="flex items-center gap-2">
                          <DurationField label="天" value={acDays} onChange={setAcDays} />
                          <DurationField label="小时" value={acHours} onChange={setAcHours} />
                          <DurationField label="分钟" value={acMinutes} onChange={setAcMinutes} />
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-snug">
                          Next run triggers automatically this long after the
                          previous run <strong>ends</strong> (天 / 小时 / 分钟 can be
                          combined freely). Perfect when the target site has a
                          cooldown timer that starts after each operation.
                        </p>
                      </div>
                    </div>
                  )}

                  {scheduleType === "cron" && (
                    <FormField
                      control={form.control}
                      name="cronExpression"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <Input
                              placeholder="0 0 * * *"
                              {...field}
                              className="font-mono text-sm"
                            />
                          </FormControl>
                          <FormDescription className="text-xs font-mono">
                            e.g. 0 0 * * * (Daily at midnight) · 0 * * * *
                            (Hourly)
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  {scheduleType === "random" && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5 col-span-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          时间窗口 (在此周期内随机执行)
                        </p>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">每</span>
                          <DurationField label="天" value={rwDays} onChange={setRwDays} />
                          <DurationField label="小时" value={rwHours} onChange={setRwHours} />
                          <DurationField label="分钟" value={rwMinutes} onChange={setRwMinutes} />
                        </div>
                      </div>
                      <div className="space-y-1.5 col-span-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          每个周期内执行次数
                        </p>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={randomCount}
                            onChange={(e) => setRandomCount(e.target.value)}
                            onBlur={(e) =>
                              setRandomCount(
                                String(
                                  Math.min(
                                    100,
                                    Math.max(1, parseInt(e.target.value, 10) || 1),
                                  ),
                                ),
                              )
                            }
                            className="w-20 h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring font-mono"
                          />
                          <span className="text-sm text-muted-foreground">次</span>
                        </div>
                      </div>
                      <p className="col-span-2 text-xs text-muted-foreground leading-relaxed">
                        每次运行后开始计算下一个窗口，在窗口内随机安排{" "}
                        <strong>{randomCount}</strong> 次运行。 例如：设为 3 天 1
                        次，上次运行完成后，下次运行将在 3 天内的某个随机时刻执行。
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Failure auto-retry — independent of the schedule above. */}
              <div className="space-y-2 pt-4 mt-4 border-t border-border">
                <FormLabel className="text-sm font-medium">失败自动重试</FormLabel>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-muted-foreground">失败后重试</span>
                  <FormField
                    control={form.control}
                    name="retryCount"
                    render={({ field }) => (
                      <FormItem className="space-y-0">
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            placeholder="0"
                            className="w-20 h-9 font-mono"
                            {...field}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <span className="text-sm text-muted-foreground">次，每次间隔</span>
                  <FormField
                    control={form.control}
                    name="retryIntervalMinutes"
                    render={({ field }) => (
                      <FormItem className="space-y-0">
                        <FormControl>
                          <Input
                            type="number"
                            min={1}
                            placeholder="5"
                            className="w-20 h-9 font-mono"
                            {...field}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <span className="text-sm text-muted-foreground">分钟</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  留空或 0 = 不重试（失败后等下一次定时触发）。重试次数按<strong>连续失败</strong>计算，
                  成功一次就清零；用完仍失败则回到正常调度。手动取消的运行不会重试。
                </p>
              </div>
            </CardContent>
          </Card>

          {/* ── Browser Backend ─────────────────────────────────────────── */}
          <Card className="border-border shadow-sm">
            <CardHeader
              className="border-b border-border pb-4 bg-muted/20 cursor-pointer select-none"
              onClick={() => setBrowserConfigExpanded((v) => !v)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-base font-semibold">
                    浏览器后端
                  </CardTitle>
                  {browserConfig.enabled ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                      自定义 · {PROVIDER_LABELS[browserConfig.provider]}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      使用全局设置
                    </span>
                  )}
                </div>
                {browserConfigExpanded ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <CardDescription className="text-xs mt-1">
                为此任务单独指定浏览器引擎、CDP 地址或代理，不影响其他任务
              </CardDescription>
            </CardHeader>

            {browserConfigExpanded && (
              <CardContent className="space-y-5 pt-5">
                {/* Enable toggle */}
                <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">启用自定义后端</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      关闭则使用系统设置中的全局浏览器配置
                    </p>
                  </div>
                  <Switch
                    checked={browserConfig.enabled}
                    onCheckedChange={(v) =>
                      setBrowserConfig((s) => ({ ...s, enabled: v }))
                    }
                  />
                </div>

                {browserConfig.enabled && (
                  <div className="space-y-4">
                    {/* Provider */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">浏览器引擎</label>
                      <Select
                        value={browserConfig.provider}
                        onValueChange={(v) =>
                          setBrowserConfig((s) => ({
                            ...s,
                            provider: v as BrowserProvider,
                          }))
                        }
                      >
                        <SelectTrigger className="font-mono text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="playwright">
                            Playwright（默认）
                          </SelectItem>
                          <SelectItem value="puppeteer">Puppeteer</SelectItem>
                          <SelectItem value="local">
                            Local Chrome（本地 Chrome）
                          </SelectItem>
                          <SelectItem value="seleniumbase">
                            SeleniumBase（CF 绕过）
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">
                        {browserConfig.provider === "seleniumbase" &&
                          "使用 SeleniumBase + undetected-chromedriver，擅长绕过 Cloudflare 5秒盾"}
                        {browserConfig.provider === "playwright" &&
                          "Playwright CDP 模式，可配置远程 WebSocket 端点连接外部浏览器"}
                        {browserConfig.provider === "puppeteer" &&
                          "Puppeteer，兼容性好，支持 CDP 端点"}
                        {browserConfig.provider === "local" &&
                          "直接启动本地安装的 Chrome/Chromium，无沙箱"}
                      </p>
                    </div>

                    {/* WS Endpoint */}
                    {(browserConfig.provider === "playwright" ||
                      browserConfig.provider === "puppeteer") && (
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">
                          CDP WebSocket 端点{" "}
                          <span className="text-muted-foreground font-normal">
                            (可选)
                          </span>
                        </label>
                        <Input
                          placeholder="ws://browserless:3000/chromium?token=..."
                          value={browserConfig.wsEndpoint}
                          onChange={(e) =>
                            setBrowserConfig((s) => ({
                              ...s,
                              wsEndpoint: e.target.value,
                            }))
                          }
                          className="font-mono text-sm"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          留空则自动启动本地浏览器进程；填写后连接远程
                          Browserless / cf-proxy
                        </p>
                      </div>
                    )}

                    {/* Proxy URL */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">
                        代理节点{" "}
                        <span className="text-muted-foreground font-normal">
                          (可选)
                        </span>
                      </label>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <Select
                          value={browserConfig.proxyType}
                          onValueChange={(v) =>
                            setBrowserConfig((s) => ({
                              ...s,
                              proxyType: v as ProxyType,
                            }))
                          }
                        >
                          <SelectTrigger className="font-mono text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="http">HTTP/HTTPS</SelectItem>
                            <SelectItem value="socks5">SOCKS5</SelectItem>
                            <SelectItem value="warp">
                              Cloudflare WARP
                            </SelectItem>
                            <SelectItem value="vless">VLESS</SelectItem>
                            <SelectItem value="vmess">VMess</SelectItem>
                            <SelectItem value="trojan">Trojan</SelectItem>
                            <SelectItem value="hy2">Hysteria2</SelectItem>
                            <SelectItem value="tuic">TUIC</SelectItem>
                            <SelectItem value="ss">Shadowsocks</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          placeholder={
                            browserConfig.proxyType === "http"
                              ? "http://user:pass@host:8080"
                              : browserConfig.proxyType === "socks5"
                                ? "socks5://user:pass@host:1080"
                                : browserConfig.proxyType === "warp"
                                  ? "留空使用 WARP_CONFIG_PATH"
                                  : browserConfig.proxyType === "vless"
                                    ? "vless://uuid@host:443?..."
                                    : browserConfig.proxyType === "vmess"
                                      ? "vmess://base64..."
                                      : browserConfig.proxyType === "trojan"
                                        ? "trojan://pass@host:443?..."
                                        : browserConfig.proxyType === "hy2"
                                          ? "hysteria2://pass@host:443?..."
                                          : browserConfig.proxyType === "tuic"
                                            ? "tuic://uuid:pass@host:443?..."
                                            : "ss://base64(method:pass)@host:port"
                          }
                          value={browserConfig.proxyUrl}
                          onChange={(e) =>
                            setBrowserConfig((s) => ({
                              ...s,
                              proxyUrl: e.target.value,
                            }))
                          }
                          className="font-mono text-sm sm:col-span-2"
                        />
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {browserConfig.proxyType === "http" ||
                        browserConfig.proxyType === "socks5"
                          ? "直接填写代理 URL，Chromium 原生支持。"
                          : browserConfig.proxyType === "warp"
                            ? "Cloudflare WARP：自动注册 WireGuard 身份（无需 wgcf；挂载 WARP_CONFIG_PATH 时优先使用它）。"
                            : "填写节点分享链接。系统会本地启动 sing-box 转成 SOCKS5 供浏览器使用（需安装 sing-box）。"}
                      </p>

                      {/* WARP-only: how many exit IPs to try when reCAPTCHA blocks audio */}
                      {browserConfig.proxyType === "warp" && (
                        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-1.5">
                          <label htmlFor="warpRotations" className="block text-sm font-medium">
                            换 IP 重试次数
                          </label>
                          <Input
                            id="warpRotations"
                            type="number"
                            min={0}
                            max={50}
                            placeholder="留空 = 用默认值（RECAPTCHA_MAX_IP_ROTATIONS，默认 5）"
                            value={browserConfig.warpRotations}
                            onChange={(e) =>
                              setBrowserConfig((s) => ({ ...s, warpRotations: e.target.value }))
                            }
                            className="font-mono text-sm"
                          />
                          <p className="text-[11px] text-muted-foreground">
                            reCAPTCHA 语音验证被拒（"automated queries"）时，注册新的 WARP 身份换一个出口 IP 再试，最多这么多次。
                            换 IP 时 sing-box 在同一本地端口重启，浏览器和页面状态不受影响；每次重试也会从新 IP 重新点一次
                            checkbox（有机会直接通过）。填 0 关闭。
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Headed / Headless */}
                    <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">
                          有头模式（可视化运行）
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          开启后浏览器带界面运行，方便排查问题；关闭则无头运行（默认）。仅对
                          Local Chrome 生效。
                        </p>
                      </div>
                      <Switch
                        checked={browserConfig.headed}
                        onCheckedChange={(v) =>
                          setBrowserConfig((s) => ({ ...s, headed: v }))
                        }
                      />
                    </div>

                    {/* 浏览器指纹伪装（仅 SeleniumBase / cf-proxy 生效）*/}
                    {browserConfig.provider === "seleniumbase" && (
                      <div className="space-y-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
                        <div>
                          <p className="text-sm font-medium">浏览器指纹伪装</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            把 Linux 指纹伪装成 Windows/Mac（UA、平台、WebGL、时区、语言）。
                            Windows 伪装度更高。半吊子伪装可能反而更难过 CF，开启后请实测对比。
                          </p>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">操作系统画像</label>
                          <Select
                            value={browserConfig.fpOs || "off"}
                            onValueChange={(v) =>
                              setBrowserConfig((s) => ({
                                ...s,
                                fpOs: v === "off" ? "" : (v as "windows" | "mac"),
                              }))
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="off">关闭（真实 Linux 指纹）</SelectItem>
                              <SelectItem value="windows">Windows（推荐）</SelectItem>
                              <SelectItem value="mac">Mac</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {browserConfig.fpOs && (
                          <>
                            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                              <div>
                                <p className="text-xs font-medium">按出口 IP 自动设时区/语言</p>
                                <p className="text-[10px] text-muted-foreground">
                                  开启后忽略下面手填的值，按代理出口 IP 自动对齐
                                </p>
                              </div>
                              <Switch
                                checked={browserConfig.fpAutoGeo}
                                onCheckedChange={(v) =>
                                  setBrowserConfig((s) => ({ ...s, fpAutoGeo: v }))
                                }
                              />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div className="space-y-1.5">
                                <label className="text-sm font-medium">时区</label>
                                <Input
                                  placeholder="America/New_York（留空=自动）"
                                  value={browserConfig.fpTimezone}
                                  onChange={(e) =>
                                    setBrowserConfig((s) => ({ ...s, fpTimezone: e.target.value }))
                                  }
                                />
                              </div>
                              <div className="space-y-1.5">
                                <label className="text-sm font-medium">语言</label>
                                <Input
                                  placeholder="en-US（留空=自动）"
                                  value={browserConfig.fpLocale}
                                  onChange={(e) =>
                                    setBrowserConfig((s) => ({ ...s, fpLocale: e.target.value }))
                                  }
                                />
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {/* Toggles */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                        <div>
                          <p className="text-xs font-medium">Stealth 模式</p>
                          <p className="text-[10px] text-muted-foreground">
                            反检测脚本注入
                          </p>
                        </div>
                        <Switch
                          checked={browserConfig.stealth}
                          onCheckedChange={(v) =>
                            setBrowserConfig((s) => ({ ...s, stealth: v }))
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                        <div>
                          <p className="text-xs font-medium">屏蔽广告</p>
                          <p className="text-[10px] text-muted-foreground">
                            过滤广告请求
                          </p>
                        </div>
                        <Switch
                          checked={browserConfig.blockAds}
                          onCheckedChange={(v) =>
                            setBrowserConfig((s) => ({ ...s, blockAds: v }))
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                        <div>
                          <p className="text-xs font-medium">忽略 HTTPS 错误</p>
                          <p className="text-[10px] text-muted-foreground">
                            跳过证书验证
                          </p>
                        </div>
                        <Switch
                          checked={browserConfig.ignoreHTTPS}
                          onCheckedChange={(v) =>
                            setBrowserConfig((s) => ({ ...s, ignoreHTTPS: v }))
                          }
                        />
                      </div>
                    </div>

                    {/* Session timeout */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">
                        会话超时{" "}
                        <span className="text-muted-foreground font-normal">
                          (可选)
                        </span>
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          placeholder="60000"
                          min={1000}
                          value={browserConfig.sessionTimeoutMs}
                          onChange={(e) =>
                            setBrowserConfig((s) => ({
                              ...s,
                              sessionTimeoutMs: e.target.value,
                            }))
                          }
                          className="font-mono text-sm w-40"
                        />
                        <span className="text-sm text-muted-foreground">
                          毫秒
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        单次任务最长执行时间，留空使用全局默认值
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            )}
          </Card>

          {/* Workflow Steps */}
          <Card className="border-border shadow-sm">
            <CardHeader className="border-b border-border pb-4 bg-muted/20">
              <CardTitle className="text-base font-semibold">
                Workflow Steps
              </CardTitle>
              <CardDescription className="text-xs">
                Chain actions: add a Login step to authenticate, then navigate,
                click, fill forms, and more.
                {steps.length > 0 && (
                  <span className="ml-2 font-mono text-primary">
                    {steps.length} step{steps.length !== 1 ? "s" : ""}
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-5 space-y-4">
              {importedCount !== null && (
                <div className="flex items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm">
                  <div className="flex items-center gap-2 text-primary">
                    <Crosshair className="h-4 w-4 flex-shrink-0" />
                    <span>
                      <span className="font-semibold">
                        {importedCount} step{importedCount !== 1 ? "s" : ""}
                      </span>{" "}
                      imported from Step Recorder — review and adjust before
                      saving.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setImportedCount(null)}
                    className="text-primary/60 hover:text-primary transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
              <StepEditor
                savedCredentials={savedCredentials}
                steps={steps as WorkflowStep[]}
                onChange={(newSteps) => form.setValue("steps", newSteps)}
                taskTargetUrl={targetUrl}
              />
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4 pt-4 border-t border-border">
            <Link href={isEditMode ? `/tasks/${taskId}` : "/"}>
              <Button variant="ghost" type="button">
                Cancel
              </Button>
            </Link>
            <Button
              type="submit"
              disabled={createTask.isPending || updateTask.isPending}
              className="font-semibold px-8 shadow-sm"
            >
              {isEditMode ? (
                <>
                  <Save className="mr-2 h-4 w-4" /> Save Changes
                </>
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" /> Create Task
                </>
              )}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
