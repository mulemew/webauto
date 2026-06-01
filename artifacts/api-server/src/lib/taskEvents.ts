import { EventEmitter } from "events";

  export interface TaskStreamEvent {
    type: "progress" | "done" | "screenshot";
    message: string;
    success?: boolean;
    screenshotPath?: string;
  }

  const emitters = new Map<number, EventEmitter>();
  const emitterCreatedAt = new Map<number, number>();

  // Replay buffer — stores recent events per task so SSE clients that connect
  // after a task has already fired steps (e.g. cron-triggered tasks) can catch up.
  const MAX_BUFFER_EVENTS = 200;
  const eventBuffers = new Map<number, TaskStreamEvent[]>();

  // Periodic sweep removes emitters/buffers not cleaned up by emitTaskDone (TTL 2 h).
  const EMITTER_TTL_MS = 2 * 60 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - EMITTER_TTL_MS;
    for (const [taskId, createdAt] of emitterCreatedAt) {
      if (createdAt < cutoff) {
        emitters.delete(taskId);
        emitterCreatedAt.delete(taskId);
        eventBuffers.delete(taskId);
      }
    }
  }, 30 * 60 * 1000).unref();

  export function getTaskEmitter(taskId: number): EventEmitter {
    let em = emitters.get(taskId);
    if (!em) {
      em = new EventEmitter();
      em.setMaxListeners(30);
      emitters.set(taskId, em);
      emitterCreatedAt.set(taskId, Date.now());
    }
    return em;
  }

  function pushToBuffer(taskId: number, event: TaskStreamEvent): void {
    let buf = eventBuffers.get(taskId);
    if (!buf) {
      buf = [];
      eventBuffers.set(taskId, buf);
    }
    buf.push(event);
    if (buf.length > MAX_BUFFER_EVENTS) buf.shift();
  }

  /** Returns a snapshot of buffered events for this task (for SSE replay on connect). */
  export function getTaskEventBuffer(taskId: number): TaskStreamEvent[] {
    return eventBuffers.get(taskId) ?? [];
  }

  /** Clear the replay buffer — call at the start of every new run to discard stale events. */
  export function clearTaskEventBuffer(taskId: number): void {
    eventBuffers.delete(taskId);
  }

  export function emitTaskProgress(taskId: number, message: string): void {
    const event: TaskStreamEvent = { type: "progress", message };
    pushToBuffer(taskId, event);
    getTaskEmitter(taskId).emit("event", event);
  }

  export function emitTaskDone(taskId: number, success: boolean, message: string): void {
    const event: TaskStreamEvent = { type: "done", success, message };
    pushToBuffer(taskId, event);
    getTaskEmitter(taskId).emit("event", event);
    // Clean up 60 s after done so any in-flight SSE clients can drain their buffers
    setTimeout(() => {
      emitters.delete(taskId);
      emitterCreatedAt.delete(taskId);
      eventBuffers.delete(taskId);
    }, 60_000);
  }
  