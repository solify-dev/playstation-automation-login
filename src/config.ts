import "dotenv/config";
import path from "node:path";

function envBool(key: string, defaultValue: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(v);
}

function envInt(key: string, defaultValue: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

export const config = {
  homeUrl:
    process.env.PSN_HOME_URL ??
    "https://www.playstation.com/",
  signinUrl:
    process.env.PSN_SIGNIN_URL ??
    "https://my.account.sony.com/central/signin/",
  signupUrl:
    process.env.PSN_SIGNUP_URL ??
    "https://www.playstation.com/acct/create-account",
  email: process.env.PSN_EMAIL?.trim() ?? "",
  password: process.env.PSN_PASSWORD ?? "",
  /** JSON file with `[{ "email", "password" }, ...]` — see `psn-accounts.example.json` */
  accountsFile: process.env.PSN_ACCOUNTS_FILE?.trim() ?? "",
  /** Persistent profile path; non-empty profile is more reliable than guest/ephemeral. */
  userDataDir: process.env.PLAYWRIGHT_USER_DATA_DIR?.trim() ?? ".pw-profile",
  /** Prefer real installed Chrome channel for closer-to-normal browser fingerprint. */
  browserChannel: process.env.BROWSER_CHANNEL?.trim() ?? "chrome",
  /** Optional Chrome profile folder name inside User Data, e.g. Default, Profile 1 */
  chromeProfileDir: process.env.CHROME_PROFILE_DIR?.trim() ?? "",
  storageStatePath: process.env.STORAGE_STATE_PATH?.trim(),
  /**
   * When set, each successful login also writes `01-email.json`, `02-email.json`, …
   * (single-file STORAGE_STATE_PATH is still used if set and this is empty).
   */
  storageDir: process.env.PSN_STORAGE_DIR?.trim() ?? "",
  slowMoMs: envInt("SLOW_MO_MS", 0),
  headed: envBool("HEADED", true),
  /** Max time to keep trying the landing Sign In button (ms) */
  landingSignInMaxWaitMs: envInt("LANDING_SIGNIN_MAX_WAIT_MS", 30_000),
  /** Delay between landing Sign In click retries (ms) */
  landingSignInRetryMs: envInt("LANDING_SIGNIN_RETRY_MS", 700),
  /** Max time (ms) to poll for NPSSO / post-auth URL after submitting credentials */
  loginMaxWaitMs: envInt("LOGIN_MAX_WAIT_MS", 360_000),
  /** How often (ms) to check NPSSO / URL while waiting */
  loginPollMs: envInt("LOGIN_POLL_MS", 900),
  /** Signup-only: hold browser open for manual steps (ms) */
  manualStepTimeoutMs: envInt("MANUAL_STEP_TIMEOUT_MS", 300_000),
  /** Pause between multi-account logins after clearing cookies */
  loginGapMs: envInt("LOGIN_GAP_MS", 800),
  /** Automatic login retries per account before failing */
  loginAttempts: envInt("LOGIN_ATTEMPTS", 3),
  /** Delay between automatic login attempts (ms) */
  loginRetryDelayMs: envInt("LOGIN_RETRY_DELAY_MS", 2500),
  npssoUrl:
    process.env.PSN_NPSSO_URL ??
    "https://ca.account.sony.com/api/v1/ssocookie",
};

export function resolveStorageStatePath(): string | undefined {
  if (!config.storageStatePath) return undefined;
  return path.isAbsolute(config.storageStatePath)
    ? config.storageStatePath
    : path.resolve(process.cwd(), config.storageStatePath);
}

/** Per-account Playwright storage export under PSN_STORAGE_DIR */
export function resolveAccountStoragePath(index: number, email: string): string | undefined {
  if (!config.storageDir) return undefined;
  const dir = path.isAbsolute(config.storageDir)
    ? config.storageDir
    : path.resolve(process.cwd(), config.storageDir);
  const slug = email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "account";
  const file = `${String(index + 1).padStart(2, "0")}-${slug}.json`;
  return path.join(dir, file);
}
