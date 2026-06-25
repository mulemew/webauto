import { useState, FormEvent } from "react";
import { useLocation } from "wouter";
  import { Loader2, ShieldCheck } from "lucide-react";
  import { Button } from "@/components/ui/button";
  import { Input } from "@/components/ui/input";
  import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
  import { useLang } from "@/contexts/lang-context";

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  export default function SetupPage() {
    const { t } = useLang();
    const [, navigate] = useLocation();
    const [password, setPassword] = useState("");
    const [repeat, setRepeat] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: FormEvent) => {
      e.preventDefault();
      if (password !== repeat) {
        setError(t.passwordMismatch);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`${BASE}/api/auth/setup`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (res.ok) {
          navigate("/");
        } else {
          const data = await res.json().catch(() => ({})) as { error?: string };
          setError(data.error || t.saveFailed);
        }
      } catch {
        setError(t.networkError);
      } finally {
        setLoading(false);
      }
    };

    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-full max-w-sm mx-4">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <ShieldCheck className="h-8 w-8 text-primary" />
            </div>
            <CardTitle>{t.setupTitle}</CardTitle>
            <CardDescription>{t.setupDesc}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                type="password"
                placeholder={t.newPassword}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              <Input
                type="password"
                placeholder={t.repeatPasswordPlaceholder}
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />{t.settingUp}</> : t.setPassword}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }
  