import { useState, FormEvent } from "react";
import { ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/auth-context";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SetupPage() {
  const { completeSetup } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (password !== confirm) { setError("Passwords do not match"); return; }
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/setup`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      // Use .catch fallback so a non-JSON response (e.g. HTML error page from
      // an unexpected server error) never throws and blocks the success path.
      const data = await res.json().catch(() => ({}) as Record<string, unknown>) as { error?: string; authenticated?: boolean };

      if (!res.ok) {
        setError((data.error as string | undefined) ?? "Setup failed — please try again");
        return;
      }

      // Success — transition directly into the dashboard.
      completeSetup();
    } catch {
      setError("Could not reach the server — please check your connection and try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center space-y-2">
          <div className="flex justify-center">
            <div className="bg-primary/10 rounded-full p-3">
              <ShieldCheck className="h-6 w-6 text-primary" />
            </div>
          </div>
          <CardTitle className="text-xl">Welcome to AutoOps</CardTitle>
          <CardDescription>First-time setup — choose a password to protect your dashboard.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters" autoFocus disabled={loading} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat password" disabled={loading} required />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || !password || !confirm}>
              {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Setting up…</> : "Set password & continue"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
