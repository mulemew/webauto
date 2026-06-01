import type { PageAdapter, DialogAdapter } from "./page-adapter";
import { logger } from "../lib/logger";

export function attachPopupHandler(page: PageAdapter): void {
  page.on("dialog", async (dialog: DialogAdapter) => {
    logger.info({ type: dialog.dialogType(), message: dialog.message() }, "Auto-dismissing dialog");
    try {
      await dialog.dismiss();
    } catch {
      try {
        await dialog.accept();
      } catch (err) {
        logger.warn({ err }, "Failed to dismiss or accept dialog");
      }
    }
  });
}

export async function dismissPopups(page: PageAdapter): Promise<void> {
  try {
    const closeSelectors = [
      "button[aria-label*='close' i]",
      "button[aria-label*='dismiss' i]",
      "button[class*='close' i]",
      "button[class*='dismiss' i]",
      ".modal-close",
      ".dialog-close",
      "[data-dismiss='modal']",
      "[data-bs-dismiss='modal']",
    ];
    for (const selector of closeSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        logger.info({ selector }, "Dismissing overlay popup");
        await btn.click();
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (err) {
    logger.debug({ err }, "No popups to dismiss");
  }
}
