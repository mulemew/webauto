import { createContext, useContext, useState, type ReactNode } from "react";

const STORAGE_KEY = "autoops:pollPaused";

function readFromStorage(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      return raw === "true";
    }
  } catch {
    // localStorage unavailable
  }
  return false;
}

function writeToStorage(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // ignore
  }
}

interface PollPausedContextValue {
  paused: boolean;
  toggle: () => void;
}

const PollPausedContext = createContext<PollPausedContextValue | null>(null);

export function PollPausedProvider({ children }: { children: ReactNode }) {
  const [paused, setPaused] = useState<boolean>(readFromStorage);
  const toggle = () =>
    setPaused((p) => {
      const next = !p;
      writeToStorage(next);
      return next;
    });
  return (
    <PollPausedContext.Provider value={{ paused, toggle }}>
      {children}
    </PollPausedContext.Provider>
  );
}

export function usePollPaused(): PollPausedContextValue {
  const ctx = useContext(PollPausedContext);
  if (!ctx) throw new Error("usePollPaused must be used within PollPausedProvider");
  return ctx;
}
