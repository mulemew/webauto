/**
 * PageAdapter — unified browser page interface for both Puppeteer and Playwright.
 *
 * Both providers connect to a remote CDP WebSocket (browserless, etc.).
 * This adapter normalises API differences so the rest of the codebase
 * stays provider-agnostic.
 */

import puppeteer, { type Page as PuppeteerPage, type Frame as PuppeteerFrame } from "puppeteer";
import { chromium, firefox, type Page as PlaywrightPage, type Frame as PlaywrightFrame } from "playwright-core";

// ── Adapter interfaces ────────────────────────────────────────────────────────

export interface ElementAdapter {
  click(): Promise<void>;
  evaluate<T>(fn: (el: Element) => T): Promise<T>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  screenshot(options?: { encoding?: "base64" | "binary" }): Promise<Buffer | string>;
}

export interface DialogAdapter {
  dialogType(): string;
  message(): string;
  dismiss(): Promise<void>;
  accept(): Promise<void>;
}

export interface KeyboardAdapter {
  type(text: string, options?: { delay?: number }): Promise<void>;
  press(key: string): Promise<void>;
}

export interface MouseAdapter {
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
}

export interface FrameAdapter {
  url(): string;
  $(selector: string): Promise<ElementAdapter | null>;
}

export interface PageAdapter {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  click(selector: string): Promise<void>;
  hover(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<void>;
  waitForNavigation(options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  $(selector: string): Promise<ElementAdapter | null>;
  evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;
  screenshot(options?: { type?: "png" | "jpeg"; encoding?: "base64" | "binary"; timeout?: number }): Promise<Buffer | string>;
  url(): string;
  title(): Promise<string>;
  on(event: "dialog", handler: (dialog: DialogAdapter) => void): void;
  close(options?: Record<string, unknown>): Promise<void>;
  keyboard: KeyboardAdapter;
  mouse: MouseAdapter;
  viewport(): { width: number; height: number } | null;
  frames(): FrameAdapter[];
  /** Wait for a new browser tab/window to open and return it as a PageAdapter. */
  waitForNewPage(options?: { timeout?: number }): Promise<PageAdapter>;
  /** Returns true if the underlying page has been closed / detached. */
  isClosed(): boolean;
  /**
   * Returns all currently open non-closed pages in the same browser context.
   * Screenshot step uses this to auto-fallback when the current page is closed
   * (e.g. a click opened a new tab without a switchToNewPage step).
   */
  getOpenPages(): PageAdapter[];
}

// ── Puppeteer wrapper ─────────────────────────────────────────────────────────

/**
 * Puppeteer uses `::-p-xpath(expr)` for XPath; Playwright uses `xpath=expr`.
 * Callers always pass `xpath=expr` — this function converts for Puppeteer.
 */
function toPuppeteerSelector(sel: string): string {
  if (sel.startsWith("xpath=")) return `::-p-xpath(${sel.slice(6)})`;
  return sel;
}

function wrapPuppeteerFrameElement(
  el: Awaited<ReturnType<PuppeteerFrame["$"]>> & object,
  frame: PuppeteerFrame,
): ElementAdapter {
  return {
    click: () => el.click(),
    evaluate: <T>(fn: (e: Element) => T) => frame.evaluate(fn, el) as Promise<T>,
    boundingBox: () => el.boundingBox(),
    screenshot: async (opts) => {
      if (opts?.encoding === "base64") return el.screenshot({ encoding: "base64" }) as Promise<string>;
      return el.screenshot() as Promise<Buffer>;
    },
  };
}

function wrapPuppeteerElement(
  el: Awaited<ReturnType<PuppeteerPage["$"]>> & object,
  page: PuppeteerPage,
): ElementAdapter {
  return {
    click: () => el.click(),
    evaluate: <T>(fn: (e: Element) => T) => page.evaluate(fn, el) as Promise<T>,
    boundingBox: () => el.boundingBox(),
    screenshot: async (opts) => {
      if (opts?.encoding === "base64") return el.screenshot({ encoding: "base64" }) as Promise<string>;
      return el.screenshot() as Promise<Buffer>;
    },
  };
}

function wrapPuppeteerFrame(frame: PuppeteerFrame): FrameAdapter {
  return {
    url: () => frame.url(),
    $: async (sel) => {
      const el = await frame.$(toPuppeteerSelector(sel));
      if (!el) return null;
      return wrapPuppeteerFrameElement(el, frame);
    },
  };
}

export function wrapPuppeteerPage(page: PuppeteerPage): PageAdapter {
  const adapter: PageAdapter = {
    goto: async (url, opts) => {
      await page.goto(url, opts as Parameters<PuppeteerPage["goto"]>[1]);
    },
    click: (sel) => page.click(toPuppeteerSelector(sel)),
    hover: (sel) => page.hover(toPuppeteerSelector(sel)),
    waitForSelector: async (sel, opts) => {
      await page.waitForSelector(toPuppeteerSelector(sel) as string, opts);
    },
    waitForNavigation: async (opts) => {
      await page.waitForNavigation(opts as Parameters<PuppeteerPage["waitForNavigation"]>[0]);
    },
    $: async (sel) => {
      const el = await page.$(toPuppeteerSelector(sel));
      if (!el) return null;
      return wrapPuppeteerElement(el, page);
    },
    evaluate: (fn: unknown, ...args: unknown[]) => page.evaluate(fn as never, ...args),
    screenshot: async (opts) => {
      if (opts?.encoding === "base64") {
        return page.screenshot({ ...opts, encoding: "base64" }) as unknown as string;
      }
      const buf = await page.screenshot(opts as Parameters<PuppeteerPage["screenshot"]>[0]);
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as Uint8Array);
    },
    url: () => page.url(),
    title: () => page.title(),
    on: (event, handler) => {
      if (event === "dialog") {
        page.on("dialog", (d) =>
          handler({
            dialogType: () => d.type(),
            message: () => d.message(),
            dismiss: () => d.dismiss(),
            accept: () => d.accept(),
          }),
        );
      }
    },
    close: (opts) => page.close(opts as Parameters<PuppeteerPage["close"]>[0]),
    keyboard: {
      type: (text, opts) => page.keyboard.type(text, opts),
      press: (key) => page.keyboard.press(key as Parameters<typeof page.keyboard.press>[0]),
    },
    mouse: {
      move: (x, y) => page.mouse.move(x, y),
      click: (x, y) => page.mouse.click(x, y),
    },
    viewport: () => page.viewport(),
    frames: () => page.frames().map(wrapPuppeteerFrame),
    waitForNewPage: async (_opts) => {
      throw new Error("waitForNewPage must be initialised by the BrowserProvider");
    },
    isClosed: () => page.isClosed(),
      getOpenPages: () => [], // Puppeteer: browser.pages() is async; fallback not supported
    };
    return adapter;
  }

