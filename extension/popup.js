const accountsInput = document.getElementById("accounts");
const otpModeRadios = document.querySelectorAll('input[name="otp_mode"]');
const rememberInput = document.getElementById("remember");
const runButton = document.getElementById("run");
const stopButton = document.getElementById("stop");
const statusEl = document.getElementById("status");

const STORAGE_ACCOUNTS_TEXT_KEY = "psAccountsListText";
const STORAGE_OTP_MODE_KEY = "psAccountsOtpMode";
const STORAGE_LEGACY_TEXT_KEY = "psAccountsText";
const OTP_CODE_MAX_LEN = 32;

function sanitizeOtpCodeInput(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "");
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#fca5a5" : "#cbd5e1";
}

function getOtpMode() {
  const checked = document.querySelector('input[name="otp_mode"]:checked');
  return checked?.value === "code" ? "code" : "secret";
}

function parseAccountLine(line, index, otpInputMode) {
  const firstComma = line.indexOf(",");
  const lastComma = line.lastIndexOf(",");
  if (firstComma <= 0 || lastComma <= firstComma) {
    throw new Error(`Line ${index + 1}: use email,password,totp_or_code`);
  }
  const email = line.slice(0, firstComma).trim();
  const password = line.slice(firstComma + 1, lastComma).trim();
  const third = line.slice(lastComma + 1).trim();
  if (!email || !password || !third) {
    throw new Error(`Line ${index + 1}: empty email, password, or third field.`);
  }
  if (otpInputMode === "code") {
    const otpCode = sanitizeOtpCodeInput(third).slice(0, OTP_CODE_MAX_LEN);
    if (otpCode.length < 6) {
      throw new Error(`Line ${index + 1}: OTP code must be at least 6 letters or digits.`);
    }
    return { email, password, otpInputMode: "code", otpCode };
  }
  return { email, password, otpInputMode: "secret", verificationSecret: third };
}

function parseAccountsFromText(rawText, otpInputMode) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error("Enter at least one account line.");
  }
  if (lines.length > 25) {
    throw new Error("Maximum 25 account lines.");
  }
  return lines.map((line, i) => parseAccountLine(line, i, otpInputMode));
}

function parseLegacySingleLine(rawText) {
  const line = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const firstComma = line.indexOf(",");
  const lastComma = line.lastIndexOf(",");
  if (firstComma <= 0 || lastComma <= firstComma) return null;
  const email = line.slice(0, firstComma).trim();
  const password = line.slice(firstComma + 1, lastComma).trim();
  const verificationSecret = line.slice(lastComma + 1).trim();
  if (!email || !password || !verificationSecret) return null;
  return { email, password, verificationSecret, otpInputMode: "secret" };
}

async function loadSaved() {
  const data = await chrome.storage.local.get([
    STORAGE_ACCOUNTS_TEXT_KEY,
    STORAGE_OTP_MODE_KEY,
    STORAGE_LEGACY_TEXT_KEY,
  ]);
  const savedText = data?.[STORAGE_ACCOUNTS_TEXT_KEY];
  if (savedText) {
    accountsInput.value = savedText;
    const mode = data?.[STORAGE_OTP_MODE_KEY] === "code" ? "code" : "secret";
    document.getElementById(mode === "code" ? "otp_mode_code" : "otp_mode_secret").checked = true;
    rememberInput.checked = true;
    return;
  }
  const legacy = data?.[STORAGE_LEGACY_TEXT_KEY];
  const parsed = parseLegacySingleLine(legacy);
  if (parsed) {
    accountsInput.value = `${parsed.email},${parsed.password},${parsed.verificationSecret}`;
    document.getElementById("otp_mode_secret").checked = true;
    rememberInput.checked = true;
  }
}

async function saveIfNeeded(otpInputMode) {
  if (rememberInput.checked) {
    await chrome.storage.local.set({
      [STORAGE_ACCOUNTS_TEXT_KEY]: accountsInput.value,
      [STORAGE_OTP_MODE_KEY]: otpInputMode,
    });
    await chrome.storage.local.remove([STORAGE_LEGACY_TEXT_KEY]);
  } else {
    await chrome.storage.local.remove([
      STORAGE_ACCOUNTS_TEXT_KEY,
      STORAGE_OTP_MODE_KEY,
      STORAGE_LEGACY_TEXT_KEY,
    ]);
  }
}

async function runLogin() {
  const otpInputMode = getOtpMode();
  let accounts;
  try {
    accounts = parseAccountsFromText(accountsInput.value, otpInputMode);
  } catch (err) {
    setStatus(String(err?.message || err), true);
    return;
  }

  runButton.disabled = true;
  setStatus(`Starting ${accounts.length} account(s)…`);
  await saveIfNeeded(otpInputMode);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "RUN_PS_LOGIN",
      tabId: tab.id,
      payload: {
        accounts,
      },
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown extension error.");
    }
    setStatus(response.message || "Automation started.");
  } catch (err) {
    setStatus(String(err), true);
  } finally {
    runButton.disabled = false;
  }
}

async function stopLogin() {
  setStatus("Stopping…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab.");
    }
    const response = await chrome.runtime.sendMessage({
      type: "STOP_PS_LOGIN",
      tabId: tab.id,
    });
    if (response && response.ok === false) {
      throw new Error(response.error || "Stop failed.");
    }
    setStatus(response?.message || "Automation stopped.");
  } catch (err) {
    setStatus(String(err), true);
  }
}

runButton.addEventListener("click", runLogin);
stopButton.addEventListener("click", stopLogin);
loadSaved().catch((err) => setStatus(String(err), true));
