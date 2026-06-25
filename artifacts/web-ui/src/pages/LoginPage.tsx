import { useState, FormEvent } from "react";
  import { Loader2, KeyRound } from "lucide-react";
  import { Button } from "@/components/ui/button";
  import { Input } from "@/components/ui/input";
  import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
  import { useLang } from "@/contexts/lang-context";

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  export default function LoginPage({ onLogin }: { onLogin: () => void }) {
    const { t } = useLang();
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: FormEvent) => {
      e.preventDefault();
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`${BASE}/api/auth/login`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (res.ok) {
          onLogin();
        } else {
          setError(t.invalidPassword);
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
              <KeyRound className="h-8 w-8 text-primary" />
            </div>
            <CardTitle>{t.controlPanel}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                type="password"
                placeholder={t.enterPassword}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {t.signIn}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }
  