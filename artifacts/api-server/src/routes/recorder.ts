/**
 * Step Recorder — interactive browser session that captures user actions as workflow steps.
 *
 * Sessions are ephemeral (in-memory) and expire after 10 minutes of inactivity.
 * Browser viewport is always 1280×800 so the frontend can scale screenshot click coords.
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import { createBrowserProvider } from "../automation/browser-provider";
import { loadBrowserConfig } from "../lib/appSettings";
import type { PageAdapter } from "../automation/page-adapter";
import type { WorkflowStep } from "../automation/step-executor";
import { logger } from "../lib/logger";

// ── Session store ─────────────────────────────────────────────────────────────

interface RecorderSession {
  id: string;
  page: PageAdapter;
  steps: WorkflowStep[];
  lastActivity: number;
}

const sessions = new Map<string, RecorderSession>();
const SESSION_IDLE_MS = 10 * 60 * 1000; // 10 minutes

// #8 — hard cap on concurrent recorder sessions to prevent memory exhaustion
const MAX_RECORDER_SESSIONS = 5;

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_IDLE_MS) {
      session.page.close().catch(() => {});
      sessions.delete(id);
      logger.info({ sessionId: id }, "Recorder session expired (idle timeout)");
    }
  }
}, 60_000).unref();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function takeScreenshot(page: PageAdapter): Promise<string> {
  const shot = await page.screenshot({ type: "png", encoding: "base64" });
  return typeof shot === "string" ? shot : Buffer.from(shot).toString("base64");
}

async function getSelectorAt(page: PageAdapter, x: number, y: number): Promise<string> {
  try {
    return (await page.evaluate(
      (args: { px: number; py: number }) => {
        const el = document.elementFromPoint(args.px, args.py) as HTMLElement | null;
        if (!el || el === document.body || el === document.documentElement) return "";

        if (el.id) return `#${CSS.escape(el.id)}`;

        for (const attr of ["data-testid", "data-test", "name", "aria-label"]) {
          const val = el.getAttribute(attr);
          if (val) {
            const sel = `[${attr}="${val.replace(/"/g, '\\"')}"]`;
            if (document.querySelectorAll(sel).length === 1) return sel;
          }
        }

        const tag = el.tagName.toLowerCase();
        const classes = Array.from(el.classList)
          .filter((c) => !/^\d/.test(c) && !/^[a-z]{1,2}[0-9]/.test(c))
          .slice(0, 2)
          .map((c) => `.${CSS.escape(c)}`)
          .join("");
        if (classes) {
          const sel = `${tag}${classes}`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }

        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
          const idx = siblings.indexOf(el) + 1;
          const parentSel = parent.id ? `#${CSS.escape(parent.id)}` : parent.tagName.toLowerCase();
          return `${parentSel} > ${tag}:nth-of-type(${idx})`;
        }

        return tag;
      },
      { px: x, py: y } as unknown as never,
    )) as string;
  } catch {
    return "";
  }
}

async function getTextAt(page: PageAdapter, x: number, y: number): Promise<string> {
  try {
    return (await page.evaluate(
      (args: { px: number; py: number }) => {
        const el = document.elementFromPoint(args.px, args.py) as HTMLElement | null;
        return (
          el?.getAttribute("aria-label") ||
          el?.getAttribute("placeholder") ||
          (el?.textContent ?? "")
        )
          .trim()
          .slice(0, 80);
      },
      { px: x, py: y } as unknown as never,
    )) as string;
  } catch {
    return "";
  }
}

async function getFocusedSelector(page: PageAdapter): Promise<string | null> {
  try {
    return (await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el.tagName === "BODY" || el.tagName === "HTML") return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const tag = el.tagName.toLowerCase();
      const name = el.getAttribute("name");
      if (name) return `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return `${tag}[placeholder="${placeholder.replace(/"/g, '\\"')}"]`;
      return tag;
    })) as string | null;
  } catch {
    return null;
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

// POST /api/recorder/sessions — start a new session
router.post("/recorder/sessions", async (req, res): Promise<void> => {
  // #8 — reject if already at capacity
  if (sessions.size >= MAX_RECORDER_SESSIONS) {
    res.status(429).json({
      error: `Maximum concurrent recorder sessions reached (${MAX_RECORDER_SESSIONS}). Close an existing session first.`,
    });
    return;
  }

  const { startUrl } = req.body as { startUrl?: string };
  if (!startUrl?.trim()) {
    res.status(400).json({ error: "startUrl is required" });
    return;
  }

  let page: PageAdapter | null = null;
  try {
    const config = await loadBrowserConfig();
    const provider = createBrowserProvider(config);
    page = await provider.newPage();
    await page.goto(startUrl.trim(), { waitUntil: "domcontentloaded", timeout: 30000 });

    const sessionId = randomUUID();
    const session: RecorderSession = {
      id: sessionId,
      page,
      steps: [{ type: "navigate", url: startUrl.trim() }],
      lastActivity: Date.now(),
    };
    sessions.set(sessionId, session);

    const [screenshotBase64, pageTitle] = await Promise.all([
      takeScreenshot(page),
      page.title(),
    ]);

    logger.info({ sessionId, startUrl, activeSessions: sessions.size }, "Recorder session started");
    res.json({
      sessionId,
      screenshotBase64,
      currentUrl: page.url(),
      pageTitle,
      steps: session.steps,
    });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Failed to start recorder session");
    res.status(500).json({ error: `Failed to start browser session: ${message}` });
  }
});

// POST /api/recorder/sessions/:id/actions — perform an action and return new screenshot
router.post("/recorder/sessions/:id/actions", async (req, res): Promise<void> => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  session.lastActivity = Date.now();

  const body = req.body as {
    type: string;
    x?: number;
    y?: number;
    text?: string;
    url?: string;
    key?: string;
    deltaY?: number;
    ms?: number;
  };

  let step: WorkflowStep | null = null;

  try {
    switch (body.type) {
      case "click": {
        const { x, y } = body;
        if (x == null || y == null) {
          res.status(400).json({ error: "x and y are required for click" });
          return;
        }
        const [sel, txt] = await Promise.all([
          getSelectorAt(session.page, x, y),
          getTextAt(session.page, x, y),
        ]);
        const newPagePromise = session.page.waitForNewPage({ timeout: 2500 }).catch(() => null);
          await session.page.mouse.click(x, y);
          await new Promise((r) => setTimeout(r, 1000));
          const newTabPage = await newPagePromise;
          if (newTabPage) {
            await session.page.close().catch(() => {});
            session.page = newTabPage;
            session.steps.push({ type: "switchToNewPage" });
            logger.info({ sessionId: session.id }, "Recorder: auto-switched to new tab after click");
          }
          step = sel
            ? { type: "click", selector: sel, selectorType: "css" }
            : { type: "click", selector: txt || "unknown", selectorType: "text" };
          break;
      }

      case "type": {
        const { text } = body;
        if (!text) {
          res.status(400).json({ error: "text is required for type" });
          return;
        }
        const focused = await getFocusedSelector(session.page);
        await session.page.keyboard.type(text, { delay: 30 });
        step = focused
          ? { type: "fill", selector: focused, value: text }
          : { type: "keypress", key: text };
        break;
      }

      case "navigate": {
        const { url } = body;
        if (!url) {
          res.status(400).json({ error: "url is required for navigate" });
          return;
        }
        await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        step = { type: "navigate", url };
        break;
      }

      case "keypress": {
        const { key } = body;
        if (!key) {
          res.status(400).json({ error: "key is required for keypress" });
          return;
        }
        await session.page.keyboard.press(key);
        await new Promise((r) => setTimeout(r, 600));
        step = { type: "keypress", key };
        break;
      }

      case "scroll": {
        const dy = body.deltaY ?? 300;
        await session.page.evaluate(
          (args: { dy: number }) => window.scrollBy(0, args.dy),
          { dy } as unknown as never,
        );
        await new Promise((r) => setTimeout(r, 300));
        step = { type: "scroll", y: dy };
        break;
      }

      case "wait": {
        const ms = body.ms ?? 1000;
        await new Promise((r) => setTimeout(r, ms));
        step = { type: "wait", ms };
        break;
      }

      case "screenshot": {
        step = { type: "screenshot" };
        break;
      }

      case "undo": {
        if (session.steps.length > 1) session.steps.pop();
        const [screenshotBase64, pageTitle] = await Promise.all([
          takeScreenshot(session.page),
          session.page.title().catch(() => ""),
        ]);
        res.json({
          ok: true,
          step: null,
          steps: session.steps,
          screenshotBase64,
          currentUrl: session.page.url(),
          pageTitle,
        });
        return;
      }

      default:
        res.status(400).json({ error: `Unknown action type: ${body.type}` });
        return;
    }

    if (step) session.steps.push(step);

    const [screenshotBase64, pageTitle] = await Promise.all([
      takeScreenshot(session.page),
      session.page.title().catch(() => ""),
    ]);

    res.json({
      ok: true,
      step,
      steps: session.steps,
      screenshotBase64,
      currentUrl: session.page.url(),
      pageTitle,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ sessionId: session.id, actionType: body.type, err }, "Recorder action failed");
    const screenshotBase64 = await takeScreenshot(session.page).catch(() => null);
    res.json({
      ok: false,
      error: message,
      step: null,
      steps: session.steps,
      screenshotBase64,
      currentUrl: session.page.url(),
      pageTitle: "",
    });
  }
});

// GET /api/recorder/sessions/:id — poll for current state
router.get("/recorder/sessions/:id", async (req, res): Promise<void> => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  session.lastActivity = Date.now();
  try {
    const [screenshotBase64, pageTitle] = await Promise.all([
      takeScreenshot(session.page),
      session.page.title().catch(() => ""),
    ]);
    res.json({
      screenshotBase64,
      currentUrl: session.page.url(),
      pageTitle,
      steps: session.steps,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// DELETE /api/recorder/sessions/:id — stop session, return accumulated steps
router.delete("/recorder/sessions/:id", async (req, res): Promise<void> => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  sessions.delete(session.id);
  await session.page.close().catch(() => {});
  logger.info({ sessionId: session.id, stepCount: session.steps.length }, "Recorder session stopped");
  res.json({ ok: true, steps: session.steps });
});

export default router;
