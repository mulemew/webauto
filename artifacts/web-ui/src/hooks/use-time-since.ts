import { useState, useEffect } from "react";

export function useTimeSince(timestamp: number | undefined): string | null {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!timestamp) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [timestamp]);

  if (!timestamp) return null;
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}
