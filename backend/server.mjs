import express from "express";
import cors from "cors";
import { ImapFlow } from "imapflow";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Render.com and similar platforms set PORT; local dev can use BACKEND_PORT.
const port = Number(process.env.PORT || process.env.BACKEND_PORT || 8787);
const host = process.env.BIND_HOST || "0.0.0.0";

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * Extract 6-digit Sony sign-in verification code from plain text / stripped HTML.
 * Matches: "916331 is your verification code for your Sony account."
 * Does not use a bare 6-digit match (avoids wrong codes from unrelated recent mail).
 */
function extractSonyCode(text) {
  if (!text) return null;

  const primary = [
    // Exact sentence from Sony sign-in email (see screenshot)
    /(\d{6})\s+is your verification code for your Sony account\b/i,
    // Subject-style: "Your Sony Sign-in Verification Code"
    /verification code[:\s]+(\d{6})\b/i,
    /\b(\d{6})\s+is your verification code\b/i,
  ];
  for (const re of primary) {
    const m = text.match(re);
    if (m?.[1] && /^\d{6}$/.test(m[1])) return m[1];
  }

  const fallback = [
    /\bverification code[^0-9]{0,20}(\d{6})\b/i,
    /\bsecurity code[^0-9]{0,20}(\d{6})\b/i,
  ];
  for (const re of fallback) {
    const m = text.match(re);
    if (m?.[1] && /^\d{6}$/.test(m[1])) return m[1];
  }
  return null;
}

/** Rough plain-text extraction from raw RFC822 (headers + body) */
function rawToSearchableText(raw) {
  if (!raw) return "";
  const s = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  // Drop most headers for matching; keep body after first blank line
  const idx = s.indexOf("\r\n\r\n");
  const body = idx >= 0 ? s.slice(idx + 4) : s;
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

async function fetchLatestSonyCode({
  imapHost,
  imapPort,
  imapSecure,
  imapUser,
  imapPass,
  mailbox = "INBOX",
  lookbackMinutes = 30,
}) {
  const client = new ImapFlow({
    host: imapHost,
    port: Number(imapPort),
    secure: Boolean(imapSecure),
    auth: { user: imapUser, pass: imapPass },
  });

  await client.connect();
  try {
    await client.mailboxOpen(mailbox);
    const since = new Date(Date.now() - Number(lookbackMinutes) * 60 * 1000);

    // Recent mail only — no FROM filter; scan newest-first for Sony verification text.
    const uids = await client.search({ since });
    const latestNewestFirst = uids.slice(-25).reverse();

    for await (const msg of client.fetch(latestNewestFirst, {
      envelope: true,
      source: true,
    })) {
      const subject = msg.envelope?.subject ?? "";
      let text = subject + "\n";
      if (msg.source) {
        text += rawToSearchableText(msg.source);
      }

      const code = extractSonyCode(text);
      if (code) return code;
    }
    return null;
  } finally {
    await client.logout().catch(() => {});
  }
}

app.post("/api/sony/verification-code", async (req, res) => {
  console.log("[sony/verification-code] request from extension");
  const body = req.query ?? {};
  const required = ["imapHost", "imapPort", "imapUser", "imapPass"];
  for (const key of required) {
    if (!body[key]) {
      return res.status(400).json({ ok: false, error: `Missing ${key}` });
    }
  }

  const payload = { ...body };

  try {
    const code = await fetchLatestSonyCode(payload);
    if (!code) {
      return res.status(404).json({ ok: false, error: "Verification code not found" });
    }
    console.log("[sony/verification-code] verification code:", code);
    return res.json({ ok: true, code });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(port, host, () => {
  console.log(`PS backend listening on http://${host}:${port}`);
});
