import type { Page } from "playwright";
import { config } from "../config.js";
import { maybeSaveStorageState } from "../lib/browser.js";

/** Opens the account-creation entry URL; registration is completed manually in the browser. */
export async function runSignupFlow(page: Page): Promise<void> {
  await page.goto(config.signupUrl, { waitUntil: "domcontentloaded" });
  console.info(
    "[signup] Complete account creation in the browser. No automated form filling.",
  );
  console.info(
    `[signup] Window stays open for ${Math.round(config.manualStepTimeoutMs / 1000)}s (MANUAL_STEP_TIMEOUT_MS).`,
  );
  await page.waitForTimeout(config.manualStepTimeoutMs);
  await maybeSaveStorageState(page.context());
}
