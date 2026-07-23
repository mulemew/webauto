import { useState, useEffect } from "react";
import { Fingerprint, Plus, Trash2, Pencil, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface FingerprintProfile {
  id: number;
  name: string;
  os: string;
  config: { locale?: string; timezone?: string; screen?: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface Form {
  name: string;
  os: string;
  locale: string;
  timezone: string;
  screen: string;
}

const EMPTY: Form = { name: "", os: "windows", locale: "", timezone: "", screen: "" };
const OS_OPTIONS = [
  { value: "windows", label: "Windows" },
  { value: "mac", label: "macOS" },
  { value: "linux", label: "Linux" },
];

export default function FingerprintProfiles() {
  const { toast } = useToast();
  const [rows, setRows] = useState<FingerprintProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [source, setSource] = useState<"browserforge" | "preset">("browserforge");
  const [generating, setGenerating] = useState(false);
  // The generated fingerprint config (opaque: {source, os, fp|preset, summary}) that gets
  // saved verbatim into the profile, plus its human-readable summary for display.
  const [generated, setGenerated] = useState<Record<string, unknown> | null>(null);
  const [genSummary, setGenSummary] = useState<Record<string, unknown> | null>(null);

  const load = () => {
    setLoading(true);
    fetch(`${BASE}/api/fingerprint-profiles`)
      .then((r) => r.json())
      .then((data) => setRows(data))
      .catch(() => toast({ title: "Failed to load", variant: "destructive" }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => {
    setEditingId(null); setForm(EMPTY); setGenerated(null); setGenSummary(null); setSource("browserforge"); setDialogOpen(true);
  };
  const openEdit = (p: FingerprintProfile) => {
    setEditingId(p.id);
    const cfg = (p.config ?? {}) as Record<string, unknown>;
    setForm({ name: p.name, os: p.os, locale: (cfg.locale as string) ?? "", timezone: (cfg.timezone as string) ?? "", screen: (cfg.screen as string) ?? "" });
    // A saved generated fingerprint carries fp/preset/summary — keep it fixed on edit.
    if (cfg.fp || cfg.preset) { setGenerated(cfg); setGenSummary((cfg.summary as Record<string, unknown>) ?? null); }
    else { setGenerated(null); setGenSummary(null); }
    setSource(((cfg.source as string) === "preset") ? "preset" : "browserforge");
    setDialogOpen(true);
  };

  const doGenerate = async () => {
    setGenerating(true);
    try {
      const r = await fetch(`${BASE}/api/fingerprint-profiles/generate?os=${encodeURIComponent(form.os)}&source=${source}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "generate failed");
      setGenerated(data.config);
      setGenSummary(data.summary);
      toast({ title: "指纹已生成 — 保存后固定", variant: "success" });
    } catch (err) {
      toast({ title: "生成失败", description: err instanceof Error ? err.message : "", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      // If a fingerprint was generated, save it VERBATIM (fp/preset/summary) so it stays
      // fixed; otherwise fall back to the manual timezone/locale/screen fields.
      const config: Record<string, unknown> = generated ? { ...generated } : {};
      if (form.locale.trim()) config.locale = form.locale.trim();
      if (form.timezone.trim()) config.timezone = form.timezone.trim();
      if (!generated && form.screen.trim()) config.screen = form.screen.trim();
      const url = editingId ? `${BASE}/api/fingerprint-profiles/${editingId}` : `${BASE}/api/fingerprint-profiles`;
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name.trim(), os: form.os, config: Object.keys(config).length ? config : null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || (await res.text()));
      toast({ title: editingId ? "Fingerprint updated" : "Fingerprint saved", variant: "success" });
      setDialogOpen(false);
      load();
    } catch (err) {
      toast({ title: "Failed to save", description: err instanceof Error ? err.message : "", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`${BASE}/api/fingerprint-profiles/${deleteId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({} as { affectedTasks?: number }));
      toast({ title: "Fingerprint deleted", description: data.affectedTasks ? `${data.affectedTasks} 个任务已回落到默认指纹` : undefined, variant: "success" });
      setDeleteId(null);
      load();
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Fingerprint className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Browser Fingerprints</h1>
        </div>
        <Button size="sm" className="gap-2" onClick={openCreate}><Plus className="h-4 w-4" />Add fingerprint</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Reusable device fingerprints. Assign one to a task so it always looks like the SAME device (a real user has one stable device). Pick one per task from a dropdown.
      </p>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <Card className="border-dashed border-border">
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Fingerprint className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No fingerprints yet.</p>
            <Button size="sm" variant="outline" onClick={openCreate} className="gap-2 mt-2"><Plus className="h-4 w-4" />Add fingerprint</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <Card key={p.id} className="border-border shadow-sm">
              <CardHeader className="pb-2 bg-muted/20 border-b border-border flex-row items-center justify-between py-3 px-4">
                <div className="min-w-0">
                  <CardTitle className="text-sm font-semibold">{p.name}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {OS_OPTIONS.find((o) => o.value === p.os)?.label ?? p.os}
                    {p.config?.timezone ? ` · ${p.config.timezone}` : ""}
                    {p.config?.locale ? ` · ${p.config.locale}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(p)}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => setDeleteId(p.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingId ? "Edit fingerprint" : "Add fingerprint"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Windows – Chrome desktop" />
            </div>
            <div className="space-y-1.5">
              <Label>Operating system</Label>
              <select
                value={form.os}
                onChange={(e) => setForm({ ...form, os: e.target.value })}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {OS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>

            {/* Generate a real, consistent fingerprint and FIX it (Camoufox) */}
            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center gap-2">
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value as "browserforge" | "preset")}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="browserforge">browserforge 合成</option>
                  <option value="preset">真机预设</option>
                </select>
                <Button type="button" variant="outline" size="sm" onClick={doGenerate} disabled={generating} className="gap-2">
                  {generating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}生成指纹
                </Button>
                {generated && <span className="text-[11px] text-emerald-500">已生成 · 保存后固定</span>}
              </div>
              {genSummary ? (
                <div className="text-[11px] font-mono text-muted-foreground space-y-0.5 break-all">
                  {genSummary.userAgent ? <div>UA: {String(genSummary.userAgent)}</div> : null}
                  {genSummary.webglRenderer ? <div>GPU: {String(genSummary.webglVendor || "")} — {String(genSummary.webglRenderer)}</div> : null}
                  {genSummary.screen ? <div>屏幕: {String(genSummary.screen)}</div> : null}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">点「生成指纹」产出一套真实一致的指纹(Camoufox 引擎级),保存后固定。不生成则用下方手填(仅 cf-proxy 简单伪装)。</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Timezone <span className="text-muted-foreground">(optional)</span></Label>
                <Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="auto (from proxy IP)" />
              </div>
              <div className="space-y-1.5">
                <Label>Locale <span className="text-muted-foreground">(optional)</span></Label>
                <Input value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })} placeholder="auto" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Screen <span className="text-muted-foreground">(optional)</span></Label>
              <Input value={form.screen} onChange={(e) => setForm({ ...form, screen: e.target.value })} placeholder="1920x1080" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting} className="gap-2">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}{editingId ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete fingerprint?</AlertDialogTitle>
            <AlertDialogDescription>Tasks using it will fall back to the default fingerprint.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
