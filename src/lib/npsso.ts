import type { Page } from "playwright";
import { config } from "../config.js";

export type NpssoResult =
  | { ok: true; npsso: string; raw: unknown }
  | { ok: false; error: string; body?: string };

/**
 * Reads NPSSO JSON from Sony's ssocookie endpoint in the current browser session.
 * Documented in community PSN API guides (not an officially published public API).
 */
export async function fetchNpssoInPage(page: Page): Promise<NpssoResult> {
  const res = await page.request.get(config.npssoUrl, {
    failOnStatusCode: false,
  });
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { npsso?: string; error?: unknown };
    if (typeof data.npsso === "string" && data.npsso.length > 0) {
      return { ok: true, npsso: data.npsso, raw: data };
    }
    return {
      ok: false,
      error: "Response did not contain npsso (are you signed in in this profile?)",
      body: text.slice(0, 500),
    };
  } catch {
    return {
      ok: false,
      error: "Could not parse NPSSO JSON",
      body: text.slice(0, 500),
    };
  }
}
