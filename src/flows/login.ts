import type { Page } from "playwright";
import type { PsnAccount } from "../accounts.js";
import { config, resolveAccountStoragePath } from "../config.js";
import { maybeSaveStorageState } from "../lib/browser.js";
import {
  clickNextAfterEmail,
  clickLandingSignIn,
  clickSignIn,
  fillEmail,
  fillPassword,
  getAuthFrame,
} from "../lib/locators.js";
import { waitForAutomaticLoginComplete } from "../lib/waitForLogin.js";

export type LoginMeta = { index: number; total: number };

export async function runLoginFlow(
  page: Page,
  account: PsnAccount,
  meta?: LoginMeta,
): Promise<void> {
  const prefix = meta
    ? `[login ${meta.index + 1}/${meta.total}]`
    : "[login]";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(config.homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      if (!page.url().startsWith("about:blank")) break;
    } catch {
      /* retry below */
    }
    if (attempt === 3) {
      await page.evaluate((url) => {
        window.location.href = url;
      }, config.homeUrl);
      await page.waitForURL(/playstation\.com/i, { timeout: 30_000 });
      if (page.url().startsWith("about:blank")) {
        throw new Error(`${prefix} Could not open home page from blank tab.`);
      }
      break;
    }
    await page.waitForTimeout(1500);
  }
  await page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  const landingClicked = await clickLandingSignIn(
    page,
    config.landingSignInMaxWaitMs,
    config.landingSignInRetryMs,
  );
  if (!landingClicked) {
    console.warn(
      `${prefix} Could not click Sign In on playstation.com.`,
    );
  } else {
    await page
      .waitForURL(/account\.sony\.com|sonyentertainmentnetwork|signin|login/i, {
        timeout: 20_000,
      })
      .catch(() => {
        console.warn(`${prefix} Redirect to sign-in URL was slow; continuing with current page.`);
      });
  }

  // Ensure sign-in page is fully settled before touching the email field.
  await page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});

  let surface = await getAuthFrame(page);
  const hasCreds = Boolean(account.email && account.password);
  let submitted = false;

  if (hasCreds) {
    const emailOk = await fillEmail(surface, account.email);
    let nextClicked = false;
    if (emailOk) {
      nextClicked = await clickNextAfterEmail(surface);
      if (nextClicked) {
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        surface = await getAuthFrame(page);
      }
    }

    const passOk = await fillPassword(surface, account.password);
    if (!emailOk || !passOk) {
      console.warn(
        `${prefix} Could not find email/password fields automatically; sign in manually — still polling for a session.`,
      );
    } else {
      const clicked = await clickSignIn(surface);
      if (!clicked) {
        console.warn(
          `${prefix} Could not click Sign In automatically; submit manually — still polling for a session.`,
        );
      } else {
        submitted = true;
      }
    }
  } else {
    console.info(
      `${prefix} No credentials — enter them in the browser; polling for a session.`,
    );
  }

  if (submitted) {
    await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
  }

  const loginStatus = await waitForAutomaticLoginComplete(page, `${prefix} ${account.email}`);
  if (!loginStatus.ok) {
    throw new Error(`${prefix} automatic login did not complete.`);
  }

  const perAccountPath = resolveAccountStoragePath(
    meta?.index ?? 0,
    account.email,
  );
  if (perAccountPath) {
    await maybeSaveStorageState(page.context(), perAccountPath);
    console.info(`${prefix} Saved storage state: ${perAccountPath}`);
  } else {
    await maybeSaveStorageState(page.context());
    if (meta && meta.total > 1) {
      console.warn(
        `${prefix} Set PSN_STORAGE_DIR to write separate storage files per account.`,
      );
    } else {
      console.info(`${prefix} Done. If STORAGE_STATE_PATH is set, session cookies were saved.`);
    }
  }
}
