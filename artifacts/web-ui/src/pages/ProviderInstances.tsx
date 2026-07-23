import { useState, useEffect } from "react";
import { Server, Plus, Trash2, Pencil, Loader2, RefreshCw, CheckCircle2, XCircle, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Family = "browserless" | "sb" | "fox";
interface Instance {
  id: number;
  name: string;
  family: Family;
  subtype: string;
  url: string;
  enabled: boolean;
  healthy: boolean | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  busy?: number;
}

const FAMILY_LABEL: Record<Family, string> = { browserless: "Browserless (Playwright/Puppeteer)", sb: "SeleniumBase (cf-proxy)", fox: "Camoufox" };
const EMPTY = { name: "", family: "sb" as Family, subtype: "playwright", url: "", enabled: true };

export default function ProviderInstances() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  const load = () => {
    setLoading(true);
    fetch(`${BASE}/api/provider-instances`)
      .then((r) => r.json())
      .then((data) => setRows(data))
      .catch(() => toast({ title: "Failed to load", variant: "destructive" }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => { setEditingId(null); setForm(EMPTY); setDialogOpen(true); };
  const openEdit = (p: Instance) => { setEditingId(p.id); setForm({ name: p.name, family: p.family, subtype: p.subtype || "playwright", url: p.url, enabled: p.enabled }); setDialogOpen(true); };

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.url.trim()) { toast({ title: "Name and URL are required", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const url = editingId ? `${BASE}/api/provider-instances/${editingId}` : `${BASE}/api/provider-instances`;
      // On edit only name/url/enabled are mutable (family/subtype are fixed once created).
      const body = editingId
        ? { name: form.name.trim(), url: form.url.trim(), enabled: form.enabled }
        : { name: form.name.trim(), family: form.family, subtype: form.family === "browserless" ? form.subtype : "", url: form.url.trim(), enabled: form.enabled };
      const res = await fetch(url, { method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || (await res.text()));
      toast({ title: editingId ? "Instance updated" : "Instance saved", variant: "success" });
      setDialogOpen(false);
      load();
    } catch (err) {
      toast({ title: "Failed to save", description: err instanceof Error ? err.message : "", variant: "destructive" });
    } finally { setSubmitting(false); }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await fetch(`${BASE}/api/provider-instances/${deleteId}`, { method: "DELETE" });
      toast({ title: "Instance deleted", variant: "success" });
      setDeleteId(null);
      load();
    } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
  };

  const checkOne = async (id: number) => {
    setCheckingId(id);
    try {
      const res = await fetch(`${BASE}/api/provider-instances/${id}/health`, { method: "POST" });
      if (!res.ok) throw new Error();
      const updated: Instance = await res.json();
      setRows((prev) => prev.map((r) => (r.id === id ? { ...updated, busy: r.busy } : r)));
    } catch { toast({ title: "Health check failed", variant: "destructive" }); }
    finally { setCheckingId(null); }
  };

  const checkAll = async () => {
    setCheckingAll(true);
    try {
      const res = await fetch(`${BASE}/api/provider-instances/health-all`, { method: "POST" });
      if (!res.ok) throw new Error();
      setRows(await res.json());
      toast({ title: "Health refreshed", variant: "success" });
    } catch { toast({ title: "Health check failed", variant: "destructive" }); }
    finally { setCheckingAll(false); }
  };

  const maskUrl = (u: string) => u.replace(/(:\/\/[^:@/]+:)[^@/]+@/, "$1••••@");

  const HealthDot = ({ h }: { h: boolean | null }) =>
    h === true ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : h === false ? <XCircle className="h-4 w-4 text-destructive" /> : <HelpCircle className="h-4 w-4 text-muted-foreground" />;

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Provider Instances</h1>
        </div>
        <div className="flex items-center gap-2">
          {rows.length > 0 && (
            <Button size="sm" variant="outline" className="gap-2" onClick={checkAll} disabled={checkingAll}>
              <RefreshCw className={`h-4 w-4 ${checkingAll ? "animate-spin" : ""}`} />检测全部
            </Button>
          )}
          <Button size="sm" className="gap-2" onClick={openCreate}><Plus className="h-4 w-4" />Add instance</Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        为同一 provider 注册多个后端实例(各自独立容器),并发任务会自动分配到最空闲且健康的那个,实现真正并发。cf-proxy 靠这个避免多任务争抢同一个 Xvfb 鼠标。
      </p>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <Card className="border-dashed border-border">
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Server className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No instances yet — the env default backend is used.</p>
            <Button size="sm" variant="outline" onClick={openCreate} className="gap-2 mt-2"><Plus className="h-4 w-4" />Add instance</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <Card key={p.id} className="border-border shadow-sm">
              <CardHeader className="pb-2 bg-muted/20 border-b border-border flex-row items-center justify-between py-3 px-4">
                <div className="min-w-0 space-y-1">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <HealthDot h={p.healthy} />
                    {p.name}
                    <span className="text-[10px] font-mono uppercase text-muted-foreground border border-border rounded px-1 py-0.5">
                      {p.family}{p.subtype ? `·${p.subtype}` : ""}
                    </span>
                    {!p.enabled && <span className="text-[10px] text-muted-foreground">(disabled)</span>}
                    {p.busy ? <span className="text-[10px] text-primary">busy {p.busy}</span> : null}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground font-mono truncate">{maskUrl(p.url)}</p>
                  {p.healthy === false && p.lastError && <p className="text-[11px] text-destructive truncate">检测失败:{p.lastError}</p>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon" className="h-7 w-7" title="检测" onClick={() => checkOne(p.id)} disabled={checkingId === p.id || checkingAll}>
                    <RefreshCw className={`h-4 w-4 ${checkingId === p.id ? "animate-spin" : ""}`} />
                  </Button>
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
          <DialogHeader><DialogTitle>{editingId ? "Edit instance" : "Add instance"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. cf-proxy #2" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Family</Label>
                <Select value={form.family} onValueChange={(v) => setForm({ ...form, family: v as Family })} disabled={!!editingId}>
                  <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sb">SeleniumBase (cf-proxy)</SelectItem>
                    <SelectItem value="fox">Camoufox</SelectItem>
                    <SelectItem value="browserless">Browserless</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.family === "browserless" && (
                <div className="space-y-1.5">
                  <Label>Subtype</Label>
                  <Select value={form.subtype} onValueChange={(v) => setForm({ ...form, subtype: v })} disabled={!!editingId}>
                    <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="playwright">Playwright</SelectItem>
                      <SelectItem value="puppeteer">Puppeteer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>URL</Label>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder={form.family === "browserless" ? "ws://browserless-2:3000?token=…" : form.family === "fox" ? "http://camoufox-proxy-2:7318" : "http://cf-proxy-2:7317"}
                className="font-mono" />
              <p className="text-xs text-muted-foreground">
                {form.family === "browserless" ? "CDP WebSocket 端点 (ws:// / wss://)" : "sidecar HTTP 地址 (http:// / https://),健康检查会 GET /health"}
              </p>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <Label className="text-sm">Enabled</Label>
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
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
            <AlertDialogTitle>Delete instance?</AlertDialogTitle>
            <AlertDialogDescription>Tasks of this family will fall back to other instances or the env default.</AlertDialogDescription>
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
