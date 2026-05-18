/**
 * RFC 6238 TOTP (HMAC-SHA1, 30s window, variable digits) using the Web Crypto API.
 * Loaded before content.js; exposes globalThis.psTotpGenerate(secret, digits, periodSeconds).
 */
(function (g) {
  "use strict";

  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  function decodeBase32Secret(secret) {
    const normalized = String(secret || "")
      .toUpperCase()
      .replace(/[^A-Z2-7]/g, "");
    if (!normalized) {
      throw new Error("Empty TOTP secret.");
    }
    let bits = "";
    for (const ch of normalized) {
      const idx = B32.indexOf(ch);
      if (idx < 0) {
        throw new Error("Invalid Base32 in TOTP secret.");
      }
      bits += idx.toString(2).padStart(5, "0");
    }
    const byteCount = Math.floor(bits.length / 8);
    const out = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i += 1) {
      out[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
    return out;
  }

  function counterToBuffer(counter) {
    const buf = new Uint8Array(8);
    let value = BigInt(counter);
    for (let i = 7; i >= 0; i -= 1) {
      buf[i] = Number(value & 0xffn);
      value >>= 8n;
    }
    return buf;
  }

  /**
   * @param {string} secret Base32 TOTP secret (spaces allowed)
   * @param {number} [digits=6]
   * @param {number} [periodSeconds=30]
   * @returns {Promise<string>}
   */
  g.psTotpGenerate = async function psTotpGenerate(secret, digits, periodSeconds) {
    const d = Number(digits) > 0 ? Number(digits) : 6;
    const period = Number(periodSeconds) > 0 ? Number(periodSeconds) : 30;
    if (!g.crypto?.subtle) {
      throw new Error("Web Crypto is unavailable.");
    }

    const keyBytes = decodeBase32Secret(secret);
    const counter = Math.floor(Date.now() / 1000 / period);
    const counterBytes = counterToBuffer(counter);

    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );

    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
    const offset = signature[signature.length - 1] & 0x0f;
    const binary =
      ((signature[offset] & 0x7f) << 24) |
      ((signature[offset + 1] & 0xff) << 16) |
      ((signature[offset + 2] & 0xff) << 8) |
      (signature[offset + 3] & 0xff);
    const otp = binary % 10 ** d;
    return String(otp).padStart(d, "0");
  };
})(globalThis);
