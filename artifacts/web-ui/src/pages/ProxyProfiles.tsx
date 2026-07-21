import { useState, useEffect } from "react";
import { Network, Plus, Trash2, Pencil, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ProxyProfile {
  id: number;
  name: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

const EMPTY = { name: "", url: "" };

export default function ProxyProfiles() {
  const { toast } = useToast();
  const [rows, setRows] = useState<ProxyProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    fetch(`${BASE}/api/proxy-profiles`)
      .then((r) => r.json())
      .then((data) => setRows(data))
      .catch(() => toast({ title: "Failed to load", variant: "destructive" }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => { setEditingId(null); setForm(EMPTY); setDialogOpen(true); };
  const openEdit = (p: ProxyProfile) => { setEditingId(p.id); setForm({ name: p.name, url: p.url }); setDialogOpen(true); };

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.url.trim()) {
      toast({ title: "Name and proxy URL are required", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const url = editingId ? `${BASE}/api/proxy-profiles/${editingId}` : `${BASE}/api/proxy-profiles`;
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name.trim(), url: form.url.trim() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || (await res.text()));
      toast({ title: editingId ? "Proxy updated" : "Proxy saved", variant: "success" });
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
      await fetch(`${BASE}/api/proxy-profiles/${deleteId}`, { method: "DELETE" });
      toast({ title: "Proxy deleted", variant: "success" });
      setDeleteId(null);
      load();
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  };

  // Hide the password portion of a proxy URL when displaying it.
  const maskUrl = (u: string) => u.replace(/(:\/\/[^:@/]+:)[^@/]+@/, "$1••••@");

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Proxies</h1>
        </div>
        <Button size="sm" className="gap-2" onClick={openCreate}><Plus className="h-4 w-4" />Add proxy</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Reusable exit proxies. Add them once, then pick one per task from a dropdown. WARP is configured per task, not here.
      </p>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <Card className="border-dashed border-border">
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Network className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No proxies yet.</p>
            <Button size="sm" variant="outline" onClick={openCreate} className="gap-2 mt-2"><Plus className="h-4 w-4" />Add proxy</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <Card key={p.id} className="border-border shadow-sm">
              <CardHeader className="pb-2 bg-muted/20 border-b border-border flex-row items-center justify-between py-3 px-4">
                <div className="min-w-0">
                  <CardTitle className="text-sm font-semibold">{p.name}</CardTitle>
                  <p className="text-xs text-muted-foreground font-mono truncate">{maskUrl(p.url)}</p>
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
          <DialogHeader><DialogTitle>{editingId ? "Edit proxy" : "Add proxy"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. US residential #1" />
            </div>
            <div className="space-y-1.5">
              <Label>Proxy URL</Label>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="socks5://user:pass@host:port" className="font-mono" />
              <p className="text-xs text-muted-foreground">Scheme required: http/https/socks5/vless/vmess/trojan/…</p>
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
            <AlertDialogTitle>Delete proxy?</AlertDialogTitle>
            <AlertDialogDescription>Tasks using it will fall back to no proxy.</AlertDialogDescription>
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
