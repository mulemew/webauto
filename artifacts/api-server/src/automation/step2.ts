import type { PageAdapter } from "./page-adapter";
import { logger } from "../lib/logger";
import { dismissPopups } from "./popup-handler";

export interface Step2Config {
  targetUrl: string;
  buttonText: string;
}

export async function executeStep2(
  page: PageAdapter,
  config: Step2Config,
): Promise<{ success: boolean; message: string }> {
  try {
    logger.info({ targetUrl: config.targetUrl, buttonText: config.buttonText }, "Executing step 2");

    await page.goto(config.targetUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await dismissPopups(page);
    await new Promise((r) => setTimeout(r, 1000));

    const lowerBtnText = config.buttonText.toLowerCase().trim();

    const found = await page.evaluate((btnText: unknown) => {
      const elements = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, a, input[type='button'], input[type='submit'], [role='button']",
        ),
      );
      for (const el of elements) {
        const text = (
          el.textContent ||
          (el instanceof HTMLInputElement ? el.value : "") ||
          el.getAttribute("aria-label") ||
          ""
        )
          .toLowerCase()
          .trim();
        if (text === (btnText as string) || text.includes(btnText as string)) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (style.display !== "none" && style.visibility !== "hidden" && rect.width > 0) {
            el.click();
            return { found: true, text: el.textContent?.trim() ?? (btnText as string) };
          }
        }
      }
      return { found: false, text: "" };
    }, lowerBtnText as never) as { found: boolean; text: string };

    if (!found.found) {
      return {
        success: false,
        message: `Button with text "${config.buttonText}" not found on ${config.targetUrl}`,
      };
    }

    await new Promise((r) => setTimeout(r, 2000));
    await dismissPopups(page);

    const finalUrl = page.url();
    logger.info({ finalUrl, buttonText: found.text }, "Step 2 completed");
    return {
      success: true,
      message: `Clicked button "${found.text}" on ${config.targetUrl}. Final URL: ${finalUrl}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Step 2 error");
    return { success: false, message: `Step 2 error: ${message}` };
  }
}
