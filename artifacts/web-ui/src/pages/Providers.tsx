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

type PType = "playwright" | "puppeteer" | "seleniumbase" | "camoufox";
interface Provider {
  id: number;
  name: string;
  type: PType;
  url: string;
  concurrency: number;
  enabled: boolean;
  healthy: boolean | null;
  lastError: string | null;
  lastCheckedAt: string | null;
}

const TYPE_LABEL: Record<PType, string> = {
  playwright: "Playwright (CDP)",
  puppeteer: "Puppeteer (CDP)",
  seleniumbase: "SeleniumBase (cf-proxy)",
  camoufox: "Camoufox",
};
const EMPTY = { name: "", type: "seleniumbase" as PType, url: "", concurrency: 1, enabled: true };
const isBrowserless = (t: PType) => t === "playwright" || t === "puppeteer";

export default function Providers() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Provider[]>([]);
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
    fetch(`${BASE}/api/providers`)
      .then((r) => r.json())
      .then((data) => setRows(data))
      .catch(() => toast({ title: "Failed to load", variant: "destructive" }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => { setEditingId(null); setForm(EMPTY); setDialogOpen(true); };
  const openEdit = (p: Provider) => { setEditingId(p.id); setForm({ name: p.name, type: p.type, url: p.url, concurrency: p.concurrency, enabled: p.enabled }); setDialogOpen(true); };

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.url.trim()) { toast({ title: "Name and URL are required", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const url = editingId ? `${BASE}/api/providers/${editingId}` : `${BASE}/api/providers`;
      // Type is fixed once created; edit only name/url/concurrency/enabled.
      const body = editingId
        ? { name: form.name.trim(), url: form.url.trim(), concurrency: form.concurrency, enabled: form.enabled }
        : { name: form.name.trim(), type: form.type, url: form.url.trim(), concurrency: form.concurrency, enabled: form.enabled };
      const res = await fetch(url, { method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || (await res.text()));
      toast({ title: editingId ? "Provider updated" : "Provider saved", variant: "success" });
      setDialogOpen(false);
      load();
    } catch (err) {
      toast({ title: "Failed to save", description: err instanceof Error ? err.message : "", variant: "destructive" });
    } finally { setSubmitting(false); }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await fetch(`${BASE}/api/providers/${deleteId}`, { method: "DELETE" });
      toast({ title: "Provider deleted", variant: "success" });
      setDeleteId(null);
      load();
    } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
  };

  const checkOne = async (id: number) => {
    setCheckingId(id);
    try {
      const res = await fetch(`${BASE}/api/providers/${id}/health`, { method: "POST" });
      if (!res.ok) throw new Error();
      const updated: Provider = await res.json();
      setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
    } catch { toast({ title: "Health check failed", variant: "destructive" }); }
    finally { setCheckingId(null); }
  };

  const checkAll = async () => {
    setCheckingAll(true);
    try {
      const res = await fetch(`${BASE}/api/providers/health-all`, { method: "POST" });
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
          <h1 className="text-lg font-semibold">Providers</h1>
        </div>
        <div className="flex items-center gap-2">
          {rows.length > 0 && (
            <Button size="sm" variant="outline" className="gap-2" onClick={checkAll} disabled={checkingAll}>
              <RefreshCw className={`h-4 w-4 ${checkingAll ? "animate-spin" : ""}`} />检测全部
            </Button>
          )}
          <Button size="sm" className="gap-2" onClick={openCreate}><Plus className="h-4 w-4" />Add provider</Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        具名浏览器后端。建好后在任务里下拉选择用哪个跑。每个 provider 有自己的并发上限(例:sb=2、playwright=3),各管各的。没选的任务用 Settings 默认后端。
      </p>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <Card className="border-dashed border-border">
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Server className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No providers yet — tasks use the Settings default backend.</p>
            <Button size="sm" variant="outline" onClick={openCreate} className="gap-2 mt-2"><Plus className="h-4 w-4" />Add provider</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <Card key={p.id} className="border-border shadow-sm">
              <CardHeader className="pb-2 bg-muted/20 border-b border-border flex-row items-center justify-between py-3 px-4">
                <div className="min-w-0 space-y-1">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                    <HealthDot h={p.healthy} />
                    {p.name}
                    <span className="text-[10px] font-mono uppercase text-muted-foreground border border-border rounded px-1 py-0.5">{p.type}</span>
                    <span className="text-[10px] text-primary">并发 {p.concurrency}</span>
                    {!p.enabled && <span className="text-[10px] text-muted-foreground">(disabled)</span>}
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
          <DialogHeader><DialogTitle>{editingId ? "Edit provider" : "Add provider"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. browserless #1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as PType })} disabled={!!editingId}>
                  <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="seleniumbase">SeleniumBase (cf-proxy)</SelectItem>
                    <SelectItem value="camoufox">Camoufox</SelectItem>
                    <SelectItem value="playwright">Playwright (CDP)</SelectItem>
                    <SelectItem value="puppeteer">Puppeteer (CDP)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>并发上限</Label>
                <Input type="number" min={1} max={64} value={form.concurrency}
                  onChange={(e) => setForm({ ...form, concurrency: Math.max(1, parseInt(e.target.value || "1", 10)) })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>URL</Label>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder={isBrowserless(form.type) ? "ws://browserless:3000?token=…" : form.type === "camoufox" ? "http://camoufox-proxy:7318" : "http://cf-proxy:7317"}
                className="font-mono" />
              <p className="text-xs text-muted-foreground">
                {isBrowserless(form.type) ? "CDP WebSocket 端点 (ws:// / wss://)" : "sidecar HTTP 地址 (http:// / https://),健康检查 GET /health"}
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
            <AlertDialogTitle>Delete provider?</AlertDialogTitle>
            <AlertDialogDescription>Tasks using it fall back to the Settings default backend.</AlertDialogDescription>
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
