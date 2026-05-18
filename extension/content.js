const HOME_URL = "https://www.playstation.com/";
const JOB_KEY = "psAutoLoginJob";
const JOB_MAX_AGE_MS = 10 * 60 * 1000;
const EMAIL_NEXT_COOLDOWN_MS = 5000;
/** Avoid hammering "Sign In" while the SPA is still on the same URL (MutationObserver + React updates). */
const LANDING_SIGNIN_COOLDOWN_MS = 10000;
const HOME_REDIRECT_COOLDOWN_MS = 12000;
const MUTATION_DEBOUNCE_MS = 320;
/** One slice waiting for the signed-in profile control (retries via processPendingJob). */
const PROFILE_TOGGLER_WAIT_MS = 10000;
const PROFILE_TOGGLER_POLL_MS = 80;
/** Account settings link in profile dropdown (per processPendingJob slice). */
const ACCOUNT_SETTINGS_LINK_WAIT_MS = 15000;
/** Sign out control on store toolbar (per slice). */
const SIGNOUT_BUTTON_WAIT_MS = 15000;
/** Messages / profile entry on account management page. */
const MSG_PROFILE_PAGE_TIMEOUT_MS = 52000;
const MSG_PROFILE_SETTLE_MS = 650;
/** After Verify, wait until OTP view clears or storefront profile appears. */
const TWO_FACTOR_CLEAR_TIMEOUT_MS = 28000;
/** After clicking profile (dropdown-toggler), wait then hard-navigate to playstation.com home. */
const PROFILE_CLICK_THEN_STORE_REDIRECT_WAIT_MS = 5000;
/** After clicking Messages (`msg_profile`) on account management, before sign-out phase. */
const MSG_PROFILE_POST_CLICK_WAIT_MS = 5000;
/** Background navigates tab to store after sign-out (content script may unload before `location.assign`). */
const POST_SIGNOUT_TAB_NAVIGATE_HOME_MS = 650;
/** Poll Sign out in dropdown right after toggler click (one rAF tick). */
const SIGNOUT_AFTER_TOGGLE_POLL_MS = 16;
/** After opening profile menu, wait before resolving Account settings link. */
const PROFILE_MENU_OPEN_BEFORE_ACCOUNT_SETTINGS_MS = 900;
/** Wait for 2FA / backup code field on Sony auth. */
const VERIFICATION_INPUT_WAIT_MS = 34000;
let running = false;

/** Toolbar profile menu when signed in (Sony changes `data-qa` often — keep fallbacks). */
const PROFILE_TOGGLER_SELECTORS = [
  '[data-qa="web-toolbar#profile-container#profile-icon#dropdown-toggler"]',
  '[data-qa*="profile-container#profile-icon#dropdown-toggler"]',
  '[data-qa*="profile-icon#dropdown-toggler"]',
  '[data-qa*="dropdown-toggler"][data-qa*="profile"]',
  'header button[aria-label*="Account" i]',
  'header a[aria-label*="Account" i]',
  'button[aria-label*="Account menu" i]',
  'a[aria-label*="Account menu" i]',
];

let retryTimer = null;
let mutationDebounceTimer = null;
let lastHomeRedirectAt = 0;

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
    await wait(220);
  }
  return null;
}

/** Toolbar / dropdown nodes are often present before strict "interactable" (opacity, etc.). */
async function waitForPostLoginElement(selectors, timeoutMs = 45000, pollMs = 280) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let el = findElementDeep(selectors);
    if (!el) el = findElementDeepRelaxed(selectors);
    if (el) return el;
    await wait(pollMs);
  }
  return null;
}

async function ensurePlaystationComForToolbar() {
  if (/playstation\.com/i.test(location.hostname)) {
    return true;
  }
  const now = Date.now();
  if (now - lastHomeRedirectAt < HOME_REDIRECT_COOLDOWN_MS) {
    await wait(600);
    return /playstation\.com/i.test(location.hostname);
  }
  lastHomeRedirectAt = now;
  location.assign(HOME_URL);
  await wait(2200);
  return /playstation\.com/i.test(location.hostname);
}

/**
 * SPA links sometimes ignore programmatic click; if URL unchanged, hard-navigate using href.
 */
async function clickAccountSettingsWithHrefFallback(el) {
  let dest = null;
  if (el instanceof HTMLAnchorElement && el.href) {
    dest = el.href;
  } else {
    const a = el.closest?.("a");
    if (a?.href) dest = a.href;
    else {
      const h = el.getAttribute?.("href");
      if (h && /^https?:\/\//i.test(h)) dest = h;
    }
  }
  const before = location.href;
  try {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  } catch {
    // ignore
  }
  await wait(120);
  el.click();
  await wait(2200);
  if (dest && String(dest).startsWith("http") && location.href === before) {
    location.assign(dest);
    await wait(1400);
  }
}

/** Like isInteractableField but ignores opacity (SPA shells often animate opacity). */
function isVisibleDomNode(el) {
  if (!el || el.disabled) return false;
  const view = el.ownerDocument?.defaultView;
  if (!view) return false;
  const s = view.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.pointerEvents === "none") return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= 2 && rect.height >= 2;
}

