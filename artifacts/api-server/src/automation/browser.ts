/**
 * Thin compatibility shim — all actual browser management lives in browser-provider.ts.
 * Existing code that imports { newPage, closeBrowser } from "./browser" keeps working.
 */
import { getBrowserProvider } from "./browser-provider";
import type { PageAdapter } from "./page-adapter";

export { getBrowserProvider, type BrowserProvider } from "./browser-provider";

export async function newPage(): Promise<PageAdapter> {
  return getBrowserProvider().newPage();
}

export async function closeBrowser(): Promise<void> {
  return getBrowserProvider().close();
}
