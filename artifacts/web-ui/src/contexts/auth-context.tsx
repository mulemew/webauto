import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";

export type AuthContextValue = {
  authenticated: boolean | null;
  needsSetup: boolean;
  loading: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  completeSetup: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, options?: RequestInit) {
  return fetch(`${BASE}${path}`, { credentials: "same-origin", ...options });
}

async function safeJson<T>(res: Response, fallback: T): Promise<T> {
  try {
    return await res.json() as T;
  } catch {
    return fallback;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiFetch("/api/auth/me");
      const data = await safeJson(res, { authenticated: false });
      setAuthenticated(data.authenticated);
      if (!data.authenticated) {
        try {
          const setupRes = await apiFetch("/api/auth/setup-status");
          const setupData = await safeJson(setupRes, { needsSetup: false });
          setNeedsSetup(setupData.needsSetup);
        } catch {
          setNeedsSetup(false);
        }
      } else {
        setNeedsSetup(false);
      }
    } catch {
      setAuthenticated(false);
      // Even if the auth check failed (e.g. server just started), try
      // to check whether first-run setup is needed so the user sees the
      // setup page instead of the login page.
      try {
        const setupRes = await apiFetch("/api/auth/setup-status");
        const setupData = await safeJson(setupRes, { needsSetup: false });
        setNeedsSetup(setupData.needsSetup);
      } catch {
        setNeedsSetup(false);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (password: string) => {
    const res = await apiFetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const data = await safeJson(res, { error: "Login failed" });
      throw new Error(data.error ?? "Login failed");
    }
    setAuthenticated(true);
    setNeedsSetup(false);
  }, []);

  const logout = useCallback(async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    setAuthenticated(false);
  }, []);

  const completeSetup = useCallback(() => {
    setNeedsSetup(false);
    setAuthenticated(true);
  }, []);

  return (
    <AuthContext.Provider value={{ authenticated, needsSetup, loading, login, logout, refresh, completeSetup }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
