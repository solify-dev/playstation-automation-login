chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "FETCH_SONY_VERIFICATION_CODE") {
    const verification = message?.verification;
    if (!verification?.backendUrl) {
      sendResponse({ ok: false, error: "Missing backendUrl" });
      return false;
    }
    const url = `${String(verification.backendUrl).replace(/\/+$/, "")}/api/sony/verification-code`;
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(verification),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        console.log("[FETCH_SONY_VERIFICATION_CODE] status:", res.status, "ok:", Boolean(data?.ok));
        sendResponse({ ok: true, httpStatus: res.status, data });
      })
      .catch((err) => {
        console.error("[FETCH_SONY_VERIFICATION_CODE] error:", err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true;
  }

  if (message?.type !== "RUN_PS_LOGIN") {
    return false;
  }

  const tabId = message?.tabId;
  const payload = message?.payload;
  if (!tabId || !payload?.email || !payload?.password) {
    sendResponse({ ok: false, error: "Missing tab ID or credentials." });
    return false;
  }

  // Acknowledge immediately to avoid popup channel close on navigation.
  sendResponse({ ok: true, message: "Login automation started." });

  const task = {
    type: "RUN_PS_LOGIN_IN_TAB",
    payload,
  };
  chrome.tabs.sendMessage(tabId, task, () => {
    if (!chrome.runtime.lastError) {
      return;
    }
    // Ensure content script exists (after extension reload/new tab timing), then retry once.
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        files: ["content.js"],
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
