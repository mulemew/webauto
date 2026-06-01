import { createContext, useContext, useEffect, useState } from "react";

  type Theme = "light" | "dark" | "system";

  interface ThemeContextValue {
    theme: Theme;
    resolvedTheme: "light" | "dark";
    setTheme: (t: Theme) => void;
  }

  const ThemeContext = createContext<ThemeContextValue>({
    theme: "system",
    resolvedTheme: "light",
    setTheme: () => {},
  });

  export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [theme, setThemeState] = useState<Theme>(() => {
      const stored = localStorage.getItem("theme") as Theme | null;
      return stored ?? "system";
    });

    const getResolved = (t: Theme): "light" | "dark" =>
      t === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
        : t;

    const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => getResolved(theme));

    useEffect(() => {
      const apply = (t: Theme) => {
        const resolved = getResolved(t);
        setResolvedTheme(resolved);
        document.documentElement.classList.toggle("dark", resolved === "dark");
      };
      apply(theme);

      if (theme === "system") {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const handler = () => apply("system");
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener("change", handler);
      }
      return undefined;
    }, [theme]);

    const setTheme = (t: Theme) => {
      localStorage.setItem("theme", t);
      setThemeState(t);
    };

    return (
      <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
        {children}
      </ThemeContext.Provider>
    );
  }

  export function useTheme() {
    return useContext(ThemeContext);
  }
  