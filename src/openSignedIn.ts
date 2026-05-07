import "dotenv/config";
import path from "node:path";
import { chromium } from "playwright";

function normalizeUserDataDir(input: string): string {
  const resolved = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
  const lower = resolved.toLowerCase();
  if (lower.endsWith(path.join("google", "chrome", "user data").toLowerCase())) {
    return path.join(resolved, "Playwright-Automation");
  }
  return resolved;
}

async function ensureHomeNavigation(page: import("playwright").Page): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto("https://www.playstation.com/", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      if (!page.url().startsWith("about:blank")) return;
    } catch {
      /* retry below */
    }
    await page.waitForTimeout(1500);
  }

  // Fallback for stubborn startup tabs that ignore initial goto.
  await page.evaluate(() => {
    window.location.href = "https://www.playstation.com/";
  });
  await page.waitForURL(/playstation\.com/i, { timeout: 30_000 });
  if (page.url().startsWith("about:blank")) {
    throw new Error("Navigation stuck on about:blank.");
  }
}

async function clickLandingSignIn(page: import("playwright").Page): Promise<void> {
  const selector =
    ".web-toolbar__signin-button.psw-button.psw-b-0.psw-t-button.psw-l-line-center.psw-button-sizing.psw-button-sizing--small.psw-primary-button.psw-solid-button";
  const btn = page.locator(`button${selector}, a${selector}`).first();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      (await btn.count()) > 0 &&
      (await btn.isVisible().catch(() => false))
    ) {
      await btn.click({ timeout: 2_000 }).catch(() => {});
      return;
    }
    await page.waitForTimeout(700);
  }
}

async function main(): Promise<void> {
  const email = process.env.PSN_EMAIL ?? "";
  const password = process.env.PSN_PASSWORD ?? "";
  const userDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR?.trim()
    ? normalizeUserDataDir(process.env.PLAYWRIGHT_USER_DATA_DIR.trim())
    : path.resolve(process.cwd(), ".pw-profile");
  const chromeProfileDir = process.env.CHROME_PROFILE_DIR?.trim();
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: process.env.BROWSER_CHANNEL?.trim() || "chrome",
    args: chromeProfileDir ? [`--profile-directory=${chromeProfileDir}`] : undefined,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.bringToFront();
  await ensureHomeNavigation(page);
  console.log("Opened:", page.url());
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  await clickLandingSignIn(page);
  await page
    .waitForURL(/account\.sony\.com|sonyentertainmentnetwork|signin|login/i, {
      timeout: 20_000,
    })
    .catch(() => {});

  await page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});

  const emailInput = page.locator("#signin-entrance-input-signinId").first();
  if ((await emailInput.count()) > 0) {
    await emailInput.fill(email).catch(() => {});
    await page.locator("#signin-entrance-button").first().click().catch(() => {});
  }

  await page.waitForTimeout(2_000);
  const pw = page.locator('input[type="password"], #password, input[name="password"]').first();
  if ((await pw.count()) > 0) {
    await pw.fill(password).catch(() => {});
    await page.getByRole("button", { name: /sign in/i }).first().click().catch(() => {});
  }

  console.log("Opened Chrome and executed sign-in flow. Keeping browser open.");
  await new Promise<void>(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