function findElementDeepRelaxed(selectors, rootDoc = document) {
  for (const selector of selectors) {
    const el = rootDoc.querySelector(selector);
    if (el && isVisibleDomNode(el)) {
      return el;
    }
  }
  const iframes = rootDoc.querySelectorAll("iframe");
  for (const frame of iframes) {
    try {
      const childDoc = frame.contentDocument;
      if (!childDoc) continue;
      const inFrame = findElementDeepRelaxed(selectors, childDoc);
      if (inFrame) return inFrame;
    } catch {
      // Cross-origin frame
    }
  }
  return null;
}

/**
 * `querySelector` does not pierce shadow roots; the store header often hosts the profile control
 * inside web components.
 */
function querySelectorIncludingShadow(selector, root = document) {
  const queue = [];
  if (root.nodeType === 9) {
    if (root.documentElement) queue.push(root.documentElement);
  } else {
    queue.push(root);
  }
  while (queue.length) {
    const node = queue.shift();
    if (!node) continue;
    if (node.nodeType === 1) {
      try {
        if (node.matches?.(selector)) return node;
        const inner = node.querySelector?.(selector);
        if (inner) return inner;
      } catch {
        // ignore
      }
      const sr = node.shadowRoot;
      if (sr) queue.push(sr);
      for (const ch of node.children || []) queue.push(ch);
    } else if (node.nodeType === 11) {
      try {
        const inner = node.querySelector?.(selector);
        if (inner) return inner;
      } catch {
        // ignore
      }
      for (const ch of node.children || []) queue.push(ch);
    }
  }
  return null;
}

/** `data-qa` may be on a wrapper; prefer the actual button / link / [role=button]. */
function resolveProfileTogglerClickTarget(el) {
  if (!el || el.disabled) return null;
  const tag = el.tagName?.toLowerCase();
  if (tag === "button" || tag === "a" || el.getAttribute?.("role") === "button") {
    return el;
  }
  const inner = el.querySelector?.(
    "button:not([disabled]), a:not([disabled]), [role='button']:not([disabled]), [role=button]:not([disabled])",
  );
  if (inner) return inner;
  return el;
}

