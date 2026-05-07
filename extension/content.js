const HOME_URL = "https://www.playstation.com/";
const JOB_KEY = "psAutoLoginJob";
const JOB_MAX_AGE_MS = 10 * 60 * 1000;
let running = false;
let retryTimer = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInteractableField(el) {
  if (!el || el.disabled) return false;
  const view = el.ownerDocument?.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }
  // Do not use offsetParent: inputs in fixed/fullscreen layers often have offsetParent === null.
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findElementDeep(selectors, rootDoc = document) {
  for (const selector of selectors) {
    const el = rootDoc.querySelector(selector);
    if (el && isInteractableField(el)) {
      return el;
    }
  }

  const iframes = rootDoc.querySelectorAll("iframe");
  for (const frame of iframes) {
    try {
      const childDoc = frame.contentDocument;
      if (!childDoc) continue;
      const inFrame = findElementDeep(selectors, childDoc);
      if (inFrame) return inFrame;
    } catch {
      // Cross-origin frame; ignore and continue.
    }
  }
  return null;
}

async function waitForElement(selectors, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = findElementDeep(selectors);
    if (el) return el;
    await wait(300);
  }
  return null;
}

/** Avoid duplicate jobs: subframes run only when the auth UI lives in that frame. */
function shouldRunAutomationInThisFrame() {
  if (window.self === window.top) return true;
  const h = location.hostname;
  return /\.account\.sony\.com$/i.test(h) || /sonyentertainmentnetwork\.com$/i.test(h);
}

function fillValue(el, value) {
  const view = el.ownerDocument?.defaultView || window;
  const proto = view.HTMLInputElement?.prototype;
  const setter = proto
    ? Object.getOwnPropertyDescriptor(proto, "value")?.set
    : null;

  el.focus();
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new view.Event("change", { bubbles: true, composed: true }));
  el.dispatchEvent(new view.Event("blur", { bubbles: true, composed: true }));
}

async function ensureSigninPageFromLanding() {
  if (location.hostname.includes("playstation.com")) {
    const signInButton = await waitForElement(
      [
        ".web-toolbar__signin-button.psw-button.psw-b-0.psw-t-button.psw-l-line-center.psw-button-sizing.psw-button-sizing--small.psw-primary-button.psw-solid-button",
        "a.web-toolbar__signin-button",
        "button.web-toolbar__signin-button",
      ],
      30000,
    );
    if (!signInButton) throw new Error("Sign In button not found on landing page.");
    signInButton.click();
  }

  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (
      /my\.account\.sony\.com|sonyentertainmentnetwork/i.test(location.hostname) ||
      document.querySelector("#signin-entrance-input-signinId")
    ) {
      return;
    }
    await wait(400);
  }
  throw new Error("Did not reach PlayStation sign-in page.");
}

async function getJob() {
  const data = await chrome.storage.local.get(JOB_KEY);
  const job = data?.[JOB_KEY];
  if (!job) return null;
  if (typeof job.createdAt !== "number" || Date.now() - job.createdAt > JOB_MAX_AGE_MS) {
    await chrome.storage.local.remove(JOB_KEY);
    return null;
  }
  return job;
}

async function setJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
}

async function clearJob() {
  await chrome.storage.local.remove(JOB_KEY);
}

async function runLoginFlow(email, password) {
  if (!/playstation\.com|sony\.com|sonyentertainmentnetwork\.com/i.test(location.hostname)) {
    location.assign(HOME_URL);
    await wait(2500);
  }

  // Step A: if still on landing, click Sign In and let next page load continue.
  const landingBtn = findElementDeep([
    ".web-toolbar__signin-button.psw-button.psw-b-0.psw-t-button.psw-l-line-center.psw-button-sizing.psw-button-sizing--small.psw-primary-button.psw-solid-button",
    "a.web-toolbar__signin-button",
    "button.web-toolbar__signin-button",
  ]);
  if (landingBtn && location.hostname.includes("playstation.com")) {
    landingBtn.click();
    return { stage: "clicked-landing-signin" };
  }

  // Step B: email page.
  const emailInput = await waitForElement(
    ["#signin-entrance-input-signinId", "input[name='signinId']", "input[type='email']"],
    5000,
  );
  if (emailInput) {
    fillValue(emailInput, email);
    const nextBtn = await waitForElement(
      ["#signin-entrance-button", "button[type='submit']", "button"],
      5000,
    );
    if (!nextBtn) throw new Error("Next button not found.");
    nextBtn.click();
    return { stage: "submitted-email" };
  }

  // Step C: password page.
  const pwInput = await waitForElement(
    [
      "#signin-password-input-password",
      "input[name='password']",
      "input[type='password']",
      "#password",
      "input[autocomplete='current-password']",
    ],
    7000,
  );
  if (pwInput) {
    fillValue(pwInput, password);
    // Double-write to handle controlled inputs that overwrite first set.
    await wait(120);
    fillValue(pwInput, password);
    if ((pwInput.value ?? "") !== password) {
      throw new Error("Password field did not accept value.");
    }
    const signInBtn = await waitForElement(
      ["#signin-button", "button[type='submit']", "input[type='submit']", "button"],
      5000,
    );
    if (!signInBtn) throw new Error("Sign In submit button not found.");
    signInBtn.click();
    return { stage: "submitted-password" };
  }

  await ensureSigninPageFromLanding();
  return { stage: "waiting-navigation" };
}

