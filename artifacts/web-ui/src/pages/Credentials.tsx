import { useState, useEffect } from "react";
  import { KeyRound, Plus, Trash2, Pencil, Eye, EyeOff, ShieldCheck } from "lucide-react";
  import { Button } from "@/components/ui/button";
  import { Input } from "@/components/ui/input";
  import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
  import { useToast } from "@/hooks/use-toast";
  import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  } from "@/components/ui/dialog";
  import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  } from "@/components/ui/alert-dialog";
  import { Label } from "@/components/ui/label";

  interface SavedCredential {
    id: number;
    name: string;
    username: string;
    createdAt: string;
    updatedAt: string;
  }

  interface CredentialForm {
    name: string;
    username: string;
    password: string;
    totpSecret: string;
  }

  const EMPTY_FORM: CredentialForm = { name: "", username: "", password: "", totpSecret: "" };

  export default function Credentials() {
    const { toast } = useToast();
    const [credentials, setCredentials] = useState<SavedCredential[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [form, setForm] = useState<CredentialForm>(EMPTY_FORM);
    const [submitting, setSubmitting] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [showTotp, setShowTotp] = useState(false);
    const [deleteId, setDeleteId] = useState<number | null>(null);
      const [revealId, setRevealId] = useState<number | null>(null);
      const [revealData, setRevealData] = useState<{ password: string; totpSecret: string | null } | null>(null);
      const [revealing, setRevealing] = useState(false);

    const load = () => {
      setLoading(true);
      fetch("/api/saved-credentials")
        .then((r) => r.json())
        .then((data) => setCredentials(data))
        .catch(() => toast({ title: "Failed to load credentials", variant: "destructive" }))
        .finally(() => setLoading(false));
    };

    useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const openCreate = () => {
      setEditingId(null);
      setForm(EMPTY_FORM);
      setShowPassword(false);
      setShowTotp(false);
      setDialogOpen(true);
    };

    const openEdit = (c: SavedCredential) => {
      setEditingId(c.id);
      setForm({ name: c.name, username: c.username, password: "", totpSecret: "" });
      setShowPassword(false);
      setShowTotp(false);
      setDialogOpen(true);
    };

    const handleSubmit = async () => {
      if (!form.name.trim() || !form.username.trim()) {
        toast({ title: "Name and username are required", variant: "destructive" });
        return;
      }
      if (!editingId && !form.password) {
        toast({ title: "Password is required", variant: "destructive" });
        return;
      }
      setSubmitting(true);
      try {
        const url = editingId ? `/api/saved-credentials/${editingId}` : "/api/saved-credentials";
        const method = editingId ? "PUT" : "POST";
        const body: Record<string, string | null | undefined> = {
          name: form.name,
          username: form.username,
          // During edit, omit totpSecret if blank so server preserves existing value
          totpSecret: editingId && !form.totpSecret ? undefined : (form.totpSecret || null),
        };
        if (form.password) body.password = form.password;
        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await res.text());
        toast({ title: editingId ? "Credential updated" : "Credential saved", variant: "success" });
        setDialogOpen(false);
        load();
      } catch (err) {
        toast({ title: "Failed to save", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
      } finally {
        setSubmitting(false);
      }
    };

    const handleDelete = async () => {
      if (!deleteId) return;
      try {
        await fetch(`/api/saved-credentials/${deleteId}`, { method: "DELETE" });
        toast({ title: "Credential deleted", variant: "success" });
        setDeleteId(null);
        load();
      } catch {
        toast({ title: "Failed to delete", variant: "destructive" });
      }
    };

    const handleReveal = async (id: number) => {
        if (revealId === id) { setRevealId(null); setRevealData(null); return; }
        setRevealing(true);
        setRevealId(id);
        setRevealData(null);
        try {
          const r = await fetch(`/api/saved-credentials/${id}/reveal`);
          if (!r.ok) throw new Error("Failed");
          setRevealData(await r.json());
        } catch {
          toast({ title: "Failed to reveal", variant: "destructive" });
          setRevealId(null);
        } finally {
          setRevealing(false);
        }
      };

      return (
      <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Credentials Vault</h1>
            <p className="text-sm text-muted-foreground font-mono">
              Saved credentials are encrypted at rest with AES-256-GCM and reusable across tasks
            </p>
          </div>
          <Button size="sm" className="gap-2" onClick={openCreate}>
            <Plus className="h-4 w-4" /> Add Credential
          </Button>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-20 rounded-lg border border-border bg-muted/20 animate-pulse" />
            ))}
          </div>
        ) : credentials.length === 0 ? (
          <Card className="border-dashed border-border">
            <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <div className="rounded-full bg-muted/30 p-3">
                <KeyRound className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No saved credentials yet</p>
              <p className="text-xs text-muted-foreground">Add credentials here and select them in Login steps — no re-entering the same passwords.</p>
              <Button size="sm" variant="outline" onClick={openCreate} className="gap-2 mt-2">
                <Plus className="h-4 w-4" /> Add your first credential
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {credentials.map((c) => (
              <Card key={c.id} className="border-border shadow-sm">
                <CardHeader className="pb-2 bg-muted/20 border-b border-border flex-row items-center justify-between py-3 px-4">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-green-500" />
                    <CardTitle className="text-sm font-semibold">{c.name}</CardTitle>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(c)} title="Edit">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setDeleteId(c.id)} title="Delete">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="py-3 px-4">
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="font-mono">{c.username}</span>
                    <span className="text-border">·</span>
                    {revealId === c.id && revealData ? (
                        <span className="font-mono text-foreground select-all">{revealData.password}</span>
                      ) : (
                        <span>Password: ••••••••</span>
                      )}
                      <Button variant="ghost" size="sm" className="h-5 px-1.5 text-xs gap-1"
                        onClick={() => handleReveal(c.id)} disabled={revealing && revealId === c.id}>
                        {revealId === c.id ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        {revealId === c.id ? "Hide" : "Reveal"}
                      </Button>
                      <span className="ml-auto text-muted-foreground/50 font-mono">
                        Updated {new Date(c.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                    {revealId === c.id && revealData?.totpSecret && (
                      <div className="text-xs text-muted-foreground font-mono mt-1">
                        TOTP: <span className="text-foreground select-all">{revealData.totpSecret}</span>
                      </div>
                    )}
                  </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Create / Edit Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-md bg-background border-border">
            <DialogHeader>
              <DialogTitle>{editingId ? "Edit Credential" : "Add Credential"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Display Name</Label>
                <Input
                  className="font-mono text-sm"
                  placeholder="e.g. GitHub Bot"
                  autoComplete="off"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Username / Email</Label>
                <Input
                  className="font-mono text-sm"
                  placeholder="bot@company.com"
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  value={form.username}
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Password {editingId && <span className="text-muted-foreground font-normal">(leave blank to keep unchanged)</span>}
                </Label>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    className="font-mono text-sm pr-10"
                    placeholder="••••••••"
                    autoComplete="new-password"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  />
                  <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword((v) => !v)}>
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">TOTP Secret (2FA) <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <div className="relative">
                  <Input
                    type={showTotp ? "text" : "password"}
                    className="font-mono text-sm pr-10"
                    placeholder={editingId ? "Leave blank to keep existing 2FA" : "JBSWY3DPEHPK3PXP"}
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    value={form.totpSecret}
                    onChange={(e) => setForm((f) => ({ ...f, totpSecret: e.target.value }))}
                  />
                  <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowTotp((v) => !v)}>
                    {showTotp ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground font-mono">Used for GitHub / Google 2FA auto-fill</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting ? "Saving…" : editingId ? "Update" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirm */}
        <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
          <AlertDialogContent className="bg-background border-border">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this credential?</AlertDialogTitle>
              <AlertDialogDescription>
                Any Login steps that reference this credential will need to be reconfigured.
                This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }
  