function clickProfileDropdownToggler(toggler) {
  const target = resolveProfileTogglerClickTarget(toggler);
  if (!target) return;
  const doc = target.ownerDocument || document;
  const view = doc.defaultView || window;
  try {
    target.focus?.({ preventScroll: true });
  } catch {
    // ignore
  }
  try {
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  } catch {
    // ignore
  }
  const rect = target.getBoundingClientRect();
  let elToClick = target;
  if (rect.width > 0 && rect.height > 0) {
    const cx = Math.min(rect.right - 1, Math.max(rect.left + 1, rect.left + rect.width / 2));
    const cy = Math.min(rect.bottom - 1, Math.max(rect.top + 1, rect.top + rect.height / 2));
    const hit = doc.elementFromPoint?.(cx, cy);
    if (hit && (hit === target || target.contains(hit))) {
      elToClick = hit;
    }
  }
  const base = { bubbles: true, cancelable: true, composed: true, view };
  try {
    elToClick.dispatchEvent(
      new view.PointerEvent("pointerdown", {
        ...base,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
  } catch {
    elToClick.dispatchEvent(new view.MouseEvent("mousedown", base));
  }
  try {
    elToClick.dispatchEvent(
      new view.PointerEvent("pointerup", {
        ...base,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
  } catch {
    elToClick.dispatchEvent(new view.MouseEvent("mouseup", base));
  }
  elToClick.click();
}

function findPlaystationProfileTogglerInDocument(rootDoc = document) {
  for (const sel of PROFILE_TOGGLER_SELECTORS) {
    const el = querySelectorIncludingShadow(sel, rootDoc);
    if (el && (isVisibleDomNode(el) || isInteractableField(el))) {
      return el;
    }
  }
  const relaxed = findElementDeepRelaxed(PROFILE_TOGGLER_SELECTORS, rootDoc);
  if (relaxed) return relaxed;
  return findElementDeep(PROFILE_TOGGLER_SELECTORS, rootDoc);
}

function findPlaystationProfileToggler(rootDoc = document) {
  const local = findPlaystationProfileTogglerInDocument(rootDoc);
  if (local) return local;
  const iframes = rootDoc.querySelectorAll("iframe");
  for (const frame of iframes) {
    try {
      const childDoc = frame.contentDocument;
      if (!childDoc) continue;
      const inner = findPlaystationProfileToggler(childDoc);
      if (inner) return inner;
    } catch {
      // Cross-origin frame
    }
  }
  return null;
}

async function waitForPlaystationProfileToggler(timeoutMs, pollMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = findPlaystationProfileToggler();
    if (el) return el;
    await wait(pollMs);
  }
  return null;
}

/** Open menu unless an ancestor already has aria-expanded="true". */
function shouldClickProfileTogglerToOpenMenu(toggler) {
  let el = toggler;
  for (let i = 0; i < 12 && el; i++) {
    const v = el.getAttribute?.("aria-expanded");
    if (v === "true") return false;
    if (v === "false") return true;
    el = el.parentElement;
  }
  return true;
}

function findAccountSettingsLinkInDocument(rootDoc = document) {
  for (const sel of ACCOUNT_SETTINGS_LINK_SELECTORS) {
    const el = querySelectorIncludingShadow(sel, rootDoc);
    if (el && (isVisibleDomNode(el) || isInteractableField(el))) {
      return el;
    }
  }
  const relaxed = findElementDeepRelaxed(ACCOUNT_SETTINGS_LINK_SELECTORS, rootDoc);
  if (relaxed) return relaxed;
  return findElementDeep(ACCOUNT_SETTINGS_LINK_SELECTORS, rootDoc);
}

function findAccountSettingsLink(rootDoc = document) {
  const local = findAccountSettingsLinkInDocument(rootDoc);
  if (local) return local;
  const iframes = rootDoc.querySelectorAll("iframe");
  for (const frame of iframes) {
    try {
      const childDoc = frame.contentDocument;
      if (!childDoc) continue;
      const inner = findAccountSettingsLink(childDoc);
      if (inner) return inner;
    } catch {
      // Cross-origin frame
    }
  }
  return null;
}

async function waitForAccountSettingsLink(timeoutMs, pollMs = 100) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = findAccountSettingsLink();
    if (el) return el;
    await wait(pollMs);
  }
  return null;
}

function findSignOutButtonInDocument(rootDoc = document) {
  for (const sel of SIGNOUT_EXACT_SELECTORS) {
    const el = querySelectorIncludingShadow(sel, rootDoc);
    if (el && (isVisibleDomNode(el) || isInteractableField(el))) {
      return el;
    }
  }
  for (const sel of SIGNOUT_BUTTON_FALLBACK_SELECTORS) {
    const el = querySelectorIncludingShadow(sel, rootDoc);
    if (el && (isVisibleDomNode(el) || isInteractableField(el))) {
      return el;
    }
  }
  const relaxed = findElementDeepRelaxed(
    [...SIGNOUT_EXACT_SELECTORS, ...SIGNOUT_BUTTON_FALLBACK_SELECTORS],
    rootDoc,
  );
  if (relaxed) return relaxed;
  return findElementDeep([...SIGNOUT_EXACT_SELECTORS, ...SIGNOUT_BUTTON_FALLBACK_SELECTORS], rootDoc);
}

function findSignOutButton(rootDoc = document) {
  const local = findSignOutButtonInDocument(rootDoc);
  if (local) return local;
  const iframes = rootDoc.querySelectorAll("iframe");
  for (const frame of iframes) {
    try {
      const childDoc = frame.contentDocument;
      if (!childDoc) continue;
      const inner = findSignOutButton(childDoc);
      if (inner) return inner;
    } catch {
      // Cross-origin frame
    }
  }
  return null;
}

async function waitForSignOutButtonImmediatelyAfterToggle(timeoutMs, pollMs = SIGNOUT_AFTER_TOGGLE_POLL_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = findSignOutButton();
    if (el) return el;
    await wait(pollMs);
  }
  return null;
}

/**
 * Sign out on www.playstation.com: open profile menu then resolve Sign out (tight poll).
 */
async function openStorefrontProfileMenuAndFindSignOutControl() {
  const onStore = await ensurePlaystationComForToolbar();
  if (!onStore) return null;
  const toggler = await waitForPlaystationProfileToggler(PROFILE_TOGGLER_WAIT_MS, PROFILE_TOGGLER_POLL_MS);
  if (!toggler) return null;
  clickProfileDropdownToggler(toggler);
  for (let i = 0; i < 12; i++) {
    const instant = findSignOutButton();
    if (instant) return instant;
    await wait(0);
  }
  return waitForSignOutButtonImmediatelyAfterToggle(SIGNOUT_BUTTON_WAIT_MS, SIGNOUT_AFTER_TOGGLE_POLL_MS);
}

/** Sony sign-in / 2FA can use regional hosts (e.g. ca.account.sony.com), not only my.account.sony.com. */
function isSonyAccountOrSigninHost(hostname = location.hostname) {
  const h = String(hostname || "").toLowerCase();
  if (/sonyentertainmentnetwork\.com$/i.test(h)) return true;
  if (/account\.sony\.com$/i.test(h)) return true;
  return false;
}

async function waitForDocumentComplete(timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (document.readyState === "complete") {
      return;
    }
    await wait(120);
  }
}

/**
 * After navigating to the account area: wait for document complete, settle, then the
 * msg control — prefers strict interactable; otherwise visible in DOM for several polls.
 */
async function waitForMsgProfileAfterAccountPageLoad(overallTimeoutMs = MSG_PROFILE_PAGE_TIMEOUT_MS) {
  await waitForDocumentComplete(Math.min(90000, overallTimeoutMs));
  await wait(MSG_PROFILE_SETTLE_MS);

  const deadline = Date.now() + overallTimeoutMs;
  const started = Date.now();
  let interactableStreak = 0;
  let relaxedStreak = 0;

  while (Date.now() < deadline) {
    if (document.readyState !== "complete") {
      interactableStreak = 0;
      relaxedStreak = 0;
      await wait(200);
      continue;
    }

    const strict = findElementDeep(MSG_PROFILE_SELECTORS);
    const relaxed = findElementDeepRelaxed(MSG_PROFILE_SELECTORS);
    const el = strict || relaxed;
    if (!el) {
      interactableStreak = 0;
      relaxedStreak = 0;
      await wait(280);
      continue;
    }

    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } catch {
      // ignore
    }
    await wait(250);

    const el2 = findElementDeep(MSG_PROFILE_SELECTORS) || findElementDeepRelaxed(MSG_PROFILE_SELECTORS);
    if (!el2) {
      interactableStreak = 0;
      relaxedStreak = 0;
      await wait(280);
      continue;
    }

    if (isInteractableField(el2)) {
      interactableStreak += 1;
      relaxedStreak = 0;
      if (interactableStreak >= 2) {
        return el2;
      }
    } else if (isVisibleDomNode(el2)) {
      relaxedStreak += 1;
      interactableStreak = 0;
      if (relaxedStreak >= 4 && Date.now() - started > 6000) {
        return el2;
      }
    } else {
      interactableStreak = 0;
      relaxedStreak = 0;
    }
    await wait(280);
  }

  const fallback = findElementDeep(MSG_PROFILE_SELECTORS) || findElementDeepRelaxed(MSG_PROFILE_SELECTORS);
  if (fallback) {
    try {
      fallback.scrollIntoView({ block: "center", behavior: "instant" });
    } catch {
      // ignore
    }
    await wait(280);
  }
  return fallback;
}

