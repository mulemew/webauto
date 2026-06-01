import { createContext, useContext, useState } from "react";
  import { zh, en, type Translations } from "@/i18n/translations";

  type Lang = "zh" | "en";

  interface LangContextValue {
    lang: Lang;
    setLang: (l: Lang) => void;
    t: Translations;
  }

  const LangContext = createContext<LangContextValue>({ lang: "zh", setLang: () => {}, t: zh });

  export function LangProvider({ children }: { children: React.ReactNode }) {
    const [lang, setLangState] = useState<Lang>(() => {
      return (localStorage.getItem("lang") as Lang | null) ?? "zh";
    });

    const setLang = (l: Lang) => {
      localStorage.setItem("lang", l);
      setLangState(l);
    };

    const t = lang === "zh" ? zh : en;
    return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>;
  }

  export function useLang() {
    return useContext(LangContext);
  }
  