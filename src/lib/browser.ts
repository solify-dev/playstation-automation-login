import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { config, resolveStorageStatePath } from "../config.js";

function normalizeUserDataDir(input: string): string {
  const resolved = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
  const lower = resolved.toLowerCase();
  // Chrome refuses DevTools automation on the default live User Data root.
  if (lower.endsWith(path.join("google", "chrome", "user data").toLowerCase())) {
    return path.join(resolved, "Playwright-Automation");
  }
  return resolved;
}

export async function launchContext(): Promise<{
  context: BrowserContext;
  close: () => Promise<void>;
}> {
  const storageState = resolveStorageStatePath();
  const launchArgs = config.chromeProfileDir
    ? [`--profile-directory=${config.chromeProfileDir}`]
    : undefined;
  const launchOptions = {
    headless: !config.headed,
    slowMo: config.slowMoMs > 0 ? config.slowMoMs : undefined,
  };

  if (config.userDataDir) {
    const userDataDir = normalizeUserDataDir(config.userDataDir);
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      channel: config.browserChannel || undefined,
      args: launchArgs,
      viewport: { width: 1280, height: 800 },
      ...(storageState ? { storageState } : {}),
    });
    return {
      context,
      close: async () => {
        await context.close();
      },
    };
  }

  const browser = await chromium.launch({
    ...launchOptions,
    channel: config.browserChannel || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(storageState ? { storageState } : {}),
  });
  return {
    context,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

export async function maybeSaveStorageState(
  context: BrowserContext,
  overridePath?: string,
): Promise<void> {
  const p = overridePath ?? resolveStorageStatePath();
  if (!p) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  await context.storageState({ path: p });
}