/** Avoid duplicate jobs: subframes run only when the auth UI lives in that frame. */
function shouldRunAutomationInThisFrame() {
  if (window.self === window.top) return true;
  const h = location.hostname;
  return isSonyAccountOrSigninHost(h);
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

/** React/MUI often needs InputEvent after native value set for controlled OTP fields. */
function fillOtpValue(el, value) {
  const view = el.ownerDocument?.defaultView || window;
  const code = String(value ?? "");
  fillValue(el, code);
  try {
    el.dispatchEvent(
      new view.InputEvent("input", {
        bubbles: true,
        composed: true,
        cancelable: true,
        inputType: "insertFromPaste",
        data: code,
      }),
    );
  } catch {
    try {
      el.dispatchEvent(
        new view.InputEvent("input", {
          bubbles: true,
          composed: true,
          cancelable: true,
          inputType: "insertText",
          data: code,
        }),
      );
    } catch {
      // ignore
    }
  }
}

const OTP_CODE_ALNUM = /[^A-Za-z0-9]/g;
const OTP_CODE_MAX_LEN = 32;

function sanitizeOtpCodeString(raw) {
  return String(raw ?? "").replace(OTP_CODE_ALNUM, "");
}

function getManualOtpCode(account) {
  const code = sanitizeOtpCodeString(account?.otpCode);
  if (code.length < 6) return null;
  return code.slice(0, OTP_CODE_MAX_LEN);
}

/** RFC 6238 TOTP from Base32 secret (see totp.js, globalThis.psTotpGenerate). */
async function totpCodeFromSecret(secret) {
  const raw = String(secret || "").trim();
  if (!raw) {
    throw new Error("OTP secret is missing.");
  }
  if (typeof globalThis.psTotpGenerate !== "function") {
    throw new Error("TOTP helper (totp.js) is not loaded.");
  }
  return globalThis.psTotpGenerate(raw, 6, 30);
}

async function ensureSigninPageFromLanding(options = {}) {
  const allowToolbarSignInClick = options.allowToolbarSignInClick !== false;
  const signInToolbarSelectors = [
    ".web-toolbar__signin-button.psw-button.psw-b-0.psw-t-button.psw-l-line-center.psw-button-sizing.psw-button-sizing--small.psw-primary-button.psw-solid-button",
    "a.web-toolbar__signin-button",
    "button.web-toolbar__signin-button",
  ];

  if (location.hostname.includes("playstation.com") && allowToolbarSignInClick) {
    const pollDeadline = Date.now() + 32000;
    let clickedToolbarSignIn = false;
    while (Date.now() < pollDeadline) {
      if (findPlaystationProfileToggler()) {
        return;
      }
      if (
        isSonyAccountOrSigninHost() ||
        document.querySelector("#signin-entrance-input-signinId")
      ) {
        return;
      }
      if (findVerificationCodeInput()) {
        return;
      }
      const signInButton = findElementDeep(signInToolbarSelectors);
      if (signInButton) {
        signInButton.click();
        clickedToolbarSignIn = true;
        break;
      }
      await wait(280);
    }
  }

  const started = Date.now();
  while (Date.now() - started < 32000) {
    if (findVerificationCodeInput()) {
      return;
    }
    if (isSonyAccountOrSigninHost() || document.querySelector("#signin-entrance-input-signinId")) {
      return;
    }
    if (location.hostname.includes("playstation.com") && findPlaystationProfileToggler()) {
      return;
    }
    await wait(280);
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

function clearAutomationTimers() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (mutationDebounceTimer) {
    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = null;
  }
}

async function stopAutomation() {
  clearAutomationTimers();
  running = false;
  await clearJob();
}

/**
 * Writes the next account (or clears the job) to storage **before** sign-out navigation,
 * which can unload this document before any `await` after `click()` runs.
 * @returns {"advanced"|"cleared"}
 */
async function persistNextAccountJobAfterSignOut(jobHint) {
  const data = await chrome.storage.local.get(JOB_KEY);
  const fresh = data?.[JOB_KEY] || jobHint;
  if (!Array.isArray(fresh?.accounts) || fresh.accounts.length === 0) {
    await clearJob();
    return "cleared";
  }
  const curIdx = Number(fresh.currentIndex) || 0;
  const nextIdx = curIdx + 1;
  if (nextIdx >= fresh.accounts.length) {
    await clearJob();
    return "cleared";
  }
  const accountsCopy = fresh.accounts.map((a) => ({ ...a }));
  lastHomeRedirectAt = 0;
  await setJob({
    ...fresh,
    accounts: accountsCopy,
    currentIndex: nextIdx,
    phase: "login",
    emailNextClickedAt: 0,
    landingSignInClickedAt: 0,
    requireStorefrontSignIn: true,
    createdAt: Date.now(),
  });
  return "advanced";
}

async function runLoginFlow(email, password, flowOptions = {}) {
  const skipLandingToolbarClick = Boolean(flowOptions.skipLandingToolbarClick);
  const requireStorefrontSignIn = Boolean(flowOptions.requireStorefrontSignIn);

  if (!/playstation\.com|sony\.com|sonyentertainmentnetwork\.com/i.test(location.hostname)) {
    const now = Date.now();
    if (now - lastHomeRedirectAt < HOME_REDIRECT_COOLDOWN_MS) {
      await wait(450);
      return { stage: "waiting-navigation" };
    }
    lastHomeRedirectAt = now;
    location.assign(HOME_URL);
    await wait(1900);
  }

  if (
    !requireStorefrontSignIn &&
    location.hostname.includes("playstation.com") &&
    findPlaystationProfileToggler()
  ) {
    return { stage: "storefront-signed-in" };
  }

  // Step A: if still on landing, click Sign In and let next page load continue.
  const landingBtn = findElementDeep([
    ".web-toolbar__signin-button.psw-button.psw-b-0.psw-t-button.psw-l-line-center.psw-button-sizing.psw-button-sizing--small.psw-primary-button.psw-solid-button",
    "a.web-toolbar__signin-button",
    "button.web-toolbar__signin-button",
  ]);
  if (landingBtn && location.hostname.includes("playstation.com") && !skipLandingToolbarClick) {
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
    await wait(80);
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

  await ensureSigninPageFromLanding({
    allowToolbarSignInClick: !skipLandingToolbarClick,
  });
  return { stage: "waiting-navigation" };
}

const VERIFICATION_CODE_INPUT_SELECTORS = [
  "input[autocomplete='one-time-code']",
  "input[autocomplete='tel-national']",
  "input[name='otp' i]",
  "input[name='otpCode' i]",
  "input[name='devicePasscode' i]",
  "input[name='twoFactorCode' i]",
  "input[name*='code' i]",
  "input[name*='otp' i]",
  "input[name*='validation' i]",
  "input[id*='code' i]",
  "input[id*='otp' i]",
  "input[id*='validation' i]",
  "input[aria-label*='code' i]",
  "input[aria-label*='verification' i]",
  "input[placeholder*='code' i]",
  "input[type='tel'][maxlength='6']",
  "input[type='text'][inputmode='numeric'][maxlength='6']",
  "input[inputmode='numeric'][maxlength='6']",
  "input[type='text'][maxlength='6']",
  "input[inputmode='numeric']",
  "input[type='tel']",
  "#\\:r9\\:",
  "#\\:r8\\:",
  "#\\:r7\\:",
  "#\\:r6\\:",
  "#\\:r5\\:",
  "#\\:r4\\:",
  "#\\:r3\\:",
  "#\\:r2\\:",
  "#\\:r1\\:",
  "#\\:r0\\:",
];

function findVerificationCodeInput(rootDoc = document) {
  const relaxed = findElementDeepRelaxed(VERIFICATION_CODE_INPUT_SELECTORS, rootDoc);
  if (relaxed) return relaxed;
  return findElementDeep(VERIFICATION_CODE_INPUT_SELECTORS, rootDoc);
}

async function waitForVerificationCodeInput(timeoutMs = VERIFICATION_INPUT_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = findVerificationCodeInput();
    if (el) return el;
    await wait(170);
  }
  return null;
}

const TRUST_BROWSER_CHECKBOX_SELECTORS = [
  "#input-19",
  "input[id='input-19']",
  "input[type='checkbox'][name*='trust' i]",
  "input[type='checkbox'][id*='trust' i]",
];

const VERIFY_BUTTON_SELECTORS = [
  // User-provided class pattern
  "button.button--primary-disabled--vRBMt.psw-m-t-5.psw-button.psw-b-0.psw-t-button.psw-l-line-center.psw-button-sizing.psw-button-sizing--medium.psw-primary-button.psw-solid-button",
  "button.psw-primary-button.psw-solid-button",
  "button[class*='button--primary'][class*='psw-primary-button']",
  "button[type='submit']",
  "input[type='submit']",
  "button",
];

const ACCOUNT_SETTINGS_LINK_SELECTORS = [
  '[data-qa="web-toolbar#profile-container#profile-dropdown#item-list#account-settings#link"]',
  '[data-track-click="web:select-account-menu-item"]',
  'a[href*="account-management" i]',
  '[data-qa*="profile-dropdown#item-list#account-settings#link"]',
  '[data-qa*="account-settings#link"]',
  'a[href*="acct/management" i]',
  'button[aria-label*="Account settings" i]',
  'a[aria-label*="Account settings" i]',
];

/** User-specified `data-daq-button`; `data-dqa-button` kept as fallback (Sony naming varies). */
const MSG_PROFILE_SELECTORS = [
  '[data-dqa-button="msg_profile"]',
  '[data-daq-button="msg_profile"]',
];

/** PlayStation profile dropdown — Sign out (exact storefront markup). */
const SIGNOUT_EXACT_SELECTORS = [
  '[data-qa="web-toolbar#profile-container#profile-dropdown#item-list#sign-out#button"][data-track-click="web:select-sign-out"]',
  '[data-qa="web-toolbar#profile-container#profile-dropdown#item-list#sign-out#button"]',
  '[data-track-click="web:select-sign-out"]',
];

const SIGNOUT_BUTTON_FALLBACK_SELECTORS = [
  '[data-dqa-button="signout"]',
  '[data-daq-button="signout"]',
  '[data-qa*="signout" i]',
  'button[aria-label*="Sign out" i]',
  'a[aria-label*="Sign out" i]',
];

/**
 * 2FA is finished when the OTP-only Sony view is gone, or when we are already on
 * playstation.com with the signed-in profile control (TOTP often redirects here before
 * the OTP field disappears from the tree in the auth tab).
 */
function isPastTwoFactorStep() {
  if (!shouldTryVerificationOnly()) {
    return true;
  }
  if (/playstation\.com/i.test(location.hostname)) {
    if (findPlaystationProfileToggler()) {
      return true;
    }
  }
  return false;
}

async function waitUntilPastTwoFactor(maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (isPastTwoFactorStep()) {
      return true;
    }
    await wait(280);
  }
  return isPastTwoFactorStep();
}

function ensureChecked(checkbox) {
  if (!checkbox) return;
  if (checkbox.checked) return;
  checkbox.click();
}

function getCurrentAccount(job) {
  if (!job) return null;
  if (Array.isArray(job.accounts) && job.accounts.length > 0) {
    const idx = Math.min(Math.max(0, Number(job.currentIndex) || 0), job.accounts.length - 1);
    return job.accounts[idx] || null;
  }
  return job.account || null;
}

function normalizeJobAccount(acc) {
  if (!acc?.email || !acc?.password) return null;
  const mode = acc.otpInputMode === "code" ? "code" : "secret";
  if (mode === "code") {
    const code = getManualOtpCode(acc);
    if (!code) return null;
    return { ...acc, otpInputMode: "code", otpCode: code };
  }
  if (!String(acc.verificationSecret || "").trim()) return null;
  return { ...acc, otpInputMode: "secret" };
}

function getJobAccount(job) {
  return normalizeJobAccount(getCurrentAccount(job));
}

function accountHasOtpCredentials(account) {
  if (!account) return false;
  if (account.otpInputMode === "code") {
    return Boolean(getManualOtpCode(account));
  }
  return Boolean(String(account.verificationSecret || "").trim());
}

function shouldTryVerificationOnly() {
  if (!isSonyAccountOrSigninHost()) return false;
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
  return Boolean(findVerificationCodeInput());
}

async function runVerificationStep(account) {
  await wait(320);
  const codeInput = await waitForVerificationCodeInput();
  if (!codeInput) return { done: false };

  try {
    codeInput.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  } catch {
    // ignore
  }
  await wait(140);

  const trustBrowserCheckbox = await waitForElement(TRUST_BROWSER_CHECKBOX_SELECTORS, 2200);
  if (trustBrowserCheckbox) {
    ensureChecked(trustBrowserCheckbox);
  }

  const mode = account?.otpInputMode === "code" ? "code" : "secret";
  let code;
  if (mode === "code") {
    const manual = getManualOtpCode(account);
    if (!manual) return { done: false };
    code = manual;
  } else {
    code = await totpCodeFromSecret(account.verificationSecret);
  }

  fillOtpValue(codeInput, code);
  await wait(80);
  fillOtpValue(codeInput, code);
  await wait(130);
  const verifyBtn = await waitForElement(VERIFY_BUTTON_SELECTORS, 4200);
  if (verifyBtn) verifyBtn.click();
  const cleared = await waitUntilPastTwoFactor(TWO_FACTOR_CLEAR_TIMEOUT_MS);
  if (cleared) {
    return { done: true };
  }
  return { done: false };
}

async function processPendingJob() {
  if (!shouldRunAutomationInThisFrame()) return;
  if (running) return;
  running = true;
  try {
    const job = await getJob();
    const account = getJobAccount(job);
    if (!account) return;

    if (job.phase !== "login" && window.self !== window.top) return;

    if (job.phase === "post_login_profile_toggle") {
      const onStore = await ensurePlaystationComForToolbar();
      if (!onStore) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          processPendingJob().catch(() => {});
        }, 1300);
        return;
      }
      await wait(250);
      const toggler = await waitForPlaystationProfileToggler(
        PROFILE_TOGGLER_WAIT_MS,
        PROFILE_TOGGLER_POLL_MS,
      );
      if (!toggler) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          processPendingJob().catch(() => {});
        }, 900);
        return;
      }
      await wait(150);
      clickProfileDropdownToggler(toggler);
      await wait(PROFILE_CLICK_THEN_STORE_REDIRECT_WAIT_MS);
      await setJob({
        ...job,
        phase: "post_login_account_settings",
        createdAt: Date.now(),
      });
      lastHomeRedirectAt = 0;
      location.assign(HOME_URL);
      return;
    }

    if (job.phase === "post_login_account_settings") {
      const onStore = await ensurePlaystationComForToolbar();
      if (!onStore) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          processPendingJob().catch(() => {});
        }, 1300);
        return;
      }
      await wait(250);
      const toggler = await waitForPlaystationProfileToggler(
        PROFILE_TOGGLER_WAIT_MS,
        PROFILE_TOGGLER_POLL_MS,
      );
      if (!toggler) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          processPendingJob().catch(() => {});
        }, 900);
        return;
      }
      if (shouldClickProfileTogglerToOpenMenu(toggler)) {
        await wait(150);
        clickProfileDropdownToggler(toggler);
      }
      await wait(PROFILE_MENU_OPEN_BEFORE_ACCOUNT_SETTINGS_MS);
      const settingsLink = await waitForAccountSettingsLink(ACCOUNT_SETTINGS_LINK_WAIT_MS, PROFILE_TOGGLER_POLL_MS);
      if (!settingsLink) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          processPendingJob().catch(() => {});
        }, 1300);
        return;
      }
      await setJob({
        ...job,
        phase: "post_login_messages",
        createdAt: Date.now(),
      });
      await clickAccountSettingsWithHrefFallback(settingsLink);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        processPendingJob().catch(() => {});
      }, 1900);
      return;
    }

    if (job.phase === "post_login_messages") {
      const msgBtn = await waitForMsgProfileAfterAccountPageLoad(MSG_PROFILE_PAGE_TIMEOUT_MS);
      if (!msgBtn) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          processPendingJob().catch(() => {});
        }, 1300);
        return;
      }
      try {
        msgBtn.scrollIntoView({ block: "center", behavior: "instant" });
      } catch {
        // ignore
      }
      await wait(210);
      msgBtn.click();
      await wait(MSG_PROFILE_POST_CLICK_WAIT_MS);
      await setJob({
        ...job,
        phase: "post_login_signout",
        createdAt: Date.now(),
      });
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        processPendingJob().catch(() => {});
      }, 0);
      return;
    }

    if (job.phase === "post_login_signout") {
      const signOutBtn = await openStorefrontProfileMenuAndFindSignOutControl();
      if (!signOutBtn) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          processPendingJob().catch(() => {});
        }, 1300);
        return;
      }
      const prior = (await getJob()) || job;
      const advanceOutcome = await persistNextAccountJobAfterSignOut(prior);
      if (advanceOutcome === "advanced") {
        let navTabId;
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          navTabId = tabs[0]?.id;
        } catch {
          navTabId = undefined;
        }
        try {
          chrome.runtime.sendMessage({
            type: "PS_ENSURE_HOME_AFTER_SIGNOUT",
            url: HOME_URL,
            delayMs: POST_SIGNOUT_TAB_NAVIGATE_HOME_MS,
            tabId: navTabId,
          });
        } catch {
          lastHomeRedirectAt = 0;
          location.assign(HOME_URL);
        }
      }
      signOutBtn.click();
      return;
    }

    if (accountHasOtpCredentials(account) && shouldTryVerificationOnly()) {
      const v = await runVerificationStep(account).catch(() => ({ done: false }));
      if (v.done) {
        await setJob({
          ...job,
          phase: "post_login_profile_toggle",
          emailNextClickedAt: 0,
          requireStorefrontSignIn: false,
          createdAt: Date.now(),
        });
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          processPendingJob().catch(() => {});
        }, 750);
        return;
      }
    }

    const emailNextClickedAt = Number(job.emailNextClickedAt || 0);
    if (emailNextClickedAt > 0 && Date.now() - emailNextClickedAt < EMAIL_NEXT_COOLDOWN_MS) {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        processPendingJob().catch(() => {});
      }, 600);
      return;
    }

    const landingSignInClickedAt = Number(job.landingSignInClickedAt || 0);
    const skipLandingToolbarClick =
      landingSignInClickedAt > 0 &&
      Date.now() - landingSignInClickedAt < LANDING_SIGNIN_COOLDOWN_MS;

    const result = await runLoginFlow(account.email, account.password, {
      skipLandingToolbarClick,
      requireStorefrontSignIn: job.requireStorefrontSignIn === true,
    });
    if (result.stage === "clicked-landing-signin") {
      await setJob({
        ...job,
        landingSignInClickedAt: Date.now(),
        requireStorefrontSignIn: false,
        createdAt: Date.now(),
      });
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        processPendingJob().catch(() => {});
      }, 1100);
      return;
    }
    if (result.stage === "storefront-signed-in") {
      await setJob({
        ...job,
        phase: "post_login_profile_toggle",
        emailNextClickedAt: 0,
        landingSignInClickedAt: 0,
        requireStorefrontSignIn: false,
        createdAt: Date.now(),
      });
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        processPendingJob().catch(() => {});
      }, 550);
      return;
    }
    if (result.stage === "submitted-email") {
      await setJob({
        ...job,
        emailNextClickedAt: Date.now(),
        requireStorefrontSignIn: false,
        createdAt: Date.now(),
      });
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        processPendingJob().catch(() => {});
      }, 800);
      return;
    }

    // After password, either same tick (submitted-password) or next load (verification page → waiting-navigation).
    const shouldRunVerification =
      result.stage === "submitted-password" ||
      (accountHasOtpCredentials(account) && result.stage === "waiting-navigation");
    if (shouldRunVerification) {
      const v = await runVerificationStep(account).catch(() => ({ done: false }));
      if (v.done) {
        await setJob({
          ...job,
          phase: "post_login_profile_toggle",
          emailNextClickedAt: 0,
          landingSignInClickedAt: 0,
          requireStorefrontSignIn: false,
          createdAt: Date.now(),
        });
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          processPendingJob().catch(() => {});
        }, 750);
      } else {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          processPendingJob().catch(() => {});
        }, 750);
      }
    } else {
      if (retryTimer) clearTimeout(retryTimer);
      const backoff =
        result.stage === "waiting-navigation" && skipLandingToolbarClick ? 1100 : 550;
      retryTimer = setTimeout(() => {
        processPendingJob().catch(() => {});
      }, backoff);
    }
  } catch {
    // Keep job for retry on next navigation/load.
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      processPendingJob().catch(() => {});
    }, 800);
  } finally {
    running = false;
  }
}