async function fetchVerificationCode(verification) {
  if (!verification?.backendUrl) return null;
  // Use the service worker for fetch: avoids mixed-content / page CSP issues for http://127.0.0.1 from https Sony pages.
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "FETCH_SONY_VERIFICATION_CODE", verification },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        const data = response?.data;
        if (!response?.ok || !data?.ok) {
          resolve(null);
          return;
        }
        resolve(String(data.code || ""));
      },
    );
  });
}

const VERIFICATION_CODE_INPUT_SELECTORS = [
  "input[autocomplete='one-time-code']",
  "input[name*='code' i]",
  "input[name*='otp' i]",
  "input[name*='validation' i]",
  "input[id*='code' i]",
  "input[id*='otp' i]",
  "input[inputmode='numeric']",
  "input[type='tel']",
  "input[type='text'][maxlength='6']",
];

function shouldTryVerificationOnly() {
  const h = location.hostname;
  if (!/\.account\.sony\.com$/i.test(h) && !/sonyentertainmentnetwork\.com$/i.test(h)) {
    return false;
  }
  const emailEl = findElementDeep([
    "#signin-entrance-input-signinId",
    "input[name='signinId']",
    "input[type='email']",
  ]);
  const pwEl = findElementDeep([
    "#signin-password-input-password",
    "input[name='password']",
    "input[type='password']",
    "#password",
    "input[autocomplete='current-password']",
  ]);
  if (emailEl || pwEl) return false;
  return Boolean(findElementDeep(VERIFICATION_CODE_INPUT_SELECTORS));
}

async function runVerificationStep(verification) {
  const codeInput = await waitForElement(VERIFICATION_CODE_INPUT_SELECTORS, 20000);
  if (!codeInput) return { done: false };

  // Give Sony’s server time to send the email before polling IMAP.
  await wait(2000);

  const code = await fetchVerificationCode(verification);
  if (!code) throw new Error("Verification code not found from backend.");

  fillValue(codeInput, code);
  const verifyBtn = await waitForElement(
    ["button[type='submit']", "input[type='submit']", "button"],
    4000,
  );
  if (verifyBtn) verifyBtn.click();
  return { done: true };
}

async function processPendingJob() {
  if (!shouldRunAutomationInThisFrame()) return;
  if (running) return;
  running = true;
  try {
    const job = await getJob();
    if (!job?.email || !job?.password) return;

    if (job.verification?.backendUrl && shouldTryVerificationOnly()) {
      const v = await runVerificationStep(job.verification).catch(() => ({ done: false }));
      if (v.done) {
        await clearJob();
        return;
      }
    }

    const result = await runLoginFlow(job.email, job.password);
    // After password, either same tick (submitted-password) or next load (verification page → waiting-navigation).
    const shouldRunVerification =
      result.stage === "submitted-password" ||
      (Boolean(job.verification?.backendUrl) && result.stage === "waiting-navigation");
    if (shouldRunVerification) {
      const v = await runVerificationStep(job.verification).catch(() => ({ done: false }));
      if (v.done) {
        await clearJob();
      } else {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          processPendingJob().catch(() => {});
        }, 1200);
      }
    } else {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        processPendingJob().catch(() => {});
      }, 800);
    }
  } catch {
    // Keep job for retry on next navigation/load.
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      processPendingJob().catch(() => {});
    }, 1200);
  } finally {
    running = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RUN_PS_LOGIN_IN_TAB") return false;

  const { email, password, verification } = message.payload || {};
  if (!email || !password) {
    sendResponse({ ok: false, error: "Missing credentials." });
    return false;
  }

  // Respond immediately to avoid channel-close errors during navigation.
  sendResponse({ ok: true, message: "Login automation started." });

  setJob({ email, password, verification, createdAt: Date.now() })
    .then(() => processPendingJob())
    .catch(() => {});
  return false;
});

// Continue pending login automatically after redirects/page loads.
processPendingJob().catch(() => {});
window.addEventListener("load", () => processPendingJob().catch(() => {}));
window.addEventListener("pageshow", () => processPendingJob().catch(() => {}));
window.addEventListener("hashchange", () => processPendingJob().catch(() => {}));
window.addEventListener("popstate", () => processPendingJob().catch(() => {}));
const observer = new MutationObserver(() => {
  processPendingJob().catch(() => {});
});
observer.observe(document.documentElement, { childList: true, subtree: true });
