import { useEffect, useRef, useState, useCallback } from "react";

  export interface StreamEntry {
    type: "progress" | "done" | "connected" | "screenshot";
    message: string;
    success?: boolean;
    screenshotPath?: string;
  }

  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 1500;

  export function useTaskLogStream(taskId: number, enabled: boolean) {
    const [entries, setEntries] = useState<StreamEntry[]>([]);
    const [isDone, setIsDone] = useState(false);
    const esRef = useRef<EventSource | null>(null);
    const retriesRef = useRef(0);
    const closedRef = useRef(false);
    const receivedEventsRef = useRef(0);

    const connect = useCallback(() => {
      if (closedRef.current) return;

      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
      const es = new EventSource(`${base}/api/tasks/${taskId}/logs/stream`, { withCredentials: true });
      esRef.current = es;

      es.onopen = () => {
        retriesRef.current = 0;
        setEntries((prev) => {
          const filtered = prev.filter((e) => e.type !== "connected");
          return [...filtered, { type: "connected", message: "Connected - waiting for output..." }];
        });
      };

      es.onmessage = (e: MessageEvent<string>) => {
        const data = JSON.parse(e.data) as StreamEntry;

        // Track non-done events to detect when buffer events were replayed
        if (data.type !== "done") receivedEventsRef.current++;

        // Only retry "not running" if no buffered events arrived (empty buffer)
        if (data.type === "done" && data.success === null && retriesRef.current < MAX_RETRIES && receivedEventsRef.current === 0) {
          es.close();
          esRef.current = null;
          retriesRef.current++;
          setTimeout(connect, RETRY_DELAY_MS);
          return;
        }

        setEntries((prev) => [...prev, data]);
        if (data.type === "done") {
          setIsDone(true);
          es.close();
          esRef.current = null;
        }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;

        if (retriesRef.current < MAX_RETRIES && !closedRef.current) {
          retriesRef.current++;
          setTimeout(connect, RETRY_DELAY_MS);
          return;
        }

        setEntries((prev) => [...prev, { type: "done", message: "Stream disconnected.", success: false }]);
        setIsDone(true);
      };
    }, [taskId]);

    useEffect(() => {
      if (!enabled || !taskId) {
        closedRef.current = true;
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }
        return;
      }

      setEntries([]);
      setIsDone(false);
      closedRef.current = false;
      retriesRef.current = 0;
      receivedEventsRef.current = 0;

      const timer = setTimeout(connect, 300);

      return () => {
        closedRef.current = true;
        clearTimeout(timer);
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }
      };
    }, [taskId, enabled, connect]);

    return { entries, isDone };
  }
  