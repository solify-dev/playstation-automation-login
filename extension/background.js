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
        sendResponse({ ok: true, httpStatus: res.status, data });
      })
      .catch((err) => {
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

  chrome.tabs.sendMessage(
    tabId,
    {
      type: "RUN_PS_LOGIN_IN_TAB",
      payload,
    },
    () => {
      // Fire-and-forget. Content script persists state and continues after redirects.
      void chrome.runtime.lastError;
    },
  );

  return false;
});
