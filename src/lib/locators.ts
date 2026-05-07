import type { Frame, Page } from "playwright";

/**
 * Sony pages change often; try several stable patterns.
 */
export async function fillEmail(page: Page | Frame, email: string): Promise<boolean> {
  const candidates = [
    () => page.locator("#signin-entrance-input-signinId").first(),
    () => page.getByLabel(/email|sign-?in id/i).first(),
    () => page.locator('input[type="email"]').first(),
    () => page.locator('input[name="signinId"]').first(),
    () => page.locator("#signinId").first(),
    () => page.locator('input[autocomplete="username"]').first(),
  ];
  for (const pick of candidates) {
    const loc = pick();
    try {
      if ((await loc.count()) > 0) {
        await loc.click({ timeout: 5000 });
        await loc.fill(email, { timeout: 5000 });
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

export async function clickNextAfterEmail(page: Page | Frame): Promise<boolean> {
  const candidates = [
    () => page.locator("#signin-entrance-button").first(),
    () => page.getByRole("button", { name: /^next$/i }).first(),
    () => page.locator('button[type="submit"]').first(),
  ];
  for (const pick of candidates) {
    const loc = pick();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click({ timeout: 5000 });
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

export async function fillPassword(page: Page | Frame, password: string): Promise<boolean> {
  const candidates = [
    () => page.getByLabel(/^password$/i).first(),
    () => page.locator('input[type="password"]').first(),
    () => page.locator('input[name="password"]').first(),
    () => page.locator("#password").first(),
    () => page.locator('input[autocomplete="current-password"]').first(),
  ];
  for (const pick of candidates) {
    const loc = pick();
    try {
      if ((await loc.count()) > 0) {
        await loc.click({ timeout: 5000 });
        await loc.fill(password, { timeout: 5000 });
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

export async function clickLandingSignIn(
  page: Page,
  maxWaitMs = 30_000,
  retryMs = 700,
): Promise<boolean> {
  const classSelector =
    ".web-toolbar__signin-button.psw-button.psw-b-0.psw-t-button.psw-l-line-center.psw-button-sizing.psw-button-sizing--small.psw-primary-button.psw-solid-button";
  const candidates = [
    () => page.locator(`button${classSelector}, a${classSelector}`).first(),
    () => page.getByRole("link", { name: /^sign in$/i }).first(),
    () => page.getByRole("button", { name: /^sign in$/i }).first(),
    () => page.getByRole("link", { name: /sign in/i }).first(),
    () => page.getByRole("button", { name: /sign in/i }).first(),
    () => page.locator('a[href*="signin" i], a[href*="login" i]').first(),
    () => page.locator('button[data-qa*="sign" i], a[data-qa*="sign" i]').first(),
  ];
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    for (const pick of candidates) {
      const loc = pick();
      try {
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
          await loc.click({ timeout: 2000 });
          return true;
        }
      } catch {
        /* try next */
      }
    }
    await page.waitForTimeout(retryMs);
  }
  return false;
}

export async function clickSignIn(page: Page | Frame): Promise<boolean> {
  const candidates = [
    () => page.getByRole("button", { name: /sign in/i }).first(),
    () => page.locator('button[type="submit"]').first(),
    () => page.locator('input[type="submit"]').first(),
  ];
  for (const pick of candidates) {
    const loc = pick();
    try {
      if ((await loc.count()) > 0) {
        await loc.click({ timeout: 5000 });
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

/** Some flows embed the form in an iframe */
export async function getAuthFrame(page: Page): Promise<Page | Frame> {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (
      /account\.sony\.com|sonyentertainmentnetwork|signin/i.test(url) &&
      frame !== page.mainFrame()
    ) {
      return frame;
    }
  }
  return page;
}
