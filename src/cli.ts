import { loadAccounts } from "./accounts.js";
import { config, resolveStorageStatePath } from "./config.js";
import { launchContext } from "./lib/browser.js";
import { fetchNpssoInPage } from "./lib/npsso.js";
import { runLoginFlow } from "./flows/login.js";
import { runSignupFlow } from "./flows/signup.js";

function printDisclaimer(): void {
  console.info(`
PlayStation automation — personal use only
-----------------------------------------
• Automating Sony account pages may violate Sony Interactive Entertainment terms.
• Use only with accounts you own and are authorised to access.
• This tool does not bypass CAPTCHA or other abuse protections.
• You are responsible for compliant use.
`);
}

function printUsage(): void {
  console.info(`Usage:
  npm run login             — automatic sign-in per account (polls for session; see LOGIN_MAX_WAIT_MS)
  npm run login -- 0        — only the account at index 0 (0-based)
  npm run signup            — open account creation URL only (finish signup manually in the browser)
  npm run npsso             — print NPSSO token (requires an already-signed-in browser session)

Environment (see .env.example):
  PSN_ACCOUNTS_FILE    JSON array file of { "email", "password" }
  PSN_ACCOUNTS_JSON    inline JSON array (alternative)
  PSN_STORAGE_DIR      write per-account storage state (01-email.json, …)
  LOGIN_ONLY_INDEX       same as passing a single index after login
  LANDING_SIGNIN_MAX_WAIT_MS  how long to keep retrying landing Sign In click
  LANDING_SIGNIN_RETRY_MS     delay between landing Sign In click retries
  LOGIN_ATTEMPTS         retries per account (default 3)
  LOGIN_RETRY_DELAY_MS   delay between retries
  LOGIN_MAX_WAIT_MS      login auto-wait ceiling (polling for NPSSO / UI)
  LOGIN_POLL_MS          poll interval during login wait
  HEADED=0               headless (default HEADED=1)
  PSN_HOME_URL           PlayStation landing page visited before login click
  PSN_SIGNIN_URL         override sign-in URL
  PSN_SIGNUP_URL         override sign-up entry URL
  STORAGE_STATE_PATH     single storage file (last account wins if no PSN_STORAGE_DIR)
  PLAYWRIGHT_USER_DATA_DIR  persistent Chromium profile
  BROWSER_CHANNEL        browser channel (default chrome)
  CHROME_PROFILE_DIR     profile name inside Chrome User Data (e.g. Default)
`);
}

function parseLoginOnlyIndex(argv: string[]): number | undefined {
  const rest = argv.slice(3);
  for (const a of rest) {
    const t = a.trim();
    if (!t || t.startsWith("-")) continue;
    const n = Number.parseInt(t, 10);
    if (Number.isFinite(n) && String(n) === t) return n;
  }
  const envIdx = process.env.LOGIN_ONLY_INDEX?.trim();
  if (envIdx !== undefined && envIdx !== "") {
    const n = Number.parseInt(envIdx, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function filterAccounts<T>(accounts: T[], onlyIndex: number | undefined): T[] {
  if (onlyIndex === undefined) return accounts;
  if (onlyIndex < 0 || onlyIndex >= accounts.length) {
    console.error(
      `[login] LOGIN_ONLY_INDEX / argv index ${onlyIndex} is out of range (0…${accounts.length - 1}).`,
    );
    process.exitCode = 1;
    return [];
  }
  return [accounts[onlyIndex]];
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (!mode || ["-h", "--help", "help"].includes(mode)) {
    printDisclaimer();
    printUsage();
    process.exit(mode ? 0 : 1);
  }

  printDisclaimer();

  if (mode === "npsso") {
    const { context, close } = await launchContext();
    try {
      const page = await context.newPage();
      await page.goto("about:blank");
      const result = await fetchNpssoInPage(page);
      if (result.ok) {
        console.info(`NPSSO (handle like a password; do not commit):\n${result.npsso}`);
      } else {
        console.error(`Failed: ${result.error}`);
        if (result.body) console.error(result.body);
        process.exitCode = 1;
      }
    } finally {
      await close();
    }
    return;
  }

  const { context, close } = await launchContext();
  try {
    const page = await context.newPage();
    if (mode === "login") {
      const accounts = loadAccounts();
      if (accounts.length === 0) {
        console.error(
          "[login] No credentials: set PSN_ACCOUNTS_FILE, PSN_ACCOUNTS_JSON, or PSN_EMAIL and PSN_PASSWORD.",
        );
        process.exitCode = 1;
        return;
      }

      const onlyIndex = parseLoginOnlyIndex(process.argv);
      const batch = filterAccounts(accounts, onlyIndex);
      if (batch.length === 0) return;

      if (accounts.length > 1 && resolveStorageStatePath()) {
        console.warn(
          "[login] STORAGE_STATE_PATH is set while multiple accounts are configured — the preloaded session may interfere. Prefer PSN_STORAGE_DIR or clear STORAGE_STATE_PATH for batch runs.",
        );
      }
      if (accounts.length > 1 && config.userDataDir) {
        console.warn(
          "[login] PLAYWRIGHT_USER_DATA_DIR is set — a persistent profile can keep cookies across clears. For clean per-account logins, omit it or use a fresh profile.",
        );
      }

      for (let i = 0; i < batch.length; i++) {
        const acc = batch[i]!;
        const idx = onlyIndex !== undefined ? onlyIndex : i;
        console.info(`[login] Starting account ${idx + 1} (${acc.email})`);
        const shouldClear =
          (onlyIndex === undefined && i > 0) ||
          (onlyIndex !== undefined && onlyIndex > 0);
        if (shouldClear) {
          await context.clearCookies();
          await page.waitForTimeout(config.loginGapMs);
        }
        let ok = false;
        let lastError: unknown;
        for (let attempt = 1; attempt <= config.loginAttempts; attempt++) {
          try {
            console.info(
              `[login] Account ${idx + 1}: attempt ${attempt}/${config.loginAttempts}`,
            );
            await runLoginFlow(page, acc, { index: idx, total: accounts.length });
            ok = true;
            break;
          } catch (err) {
            lastError = err;
            console.error(
              `[login] Account ${idx + 1}: attempt ${attempt} failed.`,
              err,
            );
            if (attempt < config.loginAttempts) {
              await context.clearCookies().catch(() => {});
              await page.waitForTimeout(config.loginRetryDelayMs);
            }
          }
        }
        if (!ok) {
          throw lastError instanceof Error
            ? lastError
            : new Error(`[login] Account ${idx + 1} failed after retries.`);
        }
      }
    } else if (mode === "signup") {
      await runSignupFlow(page);
    } else {
      console.error(`Unknown command: ${mode}`);
      printUsage();
      process.exitCode = 1;
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