  // ── Playwright wrapper ────────────────────────────────────────────────────────

function normalizeWaitUntil(
  w?: string,
): "networkidle" | "domcontentloaded" | "load" | "commit" | undefined {
  if (w === "networkidle2" || w === "networkidle0" || w === "networkidle") return "networkidle";
  if (w === "domcontentloaded") return "domcontentloaded";
  if (w === "load") return "load";
  if (w === "commit") return "commit";
  return undefined;
}

function wrapPlaywrightFrame(frame: PlaywrightFrame): FrameAdapter {
  return {
    url: () => frame.url(),
    $: async (sel) => {
      try {
        const locator = frame.locator(sel).first();
        if ((await locator.count()) === 0) return null;
        return {
          click: () => locator.click(),
          evaluate: <T>(fn: (el: Element) => T) => locator.evaluate(fn) as Promise<T>,
          boundingBox: () => locator.boundingBox(),
          screenshot: async (opts) => {
            const buf = await locator.screenshot();
            if (opts?.encoding === "base64") return buf.toString("base64");
            return buf;
          },
        };
      } catch {
        return null;
      }
    },
  };
}

export function wrapPlaywrightPage(page: PlaywrightPage): PageAdapter {
  const adapter: PageAdapter = {
    goto: async (url, opts) => {
      await page.goto(url, {
        waitUntil: normalizeWaitUntil(opts?.waitUntil) ?? "load",
        timeout: opts?.timeout,
      });
    },
    click: (sel) => page.click(sel),
    hover: (sel) => page.locator(sel).first().hover(),
    waitForSelector: async (sel, opts) => {
      await page.waitForSelector(sel, opts);
    },
    waitForNavigation: async (opts) => {
      try {
        await page.waitForURL("**", {
          waitUntil: normalizeWaitUntil(opts?.waitUntil) ?? "networkidle",
          timeout: opts?.timeout,
        });
      } catch {
        // navigation may have already completed
      }
    },
    $: async (sel) => {
      try {
        const locator = page.locator(sel).first();
        if ((await locator.count()) === 0) return null;
        return {
          click: () => locator.click(),
          evaluate: <T>(fn: (el: Element) => T) => locator.evaluate(fn) as Promise<T>,
          boundingBox: () => locator.boundingBox(),
          screenshot: async (opts) => {
            const buf = await locator.screenshot();
            if (opts?.encoding === "base64") return buf.toString("base64");
            return buf;
          },
        };
      } catch {
        return null;
      }
    },
    evaluate: (fn: unknown, ...args: unknown[]) => page.evaluate(fn as never, ...args),
    screenshot: async (opts) => {
      const buf = await page.screenshot({ type: opts?.type ?? "png" });
      if (opts?.encoding === "base64") return buf.toString("base64");
      return buf;
    },
    url: () => page.url(),
    title: () => page.title(),
    on: (event, handler) => {
      if (event === "dialog") {
        page.on("dialog", (d) =>
          handler({
            dialogType: () => d.type(),
            message: () => d.message(),
            dismiss: () => d.dismiss(),
            accept: () => d.accept(),
          }),
        );
      }
    },
    close: () => page.close(),
    keyboard: {
      type: (text, opts) => page.keyboard.type(text, opts),
      press: (key) => page.keyboard.press(key),
    },
    mouse: {
      move: (x, y) => page.mouse.move(x, y),
      click: (x, y) => page.mouse.click(x, y),
    },
    viewport: () => page.viewportSize(),
    frames: () => page.frames().map(wrapPlaywrightFrame),
    waitForNewPage: async (_opts) => {
      throw new Error("waitForNewPage must be initialised by the BrowserProvider");
    },
    isClosed: () => page.isClosed(),
      getOpenPages: () =>
        page
          .context()
          .pages()
          .filter((p) => !p.isClosed())
          .map((p) => wrapPlaywrightPage(p)),
    };
    return adapter;
  }

  // ── Re-export library clients for use in browser-provider ─────────────────────
export { puppeteer, chromium, firefox };
