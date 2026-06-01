import { useState } from "react";

const STORAGE_KEY = "autoops:pollingInterval";
const DEFAULT_MS = 2000;
const VALID_OPTIONS = [1000, 2000, 5000] as const;

export type PollingIntervalMs = (typeof VALID_OPTIONS)[number];

function readFromStorage(): PollingIntervalMs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = parseInt(raw, 10);
      if ((VALID_OPTIONS as readonly number[]).includes(parsed)) {
        return parsed as PollingIntervalMs;
      }
    }
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_MS;
}

function writeToStorage(ms: PollingIntervalMs): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(ms));
  } catch {
    // ignore
  }
}

export function usePollingInterval(): [PollingIntervalMs, (ms: PollingIntervalMs) => void] {
  const [interval, setIntervalState] = useState<PollingIntervalMs>(readFromStorage);

  const setInterval = (ms: PollingIntervalMs) => {
    writeToStorage(ms);
    setIntervalState(ms);
  };

  return [interval, setInterval];
}

export { VALID_OPTIONS as POLLING_OPTIONS };
