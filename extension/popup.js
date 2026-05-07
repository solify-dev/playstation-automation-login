const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const backendUrlInput = document.getElementById("backendUrl");
const imapHostInput = document.getElementById("imapHost");
const imapPortInput = document.getElementById("imapPort");
const imapSecureInput = document.getElementById("imapSecure");
const imapUserInput = document.getElementById("imapUser");
const imapPassInput = document.getElementById("imapPass");
const rememberInput = document.getElementById("remember");
const runButton = document.getElementById("run");
const statusEl = document.getElementById("status");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#fca5a5" : "#cbd5e1";
}

async function loadSaved() {
  const {
    psEmail = "",
    psPassword = "",
    backendUrl = "http://127.0.0.1:8787",
    imapHost = "",
    imapPort = "993",
    imapSecure = "true",
    imapUser = "",
    imapPass = "",
  } = await chrome.storage.local.get([
    "psEmail",
    "psPassword",
    "backendUrl",
    "imapHost",
    "imapPort",
    "imapSecure",
    "imapUser",
    "imapPass",
  ]);
  if (psEmail) {
    emailInput.value = psEmail;
  }
  if (psPassword) {
    passwordInput.value = psPassword;
    rememberInput.checked = true;
  }
  backendUrlInput.value = backendUrl;
  imapHostInput.value = imapHost;
  imapPortInput.value = String(imapPort);
  imapSecureInput.value = String(imapSecure);
  imapUserInput.value = imapUser;
  imapPassInput.value = imapPass;
}

async function saveIfNeeded() {
  if (rememberInput.checked) {
    await chrome.storage.local.set({
      psEmail: emailInput.value.trim(),
      psPassword: passwordInput.value,
      backendUrl: backendUrlInput.value.trim(),
      imapHost: imapHostInput.value.trim(),
      imapPort: imapPortInput.value.trim(),
      imapSecure: imapSecureInput.value,
      imapUser: imapUserInput.value.trim(),
      imapPass: imapPassInput.value,
    });
  } else {
    await chrome.storage.local.remove([
      "psEmail",
      "psPassword",
      "backendUrl",
      "imapHost",
      "imapPort",
      "imapSecure",
      "imapUser",
      "imapPass",
    ]);
  }
}

async function runLogin() {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) {
    setStatus("Enter both email and password.", true);
    return;
  }
  if (!backendUrlInput.value.trim() || !imapHostInput.value.trim()) {
    setStatus("Enter backend URL and IMAP host.", true);
    return;
  }

  runButton.disabled = true;
  setStatus("Sending login task...");
  await saveIfNeeded();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "RUN_PS_LOGIN",
      tabId: tab.id,
      payload: {
        email,
        password,
        verification: {
          backendUrl: backendUrlInput.value.trim(),
          imapHost: imapHostInput.value.trim(),
          imapPort: Number(imapPortInput.value || 993),
          imapSecure: imapSecureInput.value === "true",
          imapUser: imapUserInput.value.trim(),
          imapPass: imapPassInput.value,
        },
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

runButton.addEventListener("click", runLogin);
loadSaved().catch((err) => setStatus(String(err), true));
