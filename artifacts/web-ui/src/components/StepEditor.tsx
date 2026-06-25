import { useLang } from "@/contexts/lang-context";
import type { Translations } from "@/i18n/translations";
import { Plus, Trash2, ChevronUp, ChevronDown, MousePointer, Navigation, Keyboard, Clock, Eye, Camera, ExternalLink, ListFilter, ArrowDown, Hand, Command, LogIn, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export type StepType = "navigate" | "click" | "fill" | "select" | "scroll" | "hover" | "wait" | "waitFor" | "screenshot" | "switchToNewPage" | "keypress" | "login" | "condition";

export type ConditionType = "text_contains" | "text_not_contains" | "element_visible" | "element_not_visible" | "url_contains";
export type ThenActionType = "click" | "fill" | "navigate" | "wait" | "keypress" | "screenshot" | "scroll";

export interface ConditionalAction {
  type: ThenActionType;
  selector?: string;
  selectorType?: "text" | "css" | "xpath";
  url?: string;
  value?: string;
  ms?: number;
  key?: string;
  x?: number;
  y?: number;
}

export interface WorkflowStep {
  type: StepType;
  url?: string;
  selector?: string;
  selectorType?: "text" | "css" | "xpath";
  value?: string;
  ms?: number;
  timeout?: number;
  x?: number;
  y?: number;
  key?: string;
  loginMethod?: "form" | "github" | "google";
  loginUrl?: string;
  credentialId?: number;
  credentialSource?: "saved" | "inline";
  successSelector?: string;
  successText?: string;
  inlineUsername?: string;
  inlinePassword?: string;
  inlineTotp?: string;
  // Condition step fields
  conditionType?: ConditionType;
  conditionValue?: string;
  conditionSelector?: string;
  thenAction?: ConditionalAction;
}

export interface SavedCredentialOption {
  id: number;
  name: string;
  username: string;
}

interface StepEditorProps {
  steps: WorkflowStep[];
  onChange: (steps: WorkflowStep[]) => void;
  taskTargetUrl?: string;
  savedCredentials?: SavedCredentialOption[];
}

function getStepMeta(t: Translations): Record<StepType, { label: string; icon: React.ReactNode; description: string }> {
  return {
  login:           { label: t.stepLogin,             icon: <LogIn className="h-3.5 w-3.5" />,        description: t.stepLoginDesc },
  navigate:        { label: t.stepNavigate,          icon: <Navigation className="h-3.5 w-3.5" />,   description: t.stepNavigateDesc },
  click:           { label: t.stepClick,             icon: <MousePointer className="h-3.5 w-3.5" />, description: t.stepClickDesc },
  fill:            { label: t.stepFill,        icon: <Keyboard className="h-3.5 w-3.5" />,     description: t.stepFillDesc },
  select:          { label: t.stepSelectOpt,     icon: <ListFilter className="h-3.5 w-3.5" />,   description: t.stepSelectOptDesc },
  scroll:          { label: t.stepScroll,            icon: <ArrowDown className="h-3.5 w-3.5" />,    description: t.stepScrollDesc },
  hover:           { label: t.stepHover,             icon: <Hand className="h-3.5 w-3.5" />,          description: t.stepHoverDesc },
  wait:            { label: t.stepWait,              icon: <Clock className="h-3.5 w-3.5" />,         description: t.stepWaitDesc },
  waitFor:         { label: t.stepWaitFor,          icon: <Eye className="h-3.5 w-3.5" />,           description: t.stepWaitForDesc },
  screenshot:      { label: t.stepScreenshotType,        icon: <Camera className="h-3.5 w-3.5" />,        description: t.stepScreenshotTypeDesc },
  switchToNewPage: { label: t.stepSwitchTab, icon: <ExternalLink className="h-3.5 w-3.5" />,  description: t.stepSwitchTabDesc },
  keypress:        { label: t.stepKeyPress,         icon: <Command className="h-3.5 w-3.5" />,        description: t.stepKeyPressDesc },
  condition:       { label: t.stepCondition,         icon: <GitBranch className="h-3.5 w-3.5" />,     description: t.stepConditionDesc },
};
}

const PRESET_KEYS = [
  { label: "Enter", key: "Enter" },
  { label: "Tab", key: "Tab" },
  { label: "Escape", key: "Escape" },
  { label: "Space", key: "Space" },
  { label: "Backspace", key: "Backspace" },
  { label: "↑", key: "ArrowUp" },
  { label: "↓", key: "ArrowDown" },
  { label: "Ctrl+A", key: "Control+a" },
  { label: "Ctrl+C", key: "Control+c" },
  { label: "Ctrl+V", key: "Control+v" },
  { label: "Ctrl+Z", key: "Control+z" },
  { label: "F5", key: "F5" },
];

function defaultStep(type: StepType, taskTargetUrl = ""): WorkflowStep {
  switch (type) {
    case "login":           return { type, loginMethod: "form", loginUrl: taskTargetUrl };
    case "navigate":        return { type, url: "", timeout: 30000 };
    case "click":           return { type, selector: "", selectorType: "text" };
    case "fill":            return { type, selector: "", value: "" };
    case "select":          return { type, selector: "", value: "" };
    case "scroll":          return { type, selector: "", x: 0, y: 300 };
    case "hover":           return { type, selector: "", selectorType: "css" };
    case "wait":            return { type, ms: 1000 };
    case "waitFor":         return { type, selector: "", selectorType: "css", timeout: 10000 };
    case "screenshot":      return { type };
    case "switchToNewPage": return { type, timeout: 30000 };
    case "keypress":        return { type, key: "Enter" };
    case "condition":       return { type, conditionType: "text_contains", conditionValue: "", thenAction: { type: "click", selector: "", selectorType: "text" } };
  }
}

function StepCard({
  step,
  index,
  total,
  savedCredentials,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  savedCredentials: SavedCredentialOption[];
  onChange: (step: WorkflowStep) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { t } = useLang();
  const STEP_META = getStepMeta(t);
  const meta = STEP_META[step.type];
  const set = (patch: Partial<WorkflowStep>) => onChange({ ...step, ...patch });

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      {/* Card header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border">
        <span className="text-xs font-mono text-muted-foreground w-5 text-center shrink-0">{index + 1}</span>
        <Select
          value={step.type}
          onValueChange={(v) => onChange(defaultStep(v as StepType))}
        >
          <SelectTrigger className="h-7 text-xs border-0 bg-transparent shadow-none focus:ring-0 w-44 px-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(STEP_META) as StepType[]).map((stepType) => (
              <SelectItem key={stepType} value={stepType} className="text-xs">
                <span className="flex items-center gap-2">
                  {STEP_META[stepType].icon} {STEP_META[stepType].label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground/60 flex-1 hidden sm:block">{meta.description}</span>
        <div className="flex items-center gap-1 ml-auto shrink-0">
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={onMoveUp} disabled={index === 0} title={t.moveUp}>
            <ChevronUp className="h-3 w-3" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={onMoveDown} disabled={index === total - 1} title={t.moveDown}>
            <ChevronDown className="h-3 w-3" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={onDelete} title={t.removeStep}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Card body */}
      {step.type === "login" && (
          <div className="p-3 space-y-3">
            <div className="space-y-2">
              <Label className="text-xs">{t.loginMethod}</Label>
              <RadioGroup
                value={step.loginMethod ?? "form"}
                onValueChange={(v) => set({ loginMethod: v as "form" | "github" | "google" })}
                className="flex gap-4"
              >
                {(["form", "github", "google"] as const).map((m) => (
                  <div key={m} className="flex items-center gap-1.5">
                    <RadioGroupItem value={m} id={`login-method-${index}-${m}`} />
                    <Label htmlFor={`login-method-${index}-${m}`} className="text-xs cursor-pointer capitalize">{m === "form" ? t.standardForm : m === "github" ? "GitHub OAuth" : "Google OAuth"}</Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t.loginPageUrl}</Label>
              <Input
                className="font-mono text-xs h-8"
                placeholder="https://example.com/login"
                value={step.loginUrl ?? ""}
                onChange={(e) => set({ loginUrl: e.target.value })}
              />
            </div>
            {/* Credential selection */}
            <div className="space-y-2 pt-1 border-t border-border">
              <Label className="text-xs font-medium">{t.credentials}</Label>
              {savedCredentials.length > 0 ? (
                <div className="space-y-2">
                  <RadioGroup
                    value={step.credentialSource ?? "saved"}
                    onValueChange={(v) => set({ credentialSource: v as "saved" | "inline", credentialId: undefined, inlineUsername: undefined, inlinePassword: undefined, inlineTotp: undefined })}
                    className="flex gap-4"
                  >
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem value="saved" id={`cred-src-${index}-saved`} />
                      <Label htmlFor={`cred-src-${index}-saved`} className="text-xs cursor-pointer">{t.useSavedCredential}</Label>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem value="inline" id={`cred-src-${index}-inline`} />
                      <Label htmlFor={`cred-src-${index}-inline`} className="text-xs cursor-pointer">{t.enterInline}</Label>
                    </div>
                  </RadioGroup>
                  {(step.credentialSource ?? "saved") === "saved" ? (
                    <Select
                      value={step.credentialId ? String(step.credentialId) : ""}
                      onValueChange={(v) => set({ credentialId: parseInt(v, 10) })}
                    >
                      <SelectTrigger className="h-8 text-xs font-mono">
                        <SelectValue placeholder={t.selectCredential} />
                      </SelectTrigger>
                      <SelectContent>
                        {savedCredentials.map((c) => (
                          <SelectItem key={c.id} value={String(c.id)} className="text-xs">
                            <span className="font-medium">{c.name}</span>
                            <span className="text-muted-foreground ml-1">({c.username})</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="space-y-2">
                      <Input className="font-mono text-xs h-8" placeholder="Username / Email" autoComplete="off" data-lpignore="true" data-1p-ignore="true"
                        value={step.inlineUsername ?? ""} onChange={(e) => set({ inlineUsername: e.target.value })} />
                      <Input type="password" className="font-mono text-xs h-8" placeholder="Password" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true"
                        value={step.inlinePassword ?? ""} onChange={(e) => set({ inlinePassword: e.target.value })} />
                      <Input type="password" className="font-mono text-xs h-8" placeholder="TOTP secret (optional)" autoComplete="off" data-lpignore="true" data-1p-ignore="true"
                        value={step.inlineTotp ?? ""} onChange={(e) => set({ inlineTotp: e.target.value })} />
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{t.noSavedCredentials} <span className="font-medium text-foreground">{t.credentials}</span>.</p>
                  <Input className="font-mono text-xs h-8" placeholder="Username / Email" autoComplete="off" data-lpignore="true" data-1p-ignore="true"
                    value={step.inlineUsername ?? ""} onChange={(e) => set({ inlineUsername: e.target.value })} />
                  <Input type="password" className="font-mono text-xs h-8" placeholder="Password" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true"
                    value={step.inlinePassword ?? ""} onChange={(e) => set({ inlinePassword: e.target.value })} />
                  <Input type="password" className="font-mono text-xs h-8" placeholder="TOTP secret (optional)" autoComplete="off" data-lpignore="true" data-1p-ignore="true"
                    value={step.inlineTotp ?? ""} onChange={(e) => set({ inlineTotp: e.target.value })} />
                </div>
              )}
            </div>
            {/* Success selector */}
            <div className="space-y-1 pt-1 border-t border-border">
              <Label className="text-xs font-medium">{t.successSelector} <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input
                className="font-mono text-xs h-8"
                placeholder=".user-avatar, #logout-btn, [data-user]"
                value={step.successSelector ?? ""}
                onChange={(e) => set({ successSelector: e.target.value || undefined })}
              />
              <p className="text-[10px] text-muted-foreground leading-snug">
                CSS selector for an element visible only after login (e.g. avatar, logout button).
                If found after submit, login is confirmed successful regardless of URL changes.
              </p>
            </div>
            {/* Success text */}
            <div className="space-y-1 pt-1 border-t border-border">
              <Label className="text-xs font-medium">{t.successText} <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input
                className="font-mono text-xs h-8"
                placeholder="Welcome, Dashboard, 登录成功"
                value={step.successText ?? ""}
                onChange={(e) => set({ successText: e.target.value || undefined })}
              />
              <p className="text-[10px] text-muted-foreground leading-snug">
                登录完成后检测页面是否包含该文字，找到则登录成功，找不到则失败。
              </p>
            </div>
          </div>
        )}

      {step.type === "condition" && (
        <div className="p-3 space-y-3">
          <div className="space-y-2">
            <Label className="text-xs font-medium">{t.ifCondition}</Label>
            <Select
              value={step.conditionType ?? "text_contains"}
              onValueChange={(v) => set({ conditionType: v as ConditionType })}
            >
              <SelectTrigger className="h-8 text-xs font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text_contains" className="text-xs">{t.textContains}</SelectItem>
                <SelectItem value="text_not_contains" className="text-xs">{t.textNotContains}</SelectItem>
                <SelectItem value="element_visible" className="text-xs">{t.elementVisible}</SelectItem>
                <SelectItem value="element_not_visible" className="text-xs">{t.elementNotVisible}</SelectItem>
                <SelectItem value="url_contains" className="text-xs">{t.urlContains}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">
              {(step.conditionType === "element_visible" || step.conditionType === "element_not_visible")
                ? "CSS Selector"
                : "Match value"}
            </Label>
            <Input
              className="font-mono text-xs h-8"
              placeholder={
                (step.conditionType === "element_visible" || step.conditionType === "element_not_visible")
                  ? ".success-badge, #logged-in"
                  : step.conditionType === "url_contains"
                    ? "/dashboard"
                    : "Sign in successful"
              }
              value={step.conditionValue ?? ""}
              onChange={(e) => set({ conditionValue: e.target.value })}
            />
          </div>
          {(step.conditionType === "element_visible" || step.conditionType === "element_not_visible") && (
            <div className="space-y-1">
              <Label className="text-xs">Alternate selector (optional)</Label>
              <Input
                className="font-mono text-xs h-8"
                placeholder="Leave empty to use match value as selector"
                value={step.conditionSelector ?? ""}
                onChange={(e) => set({ conditionSelector: e.target.value })}
              />
            </div>
          )}
          <div className="border-t border-border pt-3 space-y-2">
            <Label className="text-xs font-medium">{t.thenExecute}</Label>
            <Select
              value={step.thenAction?.type ?? "click"}
              onValueChange={(v) => {
                const newAction: ConditionalAction = { type: v as ThenActionType };
                if (v === "click") { newAction.selector = ""; newAction.selectorType = "text"; }
                if (v === "fill") { newAction.selector = ""; newAction.value = ""; }
                if (v === "navigate") { newAction.url = ""; }
                if (v === "wait") { newAction.ms = 1000; }
                if (v === "keypress") { newAction.key = "Enter"; }
                if (v === "scroll") { newAction.x = 0; newAction.y = 300; }
                set({ thenAction: newAction });
              }}
            >
              <SelectTrigger className="h-8 text-xs font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="click" className="text-xs">{t.stepClick}</SelectItem>
                <SelectItem value="fill" className="text-xs">{t.stepFill}</SelectItem>
                <SelectItem value="navigate" className="text-xs">{t.stepNavigate}</SelectItem>
                <SelectItem value="wait" className="text-xs">{t.stepWait}</SelectItem>
                <SelectItem value="keypress" className="text-xs">{t.stepKeyPress}</SelectItem>
                <SelectItem value="screenshot" className="text-xs">{t.stepScreenshotType}</SelectItem>
                <SelectItem value="scroll" className="text-xs">{t.stepScroll}</SelectItem>
              </SelectContent>
            </Select>
            {step.thenAction?.type === "click" && (
              <div className="space-y-2">
                <RadioGroup
                  value={step.thenAction.selectorType ?? "text"}
                  onValueChange={(v) => set({ thenAction: { ...step.thenAction!, selectorType: v as "text" | "css" | "xpath" } })}
                  className="flex gap-4"
                >
                  {(["text", "css", "xpath"] as const).map((t) => (
                    <div key={t} className="flex items-center gap-1.5">
                      <RadioGroupItem value={t} id={`cond-click-sel-${index}-${t}`} />
                      <Label htmlFor={`cond-click-sel-${index}-${t}`} className="text-xs font-mono cursor-pointer">{t}</Label>
                    </div>
                  ))}
                </RadioGroup>
                <Input className="font-mono text-xs h-8" placeholder="Selector or text"
                  value={step.thenAction.selector ?? ""} onChange={(e) => set({ thenAction: { ...step.thenAction!, selector: e.target.value } })} />
              </div>
            )}
            {step.thenAction?.type === "fill" && (
              <div className="space-y-2">
                <Input className="font-mono text-xs h-8" placeholder="CSS Selector"
                  value={step.thenAction.selector ?? ""} onChange={(e) => set({ thenAction: { ...step.thenAction!, selector: e.target.value } })} />
                <Input className="font-mono text-xs h-8" placeholder="Value to type"
                  value={step.thenAction.value ?? ""} onChange={(e) => set({ thenAction: { ...step.thenAction!, value: e.target.value } })} />
              </div>
            )}
            {step.thenAction?.type === "navigate" && (
              <Input className="font-mono text-xs h-8" placeholder="https://example.com/next"
                value={step.thenAction.url ?? ""} onChange={(e) => set({ thenAction: { ...step.thenAction!, url: e.target.value } })} />
            )}
            {step.thenAction?.type === "wait" && (
              <Input type="number" className="font-mono text-xs h-8 w-36" placeholder="ms"
                value={step.thenAction.ms ?? 1000} onChange={(e) => set({ thenAction: { ...step.thenAction!, ms: parseInt(e.target.value, 10) || 0 } })} />
            )}
            {step.thenAction?.type === "keypress" && (
              <Input className="font-mono text-xs h-8" placeholder="Enter, Tab, Escape…"
                value={step.thenAction.key ?? ""} onChange={(e) => set({ thenAction: { ...step.thenAction!, key: e.target.value } })} />
            )}
            {step.thenAction?.type === "scroll" && (
              <div className="flex gap-3">
                <div className="space-y-1 flex-1">
                  <Label className="text-xs">X</Label>
                  <Input type="number" className="font-mono text-xs h-8" value={step.thenAction.x ?? 0}
                    onChange={(e) => set({ thenAction: { ...step.thenAction!, x: parseInt(e.target.value, 10) || 0 } })} />
                </div>
                <div className="space-y-1 flex-1">
                  <Label className="text-xs">Y</Label>
                  <Input type="number" className="font-mono text-xs h-8" value={step.thenAction.y ?? 300}
                    onChange={(e) => set({ thenAction: { ...step.thenAction!, y: parseInt(e.target.value, 10) || 0 } })} />
                </div>
              </div>
            )}
            {step.thenAction?.type === "screenshot" && (
              <p className="text-xs text-muted-foreground font-mono">Captures the page if condition is met.</p>
            )}
          </div>
        </div>
      )}

      {step.type !== "screenshot" && step.type !== "switchToNewPage" && step.type !== "login" && step.type !== "condition" && (
        <div className="p-3 space-y-3">
          {step.type === "navigate" && (
            <>
            <div className="space-y-1">
              <Label className="text-xs">URL</Label>
              <Input
                className="font-mono text-xs h-8"
                placeholder="https://example.com/dashboard"
                value={step.url ?? ""}
                onChange={(e) => set({ url: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">超时时间 (ms)</Label>
              <Input
                type="number"
                className="font-mono text-xs h-8"
                placeholder="30000"
                value={step.timeout ?? 30000}
                onChange={(e) => set({ timeout: Math.max(1000, parseInt(e.target.value, 10) || 30000) })}
              />
            </div>
            </>
          )}

          {step.type === "click" && (
            <>
              <div className="space-y-2">
                <Label className="text-xs">Selector Type</Label>
                <RadioGroup
                  value={step.selectorType ?? "text"}
                  onValueChange={(v) => set({ selectorType: v as "text" | "css" | "xpath" })}
                  className="flex gap-4"
                >
                  {(["text", "css", "xpath"] as const).map((t) => (
                    <div key={t} className="flex items-center gap-1.5">
                      <RadioGroupItem value={t} id={`sel-${index}-${t}`} />
                      <Label htmlFor={`sel-${index}-${t}`} className="text-xs font-mono cursor-pointer">{t}</Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  {step.selectorType === "text" ? "Button / link text or aria-label" :
                   step.selectorType === "css"  ? "CSS selector" : "XPath expression"}
                </Label>
                <Input
                  className="font-mono text-xs h-8"
                  placeholder={
                    step.selectorType === "text"  ? "Sign in" :
                    step.selectorType === "css"   ? "#submit-btn  or  .btn-checkin" :
                    "//button[@data-action='checkin']"
                  }
                  value={step.selector ?? ""}
                  onChange={(e) => set({ selector: e.target.value })}
                />
              </div>
            </>
          )}

          {step.type === "fill" && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">CSS Selector (input field)</Label>
                <Input className="font-mono text-xs h-8" placeholder="#search-input  or  input[name='query']"
                  value={step.selector ?? ""} onChange={(e) => set({ selector: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Value to type</Label>
                <Input className="font-mono text-xs h-8" placeholder="text to enter"
                  value={step.value ?? ""} onChange={(e) => set({ value: e.target.value })} />
              </div>
            </>
          )}

          {step.type === "select" && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">CSS Selector (select element)</Label>
                <Input className="font-mono text-xs h-8" placeholder="select#country  or  select[name='region']"
                  value={step.selector ?? ""} onChange={(e) => set({ selector: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Option value to select</Label>
                <Input className="font-mono text-xs h-8" placeholder="CN  or  option text"
                  value={step.value ?? ""} onChange={(e) => set({ value: e.target.value })} />
              </div>
            </>
          )}

          {step.type === "hover" && (
            <>
              <div className="space-y-2">
                <Label className="text-xs">Selector Type</Label>
                <RadioGroup value={step.selectorType ?? "css"} onValueChange={(v) => set({ selectorType: v as "css" | "xpath" })} className="flex gap-4">
                  {(["css", "xpath"] as const).map((t) => (
                    <div key={t} className="flex items-center gap-1.5">
                      <RadioGroupItem value={t} id={`hover-sel-${index}-${t}`} />
                      <Label htmlFor={`hover-sel-${index}-${t}`} className="text-xs font-mono cursor-pointer">{t}</Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{step.selectorType === "xpath" ? "XPath expression" : "CSS selector"}</Label>
                <Input className="font-mono text-xs h-8"
                  placeholder={step.selectorType === "xpath" ? "//nav//button[@aria-haspopup]" : ".nav-menu-trigger  or  #dropdown-btn"}
                  value={step.selector ?? ""} onChange={(e) => set({ selector: e.target.value })} />
              </div>
            </>
          )}

          {step.type === "scroll" && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">Scroll element into view (optional CSS selector)</Label>
                <Input className="font-mono text-xs h-8" placeholder="Leave empty to scroll by x/y offset"
                  value={step.selector ?? ""} onChange={(e) => set({ selector: e.target.value })} />
              </div>
              {!step.selector && (
                <div className="flex gap-3">
                  <div className="space-y-1 flex-1">
                    <Label className="text-xs">X offset (px)</Label>
                    <Input type="number" className="font-mono text-xs h-8" value={step.x ?? 0}
                      onChange={(e) => set({ x: parseInt(e.target.value, 10) || 0 })} />
                  </div>
                  <div className="space-y-1 flex-1">
                    <Label className="text-xs">Y offset (px)</Label>
                    <Input type="number" className="font-mono text-xs h-8" value={step.y ?? 300}
                      onChange={(e) => set({ y: parseInt(e.target.value, 10) || 0 })} />
                  </div>
                </div>
              )}
            </>
          )}

          {step.type === "wait" && (
            <div className="space-y-1">
              <Label className="text-xs">Duration (milliseconds)</Label>
              <Input type="number" className="font-mono text-xs h-8 w-36" min={100} max={3600000}
                value={step.ms ?? 1000} onChange={(e) => set({ ms: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
            </div>
          )}

          {step.type === "waitFor" && (
            <>
              <div className="space-y-2">
                <Label className="text-xs">Wait for</Label>
                <RadioGroup
                  value={step.selectorType === "text" ? "text" : "css"}
                  onValueChange={(v) => set({ selectorType: v as "css" | "text", selector: "" })}
                  className="flex gap-4"
                >
                  <div className="flex items-center gap-1.5">
                    <RadioGroupItem value="css" id={`waitfor-css-${index}`} />
                    <Label htmlFor={`waitfor-css-${index}`} className="text-xs cursor-pointer">CSS selector</Label>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <RadioGroupItem value="text" id={`waitfor-text-${index}`} />
                    <Label htmlFor={`waitfor-text-${index}`} className="text-xs cursor-pointer">Text on page</Label>
                  </div>
                </RadioGroup>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  {step.selectorType === "text" ? "Text to wait for" : "CSS selector"}
                </Label>
                <Input
                  className="font-mono text-xs h-8"
                  placeholder={step.selectorType === "text" ? "Login successful" : ".success-message  or  #result-table"}
                  value={step.selector ?? ""}
                  onChange={(e) => set({ selector: e.target.value })}
                />
                {step.selectorType === "text" && (
                  <p className="text-[10px] text-muted-foreground leading-snug">Waits until this text appears anywhere on the page.</p>
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Timeout (ms)</Label>
                <Input type="number" className="font-mono text-xs h-8 w-36" min={1000} max={3600000}
                  value={step.timeout ?? 10000} onChange={(e) => set({ timeout: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
              </div>
            </>
          )}

          {step.type === "keypress" && (
            <>
              <div className="space-y-2">
                <Label className="text-xs">Quick-pick</Label>
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_KEYS.map(({ label, key }) => (
                    <button key={key} type="button" onClick={() => set({ key })}
                      className={`px-2 py-1 rounded text-xs font-mono border transition-colors ${
                        step.key === key
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted hover:bg-accent border-border text-muted-foreground hover:text-foreground"
                      }`}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Key (custom)</Label>
                <Input className="font-mono text-xs h-8" placeholder="Enter, Tab, Escape, Control+c …"
                  value={step.key ?? ""} onChange={(e) => set({ key: e.target.value })} />
              </div>
            </>
          )}
        </div>
      )}

      {step.type === "screenshot" && (
        <div className="px-3 py-2 text-xs text-muted-foreground font-mono">Captures the current page state to a file.</div>
      )}

      {step.type === "switchToNewPage" && (
        <div className="p-3 space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Timeout (ms)</Label>
            <Input type="number" className="font-mono text-xs h-8 w-36" min={1000} max={3600000}
              value={step.timeout ?? 30000} onChange={(e) => set({ timeout: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
          </div>
          <p className="text-xs text-muted-foreground">
            Waits for a new browser tab to open and switches all subsequent steps to that tab.
          </p>
        </div>
      )}
    </div>
  );
}

export function StepEditor({ steps, onChange, taskTargetUrl = "", savedCredentials = [] }: StepEditorProps) {
  const { t } = useLang();
  const STEP_META = getStepMeta(t);
  const add = (type: StepType = "navigate") => onChange([...steps, defaultStep(type, taskTargetUrl)]);
  const update = (index: number, step: WorkflowStep) => { const next = [...steps]; next[index] = step; onChange(next); };
  const remove = (index: number) => onChange(steps.filter((_, i) => i !== index));
  const moveUp = (index: number) => { if (index === 0) return; const next = [...steps]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); };
  const moveDown = (index: number) => { if (index === steps.length - 1) return; const next = [...steps]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; onChange(next); };

  return (
    <div className="space-y-2">
      {steps.length === 0 ? (
        <div className="text-center py-6 text-xs text-muted-foreground border border-dashed border-border rounded-lg bg-muted/5">
          No steps yet — add a Login step first if authentication is needed, then chain your actions.
        </div>
      ) : (
        <div className="space-y-2">
          {steps.map((step, i) => (
            <StepCard key={i} step={step} index={i} total={steps.length}
              savedCredentials={savedCredentials}
              onChange={(s) => update(i, s)} onDelete={() => remove(i)}
              onMoveUp={() => moveUp(i)} onMoveDown={() => moveDown(i)} />
          ))}
        </div>
      )}
      <div className="flex gap-2 flex-wrap pt-1">
        {(Object.keys(STEP_META) as StepType[]).map((type) => (
          <Button key={type} type="button" variant="outline" size="sm" className="h-7 text-xs gap-1.5 font-normal" onClick={() => add(type)}>
            <Plus className="h-3 w-3" />
            {STEP_META[type].label}
          </Button>
        ))}
      </div>
    </div>
  );
}
