import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type PsnAccount = {
  email: string;
  password: string;
  label?: string;
};

function parseAccountsJson(raw: string, source: string): PsnAccount[] {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) {
      console.warn(`[accounts] ${source}: expected a JSON array of account objects`);
      return [];
    }
    const out: PsnAccount[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const email = String(rec.email ?? "").trim();
      const password = String(rec.password ?? "");
      const label = rec.label;
      if (!email || !password) {
        console.warn(`[accounts] ${source}: skipping entry without email and password`);
        continue;
      }
      out.push({
        email,
        password,
        ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
      });
    }
    return out;
  } catch (e) {
    console.warn(`[accounts] Failed to parse ${source}:`, e);
    return [];
  }
}

function loadAccountsFromFile(): PsnAccount[] {
  if (!config.accountsFile) return [];
  const resolved = path.isAbsolute(config.accountsFile)
    ? config.accountsFile
    : path.resolve(process.cwd(), config.accountsFile);
  if (!fs.existsSync(resolved)) {
    console.warn(`[accounts] PSN_ACCOUNTS_FILE not found: ${resolved}`);
    return [];
  }
  const raw = fs.readFileSync(resolved, "utf8");
  return parseAccountsJson(raw, resolved);
}

function loadAccountsFromEnvJson(): PsnAccount[] {
  const raw = process.env.PSN_ACCOUNTS_JSON?.trim();
  if (!raw) return [];
  return parseAccountsJson(raw, "PSN_ACCOUNTS_JSON");
}

/**
 * Order: `PSN_ACCOUNTS_FILE` → `PSN_ACCOUNTS_JSON` → single `PSN_EMAIL` / `PSN_PASSWORD`.
 */
export function loadAccounts(): PsnAccount[] {
  const fromFile = loadAccountsFromFile();
  if (fromFile.length > 0) return fromFile;

  const fromJson = loadAccountsFromEnvJson();
  if (fromJson.length > 0) return fromJson;

  if (config.email && config.password) {
    return [{ email: config.email, password: config.password }];
  }

  return [];
}