function validateAccountPayload(account, indexLabel) {
  const prefix = indexLabel ? `${indexLabel}: ` : "";
  if (!account?.email || !account?.password) {
    return `${prefix}Account needs email and password.`;
  }
  const otpMode = account.otpInputMode === "code" ? "code" : "secret";
  if (otpMode === "code") {
    if (!getManualOtpCode(account)) {
      return `${prefix}Enter one OTP code (6+ letters or digits).`;
    }
  } else if (!String(account.verificationSecret || "").trim()) {
    return `${prefix}Enter the TOTP secret, or choose OTP code mode.`;
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "STOP_PS_LOGIN_IN_TAB") {
    void stopAutomation()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: "Failed to stop automation." }));
    return true;
  }

  if (message?.type !== "RUN_PS_LOGIN_IN_TAB") return false;

  const p = message.payload;
  const accounts =
    Array.isArray(p?.accounts) && p.accounts.length > 0
      ? p.accounts
      : p?.account
        ? [p.account]
        : [];

  if (accounts.length === 0) {
    sendResponse({ ok: false, error: "No accounts provided." });
    return false;
  }

  for (let i = 0; i < accounts.length; i++) {
    const err = validateAccountPayload(accounts[i], accounts.length > 1 ? `Account ${i + 1}` : "");
    if (err) {
      sendResponse({ ok: false, error: err });
      return false;
    }
  }

  // Respond immediately to avoid channel-close errors during navigation.
  sendResponse({ ok: true, message: "Automation started." });

  lastHomeRedirectAt = 0;

  const jobBase = {
    phase: "login",
    emailNextClickedAt: 0,
    landingSignInClickedAt: 0,
    createdAt: Date.now(),
  };

  // Always persist `accounts` + `currentIndex` so multi-account runs survive `setJob({ ...job })`
  // and `persistNextAccountJobAfterSignOut` (legacy single-object `account` jobs still work via getCurrentAccount).
  const job = {
    ...jobBase,
    accounts: accounts.map((a) => ({ ...a })),
    currentIndex: 0,
    requireStorefrontSignIn: false,
  };

  setJob(job)
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
  if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
  mutationDebounceTimer = setTimeout(() => {
    mutationDebounceTimer = null;
    processPendingJob().catch(() => {});
  }, MUTATION_DEBOUNCE_MS);
});
observer.observe(document.documentElement, { childList: true, subtree: true });
