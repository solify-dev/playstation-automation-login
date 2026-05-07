import type { Page } from "playwright";
import { config } from "../config.js";
import { fetchNpssoInPage } from "./npsso.js";

function currentUrlLooksPostAuth(url: string): boolean {
  if (/signin|sign-in|login_required|error=login_required/i.test(url)) return false;
  return /my\.account\.sony\.com\/(?!.*signin)|id\.sonyentertainmentnetwork\.com\/id\/(?!.*signin)|playstation\.com\/(?!.*signin)|direct\.playstation\.net/i.test(
    url,
  );
}

async function pageShowsLoginError(page: Page): Promise<boolean> {
  const patterns = [
    /incorrect.*(password|sign-?in)|wrong.*password|invalid.*(credentials|email)|couldn.?t sign you in|sign.?in failed/i,
    /error.*password|password.*incorrect/i,
  ];
  for (const re of patterns) {
    const loc = page.getByText(re).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      return true;
    }
  }
  return false;
}

async function pageShowsSignedInChrome(page: Page): Promise<boolean> {
  for (const re of [/sign out/i, /log out/i]) {
    const btn = page.getByRole("button", { name: re }).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      return true;
    }
    const link = page.getByRole("link", { name: re }).first();
    if ((await link.count()) > 0 && (await link.isVisible().catch(() => false))) {
      return true;
    }
  }
  return false;
}

/**
 * Polls until NPSSO is available or signed-in chrome is visible — no fixed long blind sleep.
 */
export async function waitForAutomaticLoginComplete(
  page: Page,
  prefix: string,
): Promise<{ ok: boolean }> {
  const maxMs = config.loginMaxWaitMs;
  const poll = config.loginPollMs;
  const deadline = Date.now() + maxMs;
  let hintedPostAuth = false;

  console.info(
    `${prefix} Automatic wait: polling every ${poll}ms (max ${Math.round(maxMs / 1000)}s) for session…`,
  );

  while (Date.now() < deadline) {
    if (await pageShowsLoginError(page)) {
      console.error(
        `${prefix} Login error detected on the page — check credentials or account status.`,
      );
      return { ok: false };
    }

    const npsso = await fetchNpssoInPage(page);
    if (npsso.ok) {
      console.info(`${prefix} Session ready (NPSSO).`);
      return { ok: true };
    }

    if (await pageShowsSignedInChrome(page)) {
      console.info(`${prefix} Session ready (signed-in UI).`);
      return { ok: true };
    }

    const url = page.url();
    if (currentUrlLooksPostAuth(url) && !hintedPostAuth) {
      console.info(`${prefix} Post–sign-in navigation seen; finishing session checks…`);
      hintedPostAuth = true;
    }

    await page.waitForTimeout(poll);
  }

  console.warn(
    `${prefix} Login did not complete within ${Math.round(maxMs / 1000)}s (CAPTCHA / 2FA may need you in the browser).`,
  );
  return { ok: false };
}
