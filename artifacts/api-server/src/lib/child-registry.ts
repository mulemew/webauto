import type { ChildProcess } from "child_process";
import { logger } from "./logger";

/**
 * Registry of every long-lived helper process we spawn (sing-box tunnels, Xvfb
 * displays).
 *
 * Node does not kill spawned children when the parent dies, so a crash, a container
 * restart, or a `docker compose up -d` left them orphaned — they accumulated every
 * run until the host had a pile of stray sing-box/Xvfb processes. Tracking them here
 * lets installSignalHandlers() reap the lot on the way out, and gives us a count for
 * diagnostics.
 *
 * Short-lived one-shots (curl via execFile) are NOT registered: they carry their own
 * timeout and exit on their own.
 */
const children = new Set<ChildProcess>();

/** Register a spawned helper. It is removed automatically once it exits. */
export function trackChild(child: ChildProcess, label: string): void {
  children.add(child);
  child.once("exit", () => children.delete(child));
  logger.debug({ label, pid: child.pid, live: children.size }, "helper process tracked");
}

/** Number of helper processes currently believed to be alive. */
export function liveChildCount(): number {
  return children.size;
}

/** Kill every tracked helper. Safe to call repeatedly. */
export function killAllChildren(signal: NodeJS.Signals = "SIGKILL"): number {
  const n = children.size;
  for (const c of children) {
    try {
      c.kill(signal);
    } catch {
      /* already gone */
    }
  }
  children.clear();
  return n;
}

let installed = false;

/**
 * Reap helper processes on the way out. Without this, every restart leaked the
 * sing-box/Xvfb children of whatever was running at the time.
 *
 * SIGTERM/SIGINT run the cleanup and exit. uncaughtException/unhandledRejection are
 * logged and cleaned up too — the process is unreliable after those, so we let it die
 * rather than limp on with half-torn-down state.
 */
export function installSignalHandlers(onShutdown?: () => Promise<void> | void): void {
  if (installed) return;
  installed = true;

  let shuttingDown = false;
  const shutdown = async (reason: string, code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const killed = killAllChildren();
    logger.info({ reason, killedHelpers: killed }, "Shutting down — helper processes reaped");
    try {
      await onShutdown?.();
    } catch (err) {
      logger.warn({ err }, "shutdown hook failed");
    }
    process.exit(code);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception — reaping helpers and exiting");
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (err) => {
    logger.error({ err }, "Unhandled rejection — reaping helpers and exiting");
    void shutdown("unhandledRejection", 1);
  });
}
