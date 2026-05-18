/** Must match `JOB_KEY` in content.js (used if the tab cannot run the content script). */
const PS_AUTO_LOGIN_JOB_KEY = "psAutoLoginJob";

function validateAccountsList(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return "Add at least one account line.";
  }
  if (accounts.length > 25) {
    return "Maximum 25 accounts.";
  }
  for (let i = 0; i < accounts.length; i += 1) {
    const acc = accounts[i];
    if (!acc?.email || !acc?.password) {
      return `Line ${i + 1}: missing email or password.`;
    }
    const mode = acc.otpInputMode === "code" ? "code" : "secret";
    if (mode === "code") {
      const code = String(acc.otpCode || "").replace(/[^A-Za-z0-9]/g, "");
      if (code.length < 6) {
        return `Line ${i + 1}: OTP code must be at least 6 letters or digits.`;
      }
    } else if (!String(acc.verificationSecret || "").trim()) {
      return `Line ${i + 1}: missing TOTP secret.`;
    }
  }
  return null;
}

function sendStopToTab(tabId, sendResponse) {
  const task = { type: "STOP_PS_LOGIN_IN_TAB" };
  chrome.tabs.sendMessage(tabId, task, (response) => {
    if (!chrome.runtime.lastError) {
      sendResponse(
        response && typeof response === "object" && response.ok === false
          ? response
          : { ok: true, message: "Automation stopped." },
      );
      return;
    }
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        files: ["totp.js", "content.js"],
      },
      () => {
        if (chrome.runtime.lastError) {
          void chrome.storage.local.remove(PS_AUTO_LOGIN_JOB_KEY).then(() => {
            sendResponse({
              ok: true,
              message: "Cleared automation job (this page cannot run the extension).",
            });
          });
          return;
        }
        chrome.tabs.sendMessage(tabId, task, (response2) => {
          if (chrome.runtime.lastError) {
            void chrome.storage.local.remove(PS_AUTO_LOGIN_JOB_KEY).then(() => {
              sendResponse({ ok: true, message: "Cleared automation job." });
            });
            return;
          }
          sendResponse(
            response2 && typeof response2 === "object" && response2.ok === false
              ? response2
              : { ok: true, message: "Automation stopped." },
          );
        });
      },
    );
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PS_ENSURE_HOME_AFTER_SIGNOUT") {
    const msgTabId = Number(message.tabId);
    const tabId =
      Number.isInteger(msgTabId) && msgTabId >= 0 ? msgTabId : sender.tab?.id;
    const rawUrl =
      typeof message.url === "string" && /^https?:\/\//i.test(message.url)
        ? message.url
        : "https://www.playstation.com/";
    let url = rawUrl;
    try {
      const u = new URL(rawUrl);
      u.searchParams.set("_psAuto", String(Date.now()));
      url = u.href;
    } catch {
      // keep rawUrl
    }
    const delayMs = Math.min(
      15000,
      Math.max(0, Number.isFinite(Number(message.delayMs)) ? Number(message.delayMs) : 650),
    );
    if (Number.isInteger(tabId) && tabId >= 0) {
      setTimeout(() => {
        chrome.tabs.update(tabId, { url }).catch(() => {});
      }, delayMs);
    }
    return false;
  }

  if (message?.type === "STOP_PS_LOGIN") {
    const tabId = message?.tabId;
    if (!Number.isInteger(tabId) || tabId < 0) {
      sendResponse({ ok: false, error: "Missing tab ID." });
      return false;
    }
    sendStopToTab(tabId, sendResponse);
    return true;
  }

  if (message?.type !== "RUN_PS_LOGIN") {
    return false;
  }

  const tabId = message?.tabId;
  const payload = message?.payload;
  let accounts = payload?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    const one = payload?.account;
    if (one?.email && one?.password) {
      accounts = [one];
    }
  }
  if (!Number.isInteger(tabId) || tabId < 0) {
    sendResponse({ ok: false, error: "Missing tab ID." });
    return false;
  }
  const err = validateAccountsList(accounts);
  if (err) {
    sendResponse({ ok: false, error: err });
    return false;
  }

  sendResponse({
    ok: true,
    message: `Login automation started for ${accounts.length} account(s).`,
  });

  const task = {
    type: "RUN_PS_LOGIN_IN_TAB",
    payload: { accounts },
  };
  chrome.tabs.sendMessage(tabId, task, () => {
    if (!chrome.runtime.lastError) {
      return;
    }
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        files: ["totp.js", "content.js"],
      },
      () => {
        void chrome.runtime.lastError;
        chrome.tabs.sendMessage(tabId, task, () => {
          void chrome.runtime.lastError;
        });
      },
    );
  });

  return false;
});
